'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encodeMessage, decodeMessage } = require('../osc');
const ufx = require('../ufx');

const SERVER = path.join(__dirname, '..', 'server.js');

function pad(str) {
  const raw = Buffer.from(str + '\0', 'utf8');
  const out = Buffer.alloc(Math.ceil(raw.length / 4) * 4);
  raw.copy(out);
  return out;
}
const oscString = (addr, s) => Buffer.concat([pad(addr), pad(',s'), pad(s)]);

async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return await fn(); } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function freeUdpPort() {
  return new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function freeTcpPort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// Arranca server.js con un config temporal y espera a que esté listo.
async function launch(args, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const proc = spawn(process.execPath, [SERVER, ...args], { env: { ...process.env, CONFIG: cfgPath } });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const stop = () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  try {
    await eventually(() => { if (!out.includes('Abrir desde')) throw new Error('aún no arranca'); }, 5000);
  } catch {
    stop();
    throw new Error(`El servidor no arrancó:\n${out}`);
  }
  return { port: cfg.port, stop, url: (p) => `http://127.0.0.1:${cfg.port}${p}` };
}

// Puente conectado a un TotalMix simulado (un socket UDP que recibe lo que enviamos).
async function startBridge() {
  const tm = dgram.createSocket('udp4');
  await new Promise((r) => tm.bind(0, '127.0.0.1', r));
  const received = [];
  tm.on('message', (b) => received.push(decodeMessage(b)));
  const listenPort = await freeUdpPort();
  const port = await freeTcpPort();
  const app = await launch([], {
    port, totalmix: { host: '127.0.0.1', port: tm.address().port, listenPort },
  }).catch((e) => { tm.close(); throw e; });
  const client = dgram.createSocket('udp4');
  const reply = (addr, arg) => new Promise((r) => client.send(
    typeof arg === 'string' ? oscString(addr, arg) : encodeMessage(addr, [arg]),
    listenPort, '127.0.0.1', r));
  const url = (p) => app.url(p);
  const get = async (p) => (await fetch(app.url(p))).json();
  const post = (p, body) => fetch(app.url(p), { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const last = (addr) => received.filter((m) => m.address === addr).at(-1);
  const stop = () => { app.stop(); tm.close(); client.close(); };
  try {
    await eventually(() => {
      if (!received.some((m) => m.address === '/sendall' && m.args[0] === 2)) throw new Error('falta /sendall 2');
    });
  } catch (e) { stop(); throw e; }
  return { received, reply, get, post, last, url, stop };
}

// Lo que respondería TotalMix: nombres, estéreo, principal, oculta, y faders activos.
const TOTALMIX_STATE = [
  ['/output/0/name', 'Batería'],
  ['/output/1/name', 'Voz'],
  ['/output/2/name', 'Oculta'], ['/output/2/color', 0],
  ['/output/4/name', 'Principal'],
  ['/controlroom/mainout', 4],
  ['/output/6/name', 'Bajo'], ['/output/6/stereo', 1],
  ['/output/7/name', 'Bajo D'],
  ['/input/0/name', 'MIC 1'], ['/input/1/name', 'MIC 2'], ['/input/2/name', 'PIANO'],
  ['/playback/0/name', 'Pista'], ['/playback/0/stereo', 1],
  ['/mix/in/0/0/faderlin', 0.5],
  ['/mix/pb/0/0/faderlin', 0.25],
  ['/mix/in/1/1/faderlin', 0.75],
  ['/mix/in/2/0/fader', -300],
  ['/level/in/0', -12.5],
];
async function feedTotalMix(b) {
  for (const [addr, arg] of TOTALMIX_STATE) await b.reply(addr, arg);
}

test('codifica un float OSC según la especificación', () => {
  const buf = encodeMessage('/1/volume1', [0.5]);
  assert.strictEqual(buf.length, 20);
  assert.deepStrictEqual([...buf.subarray(16)], [0x3f, 0x00, 0x00, 0x00]);
  assert.deepStrictEqual(decodeMessage(buf), { address: '/1/volume1', args: [0.5] });
});

test('decodifica argumentos s (UTF-8), i y f', () => {
  const int = Buffer.alloc(4); int.writeInt32BE(-7);
  const flt = Buffer.alloc(4); flt.writeFloatBE(0.5);
  const buf = Buffer.concat([pad('/x'), pad(',sif'), pad('Batería'), int, flt]);
  assert.deepStrictEqual(decodeMessage(buf), { address: '/x', args: ['Batería', -7, 0.5] });
});

test('nombres de canales UFX y curva oficial de fader', () => {
  assert.strictEqual(ufx.channelIndex('AN 1'), 0);
  assert.strictEqual(ufx.channelIndex('AN 9/10'), 8);
  assert.strictEqual(ufx.channelIndex('AN 12'), 11);
  assert.ok(Math.abs(ufx.faderToDb(1) - 6) < 0.01);
  assert.ok(Math.abs(ufx.faderToDb(ufx.dbToFader(-20)) + 20) < 0.01);
  assert.strictEqual(ufx.faderToDb(0), -Infinity);
});

test('arranque: pide /sendall y arma roles y faders desde lo que responde TotalMix', async () => {
  const b = await startBridge();
  try {
    await feedTotalMix(b);
    await eventually(async () => assert.deepStrictEqual(await b.get('/api/musicians'), [
      { id: 'o0', name: 'Batería', out: 'AN 1' },
      { id: 'o1', name: 'Voz', out: 'AN 2' },
      { id: 'o6', name: 'Bajo', out: 'AN 7/8' },
    ]));
    await eventually(async () => assert.deepStrictEqual(await b.get('/api/mix?m=o0'), {
      id: 'o0', name: 'Batería', out: 'AN 1',
      channels: [
        { key: 'in-0', label: 'MIC 1', sub: 'AN 1', value: 0.5, level: -12.5 },
        { key: 'pb-0', label: 'Pista', sub: 'DAW AN 1', value: 0.25, level: null },
      ],
    }));
    await eventually(() => {
      if (!b.received.some((m) => m.address === '/sendsubmix/0' && m.args[0] === 2)) throw new Error('falta sendsubmix');
    });
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/mix?m=o1')).channels, [
      { key: 'in-1', label: 'MIC 2', sub: 'AN 2', value: 0.75, level: null },
    ]));
  } finally { b.stop(); }
});

