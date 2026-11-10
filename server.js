'use strict';
// Puente celular -> TotalMix FX.
// Un solo programa habla con TotalMix por OSC y atiende a todos los celulares por HTTP.
//
// Modo "global" (TotalMix FX 2.1+, recomendado): cada fader es una sola orden
//   /mix/in/<entrada>/<salida>/faderlin  o  /mix/pb/<reproducción>/<salida>/faderlin
//   sin bancos ni cambiar de mezcla. TotalMix devuelve valores, nombres y niveles.
// Modo "classic" (TotalMix 1.x): setSubmix -> busInput/busPlayback -> /1/volumeN, en fila.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { encodeMessage, decodeMessage } = require('./osc');
const { channelIndex, channelLabel } = require('./ufx');

const DRY_RUN = process.argv.includes('--dry-run');
const LISTEN = process.argv.includes('--escuchar') || !!process.env.DEBUG_OSC;
const configPath = process.env.CONFIG
  || (fs.existsSync(path.join(__dirname, 'config.json'))
    ? path.join(__dirname, 'config.json')
    : path.join(__dirname, 'config.example.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const MODE = config.mode || 'global';

// ---- Configuración normalizada ----
const CLASSIC_BUS = { input: '/1/busInput', playback: '/1/busPlayback' };

function normalize(cfg) {
  const ids = new Set();
  return cfg.musicians.map((m) => {
    if (!m.id || ids.has(m.id)) throw new Error(`id vacío o repetido: ${m.id}`);
    ids.add(m.id);
    const r = { id: m.id, name: m.name, channels: [] };
    if (MODE === 'global') {
      r.out = channelIndex(m.output);
      r.outLabel = typeof m.output === 'string' ? m.output : channelLabel(r.out);
    } else {
      r.submix = m.submix;
      r.outLabel = m.output || `submix ${m.submix}`;
    }
    for (const c of m.channels) {
      if (MODE === 'global') {
        const kind = c.input !== undefined ? 'in' : c.playback !== undefined ? 'pb' : null;
        if (!kind) throw new Error(`En "${m.id}", el fader "${c.label}" necesita "input" o "playback"`);
        const src = kind === 'in' ? c.input : c.playback;
        r.channels.push({ label: c.label, kind, idx: channelIndex(src), src: String(src) });
      } else {
        if (!CLASSIC_BUS[c.bus]) throw new Error(`bus inválido en ${m.id}: ${c.bus}`);
        if (!(c.fader >= 1 && c.fader <= 16)) throw new Error(`fader fuera de 1..16 en ${m.id}`);
        r.channels.push({ label: c.label, bus: c.bus, fader: c.fader, src: `${c.bus} ${c.fader}` });
      }
    }
    return r;
  });
}
const roles = normalize(config);

// ---- Estado que llega de TotalMix ----
const values = {};   // "in|9|0" -> 0..1 (posición del fader)
const levels = {};   // "in|9"   -> dB pico
const names = {};    // "output|0" -> nombre en TotalMix
const nodeKey = (kind, idx, out) => `${kind}|${idx}|${out}`;

function onOsc({ address, args }) {
  if (LISTEN) console.log('<-', address, args.join(' '));
  const p = address.split('/');
  // /mix/in/9/0/faderlin
  if (p[1] === 'mix' && p.length === 6 && p[5] === 'faderlin') {
    values[nodeKey(p[2], Number(p[3]), Number(p[4]))] = Number(args[0]);
  } else if (p[1] === 'level' && p.length === 4) {
    levels[`${p[2]}|${Number(p[3])}`] = Number(args[0]);
  } else if (['input', 'playback', 'output'].includes(p[1]) && p[3] === 'name' && typeof args[0] === 'string') {
    names[`${p[1]}|${Number(p[2])}`] = args[0];
  }
}

// ---- OSC ----
const sock = dgram.createSocket('udp4');
sock.on('message', (buf) => { try { onOsc(decodeMessage(buf)); } catch {} });

function send(address, value) {
  if (DRY_RUN) { console.log('->', address, value); return Promise.resolve(); }
  const msg = encodeMessage(address, [value]);
  return new Promise((res, rej) =>
    sock.send(msg, config.totalmix.port, config.totalmix.host, (e) => (e ? rej(e) : res())));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pide a TotalMix el estado de lo que usamos: nombres y posiciones actuales.
async function requestState() {
  const outs = new Set(), ins = new Set(), pbs = new Set();
  for (const r of roles) {
    outs.add(r.out);
    for (const c of r.channels) (c.kind === 'in' ? ins : pbs).add(c.idx);
  }
  for (const o of outs) { await send(`/sendchan/output/${o}`, 1); await send(`/sendsubmix/${o}`, 1); await sleep(5); }
  for (const i of ins) { await send(`/sendchan/input/${i}`, 1); await sleep(5); }
  for (const i of pbs) { await send(`/sendchan/playback/${i}`, 1); await sleep(5); }
}

// ---- Fila de órdenes (agrupa movimientos repetidos del mismo fader) ----
const pending = new Map(); // "rol|canal" -> valor más reciente
let running = false;

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.size) {
      const [key, value] = pending.entries().next().value;
      pending.delete(key);
      const [rid, i] = key.split('|');
      const r = roles.find((x) => x.id === rid);
      const c = r.channels[Number(i)];
      const gap = config.totalmix.gapMs ?? (MODE === 'global' ? 2 : 15);
      if (MODE === 'global') {
        await send(`/mix/${c.kind}/${c.idx}/${r.out}/faderlin`, value); await sleep(gap);
      } else {
        await send('/setSubmix', r.submix); await sleep(gap);
        await send(CLASSIC_BUS[c.bus], 1); await sleep(gap);
        await send(`/1/volume${c.fader}`, value); await sleep(gap);
      }
    }
  } catch (e) {
    console.error('Error enviando OSC:', e.message);
  } finally {
    running = false;
  }
}

