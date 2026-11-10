'use strict';
// Puente celular -> RME TotalMix FX 2.1 por Global OSC. Cero configuración de músicos:
// TotalMix envía sus nombres y su mezcla al arrancar (/sendall 2) y de ahí salen los roles y los faders.
//  - Rol: cada salida con nombre, salvo la principal (/controlroom/mainout), las ocultas (color 0)
//    y la pareja derecha de una salida estéreo.
//  - Fader: cada entrada o reproducción que el ingeniero envió a esa salida (activa = fader > -65 dB).
//    Una vez activa desde el arranque, sigue en la lista aunque el músico la baje a cero.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { encodeMessage, decodePackets } = require('./osc');
const { channelLabel, dbToFader } = require('./ufx');

const DRY_RUN = process.argv.includes('--dry-run');
const LISTEN = process.argv.includes('--escuchar') || !!process.env.DEBUG_OSC;
const GAP_MS = 2; // pausa entre órdenes a TotalMix

// ---- Configuración opcional: solo puerto y TotalMix ----
function loadConfig() {
  const file = process.env.CONFIG || path.join(__dirname, 'config.json');
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  else if (process.env.CONFIG) throw new Error(`No existe el archivo CONFIG: ${file}`);
  return {
    port: user.port ?? 8080,
    totalmix: { host: '127.0.0.1', port: 7001, listenPort: 9001, ...user.totalmix },
  };
}
const config = loadConfig();

// ---- Lo que TotalMix nos dice ----
// ch.output / ch.input / ch.playback: por número de canal (desde 0).
const ch = { output: {}, input: {}, playback: {} };
const info = (type, n) => (ch[type][n] ||= {});
const hidden = (type, n) => ch[type][n]?.color === 0;
const stereoRight = (type, n) => n % 2 === 1 && ch[type][n - 1]?.stereo === true;
const TYPE = { in: 'input', pb: 'playback' };
// Nombre de fábrica = etiqueta de hardware (AN 4, AN 7/8, PH 9/10, AES, ADAT 3, ADAT 1/2, AN L/R...).
// Sin distinguir mayúsculas. "Analog Synth", "PHIL", "ADATA" y "Voz 2" no son de fábrica.
const FABRICA = /^(AN|PH|AES|ADAT)(\s*(\d+(\s*\/\s*\d+)?|L(\s*\/\s*R)?|R))?$/i;
// Un canal solo aparece en el celular si tiene nombre puesto por el ingeniero.
const conNombre = (type, n) => { const name = ch[type][n]?.name; return !!name && !FABRICA.test(name); };

let mainOut = null;
const fader = {};                 // "in|3|8" -> faderlin 0..1
const level = {};                 // "in|3" -> pico dB
const outFader = {};              // 8 -> faderlin 0..1 de la salida 8 (el fader del rol)
const outLevel = {};              // 8 -> pico dB de la salida 8
const everActive = new Map();     // "in|3|8" -> {kind, idx, out}: activas desde el arranque
const nodeKey = (kind, idx, out) => `${kind}|${idx}|${out}`;

function setNode(kind, idx, out, lin) {
  const key = nodeKey(kind, idx, out);
  fader[key] = lin;
  if (lin > 0) everActive.set(key, { kind, idx, out });
}

function onOsc({ address, args }) {
  if (LISTEN) console.log('<-', address, args.join(' '));
  const p = address.split('/').slice(1); // "/mix/in/3/8/faderlin" -> ['mix','in','3','8','faderlin']
  const v = args[0];
  if (p[0] === 'controlroom' && p[1] === 'mainout' && typeof v === 'number') { mainOut = Math.round(v); return; }
  if (p[0] === 'mix' && (p[1] === 'in' || p[1] === 'pb') && p.length === 5) {
    const idx = Number(p[2]), out = Number(p[3]);
    if (!Number.isInteger(idx) || !Number.isInteger(out) || typeof v !== 'number') return;
    if (p[4] === 'faderlin') setNode(p[1], idx, out, Math.min(1, Math.max(0, v)));
    else if (p[4] === 'fader') setNode(p[1], idx, out, v < -64.9 ? 0 : dbToFader(v));
    return;
  }
  if (p[0] === 'level' && (p[1] === 'in' || p[1] === 'pb') && p.length === 3 && typeof v === 'number') {
    level[`${p[1]}|${Number(p[2])}`] = v;
    return;
  }
  // Fader y medidor de la salida (el fader del rol). /output/<n>/faderlin y /level/out/<n>.
  if (p[0] === 'output' && p.length === 3 && p[2] === 'faderlin' && typeof v === 'number') {
    const n = Number(p[1]);
    if (Number.isInteger(n) && n >= 0) outFader[n] = Math.min(1, Math.max(0, v));
    return;
  }
  if (p[0] === 'level' && p[1] === 'out' && p.length === 3 && typeof v === 'number') {
    const n = Number(p[2]);
    if (Number.isInteger(n) && n >= 0) outLevel[n] = v;
    return;
  }
  if (['input', 'output', 'playback'].includes(p[0]) && p.length === 3) {
    const n = Number(p[1]);
    if (!Number.isInteger(n) || n < 0) return;
    const c = info(p[0], n);
    if (p[2] === 'name' && typeof v === 'string') { c.named = true; c.name = v.trim(); }
    else if (p[2] === 'stereo' && typeof v === 'number') c.stereo = v === 1;
    else if (p[2] === 'color' && typeof v === 'number') c.color = v;
  }
}