test('/api/set envía /mix/.../faderlin, recorta a 0..1 y el nodo queda listado al bajar a cero', async () => {
  const b = await startBridge();
  try {
    await feedTotalMix(b);
    await eventually(async () => assert.strictEqual((await b.get('/api/mix?m=o0')).channels.length, 2));

    assert.strictEqual((await b.post('/api/set', { m: 'o0', k: 'in-0', v: 0.9 })).status, 200);
    await eventually(() => assert.ok(Math.abs(b.last('/mix/in/0/0/faderlin').args[0] - 0.9) < 1e-6));

    await b.post('/api/set', { m: 'o0', k: 'pb-0', v: 2 });
    await eventually(() => assert.strictEqual(b.last('/mix/pb/0/0/faderlin').args[0], 1));

    await b.post('/api/set', { m: 'o0', k: 'in-0', v: 0 });
    await eventually(() => assert.strictEqual(b.last('/mix/in/0/0/faderlin').args[0], 0));
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/mix?m=o0')).channels[0],
      { key: 'in-0', label: 'MIC 1', sub: 'AN 1', value: 0, level: -12.5 }));

    // ráfaga: el último valor es el que queda
    for (const v of [0.1, 0.2, 0.3, 0.42]) await b.post('/api/set', { m: 'o1', k: 'in-1', v });
    await eventually(() => assert.ok(Math.abs(b.last('/mix/in/1/1/faderlin').args[0] - 0.42) < 1e-6));

    for (const body of [
      '{roto',
      JSON.stringify({ m: 'nope', k: 'in-0', v: 0.5 }),
      JSON.stringify({ m: 'o0', k: 'xx', v: 0.5 }),
      JSON.stringify({ m: 'o0', k: 'in-0', v: 'mucho' }),
    ]) {
      assert.strictEqual((await b.post('/api/set', body)).status, 400, body);
    }
  } finally { b.stop(); }
});

test('flujo en vivo (SSE) entrega el mismo rol que /api/mix', async () => {
  const b = await startBridge();
  try {
    await feedTotalMix(b);
    await eventually(async () => assert.strictEqual((await b.get('/api/mix?m=o0')).channels.length, 2));
    const res = await fetch(b.url('/api/stream?m=o0'));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (!text.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    await reader.cancel();
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    const data = JSON.parse(line.slice(6));
    assert.strictEqual(data.name, 'Batería');
    assert.strictEqual(data.out, 'AN 1');
    assert.deepStrictEqual(data.channels.map((c) => c.key), ['in-0', 'pb-0']);
  } finally { b.stop(); }
});

test('--dry-run: datos de ejemplo sin TotalMix', async () => {
  const app = await launch(['--dry-run'], {
    port: await freeTcpPort(), totalmix: { host: '127.0.0.1', port: 7001, listenPort: 9001 },
  });
  try {
    const roles = await (await fetch(app.url('/api/musicians'))).json();
    assert.deepStrictEqual(roles.map((r) => r.id), ['o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o8', 'o10']);
    assert.strictEqual(roles.find((r) => r.id === 'o8').name, 'DRUMMER');
    const mix = await (await fetch(app.url('/api/mix?m=o8'))).json();
    assert.deepStrictEqual(mix.channels.map((c) => c.key), ['in-0', 'in-1', 'in-2', 'in-5', 'in-9', 'pb-0', 'pb-2']);
  } finally { app.stop(); }
});
