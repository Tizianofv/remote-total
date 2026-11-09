'use strict';
// Puente celular -> TotalMix FX.
// Un solo programa ocupa UNA de las 4 ranuras OSC de TotalMix y atiende a
// todos los celulares por HTTP. Las órdenes se ponen en fila y se envían de a
// una: elegir mezcla (setSubmix) -> elegir fila (busInput/busPlayback) -> fader.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { encodeMessage, decodeMessage } = require('./osc');

const DRY_RUN = process.argv.includes('--dry-run');
const configPath = process.env.CONFIG
  || (fs.existsSync(path.join(__dirname, 'config.json'))
  ? path.join(__dirname, 'config.json')
  : path.join(__dirname, 'config.example.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const BUS_ADDR = { input: '/1/busInput', playback: '/1/busPlayback' };

function validateConfig(cfg) {
  const ids = new Set();
  for (const m of cfg.musicians) {
    if (ids.has(m.id)) throw new Error(`id repetido: ${m.id}`);
    ids.add(m.id);
    for (const c of m.channels) {
      if (!BUS_ADDR[c.bus]) throw new Error(`bus inválido en ${m.id}: ${c.bus}`);
      if (!(c.fader >= 1 && c.fader <= 8)) throw new Error(`fader fuera de 1..8 en ${m.id}`);
    }
  }
}
validateConfig(config);

// ---- Envío OSC ----
const sock = dgram.createSocket('udp4');
sock.on('message', (buf) => {
  if (process.env.DEBUG_OSC) {
    try { const m = decodeMessage(buf); console.log('<-', m.address, m.args.join(' ')); } catch {}
  }
});

function send(address, value) {
  if (DRY_RUN) { console.log('->', address, value); return Promise.resolve(); }
  const msg = encodeMessage(address, [value]);
  return new Promise((res, rej) =>
    sock.send(msg, config.totalmix.port, config.totalmix.host, (e) => (e ? rej(e) : res())));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Fila de órdenes (agrupa movimientos repetidos del mismo fader) ----
const pending = new Map(); // "musico|canal" -> valor más reciente
let running = false;
const state = {}; // valores actuales para que el celular los vea al recargar

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.size) {
      const [key, value] = pending.entries().next().value;
      pending.delete(key);
      const [mid, idx] = key.split('|');
      const m = config.musicians.find((x) => x.id === mid);
      const ch = m.channels[Number(idx)];
      const gap = config.totalmix.gapMs ?? 15;
      await send('/setSubmix', m.submix); await sleep(gap);
      await send(BUS_ADDR[ch.bus], 1); await sleep(gap);
      await send(`/1/volume${ch.fader}`, value); await sleep(gap);
    }
  } catch (e) {
    console.error('Error enviando OSC:', e.message);
  } finally {
    running = false;
  }
}

function enqueue(mid, idx, value) {
  const key = `${mid}|${idx}`;
  pending.delete(key); // reinsertar al final con el valor nuevo
  pending.set(key, value);
  (state[mid] ||= {})[idx] = value;
  drain();
}

// ---- HTTP ----
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/musicians') {
    return json(res, 200, config.musicians.map((m) => ({ id: m.id, name: m.name })));
  }
  if (req.method === 'GET' && url.pathname === '/api/mix') {
    const m = config.musicians.find((x) => x.id === url.searchParams.get('m'));
    if (!m) return json(res, 404, { error: 'músico no encontrado' });
    return json(res, 200, {
      id: m.id, name: m.name,
      channels: m.channels.map((c, i) => ({ label: c.label, value: state[m.id]?.[i] ?? null })),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/set') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'JSON inválido' }); }
      const m = config.musicians.find((x) => x.id === p.m);
      const idx = Number(p.c);
      const v = Number(p.v);
      if (!m || !m.channels[idx] || !Number.isFinite(v)) return json(res, 400, { error: 'datos inválidos' });
      enqueue(m.id, idx, Math.min(1, Math.max(0, v)));
      json(res, 200, { ok: true });
    });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }
  res.writeHead(404); res.end();
});

if (require.main === module) {
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Config: ${path.basename(configPath)}${DRY_RUN ? '  (modo prueba: no envía a TotalMix)' : ''}`);
    console.log(`TotalMix OSC: ${config.totalmix.host}:${config.totalmix.port}`);
    console.log('Abrir desde el celular (misma WiFi):');
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const a of ifs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${config.port}`);
    }
  });
}

module.exports = { server, enqueue, config, pending };