const classicValues = {}; // en modo clásico TotalMix no devuelve valores: guardamos lo enviado
function setFader(rid, i, value) {
  const r = roles.find((x) => x.id === rid);
  const c = r.channels[i];
  if (MODE === 'global') values[nodeKey(c.kind, c.idx, r.out)] = value;
  else classicValues[`${rid}|${i}`] = value;
  const key = `${rid}|${i}`;
  pending.delete(key);
  pending.set(key, value);
  drain();
}

// ---- Vista para el celular ----
function displayName(r) {
  const tm = MODE === 'global' && config.useTotalMixNames ? names[`output|${r.out}`] : null;
  return tm && tm.trim() ? tm.trim() : r.name;
}
function mixView(r) {
  return {
    id: r.id, name: displayName(r), out: r.outLabel,
    channels: r.channels.map((c, i) => {
      const v = MODE === 'global' ? values[nodeKey(c.kind, c.idx, r.out)] : classicValues[`${r.id}|${i}`];
      const lv = MODE === 'global' ? levels[`${c.kind}|${c.idx}`] : undefined;
      return { label: c.label, sub: c.src, value: v ?? null, level: lv ?? null };
    }),
  };
}

// ---- HTTP ----
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/musicians') {
    return json(res, 200, roles.map((r) => ({ id: r.id, name: displayName(r), out: r.outLabel })));
  }
  if (req.method === 'GET' && url.pathname === '/api/mix') {
    const r = roles.find((x) => x.id === url.searchParams.get('m'));
    if (!r) return json(res, 404, { error: 'rol no encontrado' });
    return json(res, 200, mixView(r));
  }
  // Flujo en vivo (valores y niveles) para la pantalla del músico.
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const r = roles.find((x) => x.id === url.searchParams.get('m'));
    if (!r) return json(res, 404, { error: 'rol no encontrado' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let last = '';
    const t = setInterval(() => {
      const v = mixView(r);
      const msg = JSON.stringify({ name: v.name, values: v.channels.map((c) => c.value), levels: v.channels.map((c) => c.level) });
      if (msg !== last) { res.write(`data: ${msg}\n\n`); last = msg; }
    }, 80);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/set') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'JSON inválido' }); }
      const r = roles.find((x) => x.id === p.m);
      const i = Number(p.c);
      const v = Number(p.v);
      if (!r || !r.channels[i] || !Number.isFinite(v)) return json(res, 400, { error: 'datos inválidos' });
      setFader(r.id, i, Math.min(1, Math.max(0, v)));
      json(res, 200, { ok: true });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'public', 'app.js')).pipe(res);
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }
  res.writeHead(404); res.end();
});

if (require.main === module) {
  sock.bind(config.totalmix.listenPort || 0, () => {
    console.log(`Escuchando a TotalMix en el puerto ${sock.address().port}${LISTEN ? ' (mostrando mensajes)' : ''}`);
    if (MODE === 'global' && !DRY_RUN) requestState().catch((e) => console.error('No pude pedir el estado:', e.message));
  });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Config: ${path.basename(configPath)} · modo ${MODE}${DRY_RUN ? ' · PRUEBA: no envía a TotalMix' : ''}`);
    console.log(`TotalMix OSC: ${config.totalmix.host}:${config.totalmix.port}`);
    console.log('Abrir desde el celular (misma WiFi):');
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${config.port}`);
    }
  });
}

module.exports = { server, roles, onOsc, values, names };