// ---- Etiquetas ----
function pairLabel(n, type) {
  const a = channelLabel(n, type), b = channelLabel(n + 1, type);
  const [pa, ...ra] = a.split(' '), [pb, ...rb] = b.split(' ');
  return pa === pb ? `${a}/${rb.join(' ')}` : `${a}/${b}`; // "PH 9/10", "AN 1/2", "AES L/R"
}
const outLabel = (n) => (ch.output[n]?.stereo ? pairLabel(n, 'output') : channelLabel(n, 'output'));

// ---- Roles: salidas con nombre, sin principal, sin ocultas ni parejas derechas ----
function roles() {
  const list = [];
  for (const n of Object.keys(ch.output).map(Number).sort((a, b) => a - b)) {
    if (!conNombre('output', n)) continue;
    if (n === mainOut || (mainOut !== null && n === mainOut + 1 && ch.output[mainOut]?.stereo)) continue;
    if (hidden('output', n) || stereoRight('output', n)) continue;
    list.push({ n, id: `o${n}`, name: ch.output[n].name, out: outLabel(n) });
  }
  return list;
}
const findRole = (id) => roles().find((r) => r.id === id);

// ---- Faders de un rol: entradas y reproducciones activas en esa salida ----
function mixView(role) {
  const nodes = [...everActive.values()]
    .filter((x) => x.out === role.n)
    .sort((a, b) => (a.kind === b.kind ? a.idx - b.idx : a.kind === 'in' ? -1 : 1));
  const channels = [];
  for (const { kind, idx } of nodes) {
    const type = TYPE[kind];
    if (hidden(type, idx) || stereoRight(type, idx) || !conNombre(type, idx)) continue;
    const sub = (kind === 'pb' ? 'DAW ' : '') + channelLabel(idx, type);
    channels.push({
      key: `${kind}-${idx}`,
      label: ch[type][idx].name,
      sub,
      value: fader[nodeKey(kind, idx, role.n)] ?? null,
      level: level[`${kind}|${idx}`] ?? null,
    });
  }
  // Fader de la salida del rol: su etiqueta de hardware sale de role.out (ej. "PH 9/10").
  const master = { key: 'out', label: role.name, sub: role.out, value: outFader[role.n] ?? null, level: outLevel[role.n] ?? null };
  return { id: role.id, name: role.name, out: role.out, master, channels };
}

// ---- OSC hacia TotalMix ----
const sock = dgram.createSocket('udp4');
sock.on('message', (buf) => {
  for (const m of decodePackets(buf)) { try { onOsc(m); } catch {} }
});
sock.on('error', (e) => { console.error('Error en el puerto OSC:', e.message); process.exit(1); });

function send(address, value) {
  if (DRY_RUN) { console.log('->', address, value); return Promise.resolve(); }
  return new Promise((res, rej) =>
    sock.send(encodeMessage(address, [value]), config.totalmix.port, config.totalmix.host, (e) => (e ? rej(e) : res())));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cola de faders: si un fader se mueve muchas veces, solo sale el último valor.
const pending = new Map(); // "in|3|8" o "out|8" -> {addr, v} más reciente
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.size) {
      const [key, { addr, v }] = pending.entries().next().value;
      pending.delete(key);
      await send(addr, v);
      await sleep(GAP_MS);
    }
  } catch (e) {
    console.error('Error enviando OSC:', e.message);
  } finally {
    draining = false;
  }
}

function setFader(role, kind, idx, v) {
  const key = nodeKey(kind, idx, role.n);
  setNode(kind, idx, role.n, v);
  pending.delete(key);
  pending.set(key, { addr: `/mix/${kind}/${idx}/${role.n}/faderlin`, v });
  drain();
}

// Fader de la salida del rol: siempre la salida de ese rol (role.n), nunca otro número.
function setOutFader(role, v) {
  outFader[role.n] = v;
  const key = `out|${role.n}`;
  pending.delete(key);
  pending.set(key, { addr: `/output/${role.n}/faderlin`, v });
  drain();
}

// ---- HTTP ----
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/musicians') {
    return json(res, 200, roles().map((r) => ({ id: r.id, name: r.name, out: r.out })));
  }
  if (req.method === 'GET' && url.pathname === '/api/mix') {
    const role = findRole(url.searchParams.get('m'));
    if (!role) return json(res, 404, { error: 'rol no encontrado' });
    send(`/sendsubmix/${role.n}`, 2).catch(() => {});
    return json(res, 200, mixView(role));
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const id = url.searchParams.get('m');
    if (!findRole(id)) return json(res, 404, { error: 'rol no encontrado' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let last = '';
    const t = setInterval(() => {
      // El rol se busca en cada tick: si TotalMix renombra la salida, el flujo sigue su nombre actual.
      const role = findRole(id);
      if (!role) { // ya no es un rol (nombre de fábrica, principal u oculta): se avisa y se cierra
        res.write('event: gone\ndata: {}\n\n');
        clearInterval(t); res.end();
        return;
      }
      const msg = JSON.stringify(mixView(role));
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
      const role = findRole(p?.m);
      const m = typeof p?.k === 'string' ? /^(in|pb)-(\d+)$/.exec(p.k) : null;
      const isOut = p?.k === 'out';
      if (!role || (!m && !isOut) || typeof p.v !== 'number' || !Number.isFinite(p.v)) {
        return json(res, 400, { error: 'datos inválidos' });
      }
      if (isOut) {
        setOutFader(role, Math.min(1, Math.max(0, p.v)));
        return json(res, 200, { ok: true });
      }
      const idx = Number(m[2]);
      if (hidden(TYPE[m[1]], idx) || stereoRight(TYPE[m[1]], idx) || !conNombre(TYPE[m[1]], idx)) {
        return json(res, 400, { error: 'canal no disponible' });
      }
      setFader(role, m[1], idx, Math.min(1, Math.max(0, p.v)));
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

// ---- Datos de ejemplo (--dry-run): la página se puede probar sin TotalMix ----
function seedDemo() {
  const put = (address, ...args) => onOsc({ address, args });
  ['Piano', 'Cantante', 'Guitarra', 'Bajo', 'Coros', 'Retorno'].forEach((s, n) => put(`/output/${n}/name`, s));
  put('/output/6/name', 'Sala'); put('/output/6/stereo', 1);
  put('/output/8/name', 'DRUMMER'); put('/output/8/stereo', 1);
  put('/output/10/name', 'Bassist'); put('/output/10/stereo', 1);
  put('/controlroom/mainout', 6);
  ['MIC 1', 'MIC 2', 'MIC 3', 'MIC 4', 'PIANO', 'DI', 'ROOM', 'AN 8', 'Talk', 'Voz 2', 'Voz 3', 'GTR Acus']
    .forEach((s, n) => put(`/input/${n}/name`, s));
  put('/playback/0/name', 'Pista'); put('/playback/0/stereo', 1);
  put('/playback/2/name', 'Click'); put('/playback/2/stereo', 1);
  const active = {
    8: { in: [0, 1, 2, 5, 9], pb: [0, 2] },  // DRUMMER
    0: { in: [9, 10, 0], pb: [0, 2] },       // AN 1
    1: { in: [9, 10], pb: [0] },
    2: { in: [11, 0], pb: [2] },
    3: { in: [7, 11] },
    4: { in: [1, 4] },
    5: { in: [3, 5], pb: [0] },
    10: { in: [5, 9, 0], pb: [0, 2] },       // Bassist
  };
  for (const [out, kinds] of Object.entries(active)) {
    for (const [kind, list] of Object.entries(kinds)) {
      for (const idx of list) setNode(kind, idx, Number(out), 0.6 + Math.random() * 0.2);
    }
  }
  // Fader y medidor de la salida de cada rol de ejemplo.
  for (const n of [0, 1, 2, 3, 4, 5, 8, 10]) {
    put(`/output/${n}/faderlin`, 0.7 + (n % 3) * 0.05);
    put(`/level/out/${n}`, -20 - n);
  }
  // Medidores que se mueven: caminata aleatoria en los canales activos.
  setInterval(() => {
    for (const { kind, idx } of everActive.values()) {
      const k = `${kind}|${idx}`;
      level[k] = Math.min(-3, Math.max(-60, (level[k] ?? -30) + (Math.random() - 0.5) * 6));
    }
  }, 100).unref();
}

if (require.main === module) {
  if (DRY_RUN) {
    seedDemo();
  } else {
    sock.bind(config.totalmix.listenPort, () => {
      console.log(`Escuchando a TotalMix en el puerto ${sock.address().port}${LISTEN ? ' (mostrando mensajes)' : ''}`);
      send('/sendall', 2).catch((e) => console.error('No pude pedir el estado a TotalMix:', e.message));
    });
  }
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Puente${DRY_RUN ? ' · PRUEBA: datos de ejemplo, no envía a TotalMix' : ''}`);
    console.log(`TotalMix OSC: ${config.totalmix.host}:${config.totalmix.port}`);
    console.log('Abrir desde el celular (misma WiFi):');
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${config.port}`);
    }
  });
}

module.exports = { server, roles, mixView, onOsc };
