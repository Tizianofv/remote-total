'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encodeMessage, decodeMessage, decodePackets } = require('../osc');
const ufx = require('../ufx');

const SERVER = path.join(__dirname, '..', 'server.js');

function pad(str) {
  const raw = Buffer.from(str + '\0', 'utf8');
  const out = Buffer.alloc(Math.ceil(raw.length / 4) * 4);
  raw.copy(out);
  return out;
}
const oscString = (addr, s) => Buffer.concat([pad(addr), pad(',s'), pad(s)]);
const message = (addr, arg) => (typeof arg === 'string' ? oscString(addr, arg) : encodeMessage(addr, [arg]));

// Bundle OSC como lo envía TotalMix: "#bundle\0", timetag y elementos [int32 tamaño][contenido].
const BUNDLE_HEADER = Buffer.concat([pad('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
const element = (content, extra = 0) => {
  const size = Buffer.alloc(4);
  size.writeInt32BE(content.length + extra);
  return Buffer.concat([size, content]);
};
const bundle = (...contents) => Buffer.concat([BUNDLE_HEADER, ...contents.map((c) => element(c))]);

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
  // Todo llega como paquete UDP con bundle, igual que TotalMix real.
  const raw = (buf) => new Promise((r) => client.send(buf, listenPort, '127.0.0.1', r));
  const reply = (addr, arg) => raw(bundle(message(addr, arg)));
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
  return { received, reply, raw, get, post, last, url, stop };
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

test('paquete con bundle: entrega todos los mensajes en orden', () => {
  const pkt = bundle(message('/a', 1), message('/b', 'x'), message('/c', 0.5));
  assert.deepStrictEqual(decodePackets(pkt), [
    { address: '/a', args: [1] }, { address: '/b', args: ['x'] }, { address: '/c', args: [0.5] },
  ]);
});

test('bundle anidado: entrega los mensajes de dentro y de los bundles hijos', () => {
  const inner = bundle(message('/in/1', 2));
  const pkt = bundle(message('/top', 1), inner, message('/last', 3));
  assert.deepStrictEqual(decodePackets(pkt).map((m) => m.address), ['/top', '/in/1', '/last']);
});

test('bundle con elemento truncado: conserva los anteriores y no entrega el truncado', () => {
  const pkt = Buffer.concat([BUNDLE_HEADER, element(message('/ok', 1)), element(message('/bad', 2), 8)]);
  assert.deepStrictEqual(decodePackets(pkt), [{ address: '/ok', args: [1] }]);
});

test('elemento con contenido roto se salta y los siguientes siguen', () => {
  const broken = Buffer.concat([pad('/x'), pad(',f')]); // float que falta
  const pkt = Buffer.concat([BUNDLE_HEADER, element(message('/a', 1)), element(broken), element(message('/b', 2))]);
  assert.deepStrictEqual(decodePackets(pkt).map((m) => m.address), ['/a', '/b']);
});

test('paquete basura no lanza y no entrega nada', () => {
  assert.deepStrictEqual(decodePackets(Buffer.from([1, 2, 3])), []);
  assert.deepStrictEqual(decodePackets(Buffer.from('#bundle\0', 'ascii')), []);
});

test('mensaje suelto (sin bundle) sigue leyéndose', () => {
  assert.deepStrictEqual(decodePackets(message('/x', 0.25)), [{ address: '/x', args: [0.25] }]);
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
      master: { key: 'out', label: 'Batería', sub: 'AN 1', value: null, level: null },
      channels: [
        { key: 'in-0', label: 'MIC 1', sub: 'AN 1', value: 0.5, level: -12.5 },
        { key: 'in-1', label: 'MIC 2', sub: 'AN 2', value: null, level: null },
        { key: 'in-2', label: 'PIANO', sub: 'AN 3', value: 0, level: null },
        { key: 'pb-0', label: 'Pista', sub: 'DAW AN 1', value: 0.25, level: null },
      ],
    }));
    await eventually(() => {
      if (!b.received.some((m) => m.address === '/sendsubmix/0' && m.args[0] === 2)) throw new Error('falta sendsubmix');
    });
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/mix?m=o1')).channels, [
      { key: 'in-0', label: 'MIC 1', sub: 'AN 1', value: null, level: -12.5 },
      { key: 'in-1', label: 'MIC 2', sub: 'AN 2', value: 0.75, level: null },
      { key: 'in-2', label: 'PIANO', sub: 'AN 3', value: null, level: null },
      { key: 'pb-0', label: 'Pista', sub: 'DAW AN 1', value: null, level: null },
    ]));
  } finally { b.stop(); }
});

test('/api/set envía /mix/.../faderlin, recorta a 0..1 y el nodo queda listado al bajar a cero', async () => {
  const b = await startBridge();
  try {
    await feedTotalMix(b);
    await eventually(async () => assert.strictEqual((await b.get('/api/mix?m=o0')).channels.length, 4));

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
    await eventually(async () => assert.strictEqual((await b.get('/api/mix?m=o0')).channels.length, 4));
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
    assert.deepStrictEqual(data.channels.map((c) => c.key), ['in-0', 'in-1', 'in-2', 'pb-0']);
  } finally { b.stop(); }
});

test('servidor: procesa todos los mensajes de un bundle y sobrevive a paquetes rotos', async () => {
  const b = await startBridge();
  try {
    await b.raw(bundle(
      message('/output/0/name', 'Piano'), message('/output/1/name', 'Cantante'),
      message('/controlroom/mainout', 9),
    ));
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/musicians')).map((r) => r.name), ['Piano', 'Cantante']));

    // bundle anidado con un elemento truncado (declara 8 bytes de más): lo anterior cuenta, lo truncado no
    await b.raw(Buffer.concat([
      BUNDLE_HEADER,
      element(bundle(message('/output/2/name', 'Guitarra'))),
      element(message('/output/3/name', 'Fantasma'), 8),
    ]));
    await eventually(async () => assert.ok((await b.get('/api/musicians')).some((r) => r.name === 'Guitarra')));
    assert.ok(!(await b.get('/api/musicians')).some((r) => r.name === 'Fantasma'));

    await b.raw(Buffer.from([9, 9, 9, 9, 9]));
    await b.raw(Buffer.from('#bundle\0', 'ascii'));
    assert.strictEqual((await fetch(b.url('/api/musicians'))).status, 200);
  } finally { b.stop(); }
});

// Convierte captura-real.txt (líneas "/dirección f:valor" o 's:"texto"') en paquetes con bundles.
function capturaComoPaquetes(file) {
  const msgs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    const m = /^(\S+) (f|s):(.*)$/.exec(line);
    assert.ok(m, `línea no reconocida: ${line}`);
    return m[2] === 'f' ? message(m[1], Number(m[3])) : message(m[1], m[3].slice(1, -1));
  });
  const paquetes = [];
  for (let i = 0; i < msgs.length; i += 10) paquetes.push(bundle(...msgs.slice(i, i + 10)));
  return paquetes;
}
const CAPTURA = path.join(__dirname, 'fixtures', 'captura-real.txt');

test('captura real de TotalMix: roles exactos y la mezcla de DRUMMER sin nombres de fábrica', async () => {
  const b = await startBridge();
  try {
    for (const p of capturaComoPaquetes(CAPTURA)) await b.raw(p);
    await eventually(async () => {
      assert.deepStrictEqual(await b.get('/api/musicians'), [
        { id: 'o0', name: 'Piano', out: 'AN 1' },
        { id: 'o1', name: 'Cantante', out: 'AN 2' },
        { id: 'o2', name: 'Guitarra', out: 'AN 3' },
        { id: 'o8', name: 'DRUMMER', out: 'PH 9/10' },
        { id: 'o10', name: 'Bassist', out: 'PH 11/12' },
      ]);
      const mix = await b.get('/api/mix?m=o8');
      assert.deepStrictEqual(mix.channels.map((c) => [c.key, c.label, c.sub]), [
        ['in-0', 'MIC 1', 'AN 1'], ['in-1', 'MIC 2', 'AN 2'], ['in-2', 'MIC 3', 'AN 3'], ['in-3', 'MIC 4', 'AN 4'],
        ['in-4', 'PIANO', 'AN 5'], ['in-5', 'DI', 'AN 6'], ['in-6', 'ROOM', 'AN 7'],
        ['in-8', 'Talk', 'AN 9'], ['in-9', 'Voz 2', 'AN 10'],
        ['in-10', 'Voz 3', 'AN 11'], ['in-11', 'GTR Acus', 'AN 12'],
      ]);
    });
    // Ningún fader con nombre de fábrica (la reproducción AN/ADAT de DRUMMER queda fuera).
    const mix = await b.get('/api/mix?m=o8');
    for (const c of mix.channels) assert.ok(!/^(AN|PH|AES|ADAT)/i.test(c.label), c.label);
  } finally { b.stop(); }
});

test('etiqueta de hardware por tipo: salidas y reproducciones 9-12 son PH, entradas siguen AN', () => {
  for (const i of [8, 9, 10, 11]) {
    assert.strictEqual(ufx.channelLabel(i, 'output'), `PH ${i + 1}`);
    assert.strictEqual(ufx.channelLabel(i, 'playback'), `PH ${i + 1}`);
    assert.strictEqual(ufx.channelLabel(i, 'input'), `AN ${i + 1}`);
  }
  for (const i of [0, 7]) assert.strictEqual(ufx.channelLabel(i, 'output'), `AN ${i + 1}`);
  assert.strictEqual(ufx.channelLabel(12, 'output'), 'AES L');
  assert.strictEqual(ufx.channelLabel(14, 'playback'), 'ADAT 1');
});

test('fader de reproducción 9-12 lleva sub "DAW PH 9" (no AN)', async () => {
  const b = await startBridge();
  try {
    await b.raw(bundle(message('/output/8/name', 'DRUMMER'), message('/output/8/stereo', 1)));
    await b.raw(bundle(message('/playback/8/name', 'Click'), message('/mix/pb/8/8/faderlin', 0.5)));
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/mix?m=o8')).channels,
      [{ key: 'pb-8', label: 'Click', sub: 'DAW PH 9', value: 0.5, level: null }]));
  } finally { b.stop(); }
});

test('nombre de fábrica: salidas, entradas y reproducciones con nombres inventados', async () => {
  const b = await startBridge();
  try {
    const outs = ['Analog Synth', 'PHIL', 'ADATA', 'Voz 2', 'AN', 'ph 9/10', 'aes', 'Adat 3/4'];
    const ins = ['AN 8', 'Analog Synth', 'PHIL', 'ADATA', 'Voz 2', 'AES L/R', 'ADAT 15/16', 'PH 9/10'];
    for (const [i, s] of outs.entries()) await b.raw(bundle(message(`/output/${i}/name`, s)));
    await b.raw(bundle(message('/output/5/stereo', 1)));
    for (const [i, s] of ins.entries()) await b.raw(bundle(message(`/input/${i}/name`, s)));
    await b.raw(bundle(message('/input/8/stereo', 0))); // entrada 8 sin nombre
    for (let i = 0; i <= 9; i++) await b.raw(bundle(message(`/mix/in/${i}/0/faderlin`, 0.5)));
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/musicians')).map((r) => r.name),
      ['Analog Synth', 'PHIL', 'ADATA', 'Voz 2']));
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/mix?m=o0')).channels.map((c) => c.label),
      ['Analog Synth', 'PHIL', 'ADATA', 'Voz 2']));
    // /api/set rechaza canales de fábrica igual que un canal oculto, y acepta los de nombre propio
    assert.strictEqual((await b.post('/api/set', { m: 'o0', k: 'in-0', v: 0.5 })).status, 400);
    assert.strictEqual((await b.post('/api/set', { m: 'o0', k: 'in-5', v: 0.5 })).status, 400);
    assert.strictEqual((await b.post('/api/set', { m: 'o0', k: 'in-1', v: 0.5 })).status, 200);
  } finally { b.stop(); }
});

test('fader de la salida del rol: /output/<n>/faderlin y /level/out/<n> llegan a master', async () => {
  const b = await startBridge();
  try {
    await b.raw(bundle(message('/output/8/name', 'DRUMMER'), message('/output/8/stereo', 1)));
    await b.raw(bundle(message('/output/8/faderlin', 0.5)));
    await b.raw(bundle(message('/level/out/8', -20)));
    await eventually(async () => assert.deepStrictEqual((await b.get('/api/mix?m=o8')).master,
      { key: 'out', label: 'DRUMMER', sub: 'PH 9/10', value: 0.5, level: -20 }));
  } finally { b.stop(); }
});

test('/api/set con k "out" manda /output/<n>/faderlin a la salida de ese rol, recortado a 0..1', async () => {
  const b = await startBridge();
  try {
    await b.raw(bundle(message('/output/0/name', 'Piano'), message('/output/8/name', 'DRUMMER'), message('/output/8/stereo', 1)));
    await eventually(async () => assert.strictEqual((await b.get('/api/musicians')).length, 2));

    assert.strictEqual((await b.post('/api/set', { m: 'o8', k: 'out', v: 0.5 })).status, 200);
    await eventually(() => assert.strictEqual(b.last('/output/8/faderlin').args[0], 0.5));

    // otro rol: la orden va a SU salida (0), nunca a la 8
    assert.strictEqual((await b.post('/api/set', { m: 'o0', k: 'out', v: 0.3 })).status, 200);
    await eventually(() => assert.ok(Math.abs(b.last('/output/0/faderlin').args[0] - 0.3) < 1e-6));
    assert.strictEqual(b.received.filter((m) => m.address === '/output/8/faderlin').length, 1);

    await b.post('/api/set', { m: 'o8', k: 'out', v: 2 });
    await eventually(() => assert.strictEqual(b.last('/output/8/faderlin').args[0], 1));
    await b.post('/api/set', { m: 'o8', k: 'out', v: -1 });
    await eventually(() => assert.strictEqual(b.last('/output/8/faderlin').args[0], 0));

    assert.strictEqual((await b.post('/api/set', { m: 'o8', k: 'out', v: 'mucho' })).status, 400);
    assert.strictEqual((await b.post('/api/set', { m: 'nope', k: 'out', v: 0.5 })).status, 400);
  } finally { b.stop(); }
});

// Flujo SSE abierto que se lee en segundo plano: text() es lo recibido hasta ahora, ended() si el servidor cerró.
function sse(url) {
  const ctrl = new AbortController();
  let buf = '';
  let ended = false;
  fetch(url, { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { ended = true; break; }
        buf += dec.decode(value);
      }
    } catch { /* abortado por el test */ }
  }).catch(() => {});
  return { text: () => buf, ended: () => ended, stop: () => ctrl.abort() };
}
const lastData = (t) => {
  const lines = t.split('\n').filter((l) => l.startsWith('data: '));
  return lines.length ? JSON.parse(lines.at(-1).slice(6)) : null;
};

test('flujo abierto sigue el nombre de la salida: Coro, y gone cuando deja de ser rol', async () => {
  const b = await startBridge();
  let s = null;
  try {
    await b.raw(bundle(message('/output/1/name', 'Cantante')));
    await eventually(async () => assert.ok((await b.get('/api/musicians')).some((r) => r.id === 'o1')));
    s = sse(b.url('/api/stream?m=o1'));
    await eventually(() => { if (lastData(s.text())?.name !== 'Cantante') throw new Error('aún no llega Cantante'); });

    await b.raw(bundle(message('/output/1/name', 'Coro')));
    await eventually(() => {
      const d = lastData(s.text());
      assert.strictEqual(d.name, 'Coro');
      assert.strictEqual(d.master.label, 'Coro');
    });

    await b.raw(bundle(message('/output/1/name', 'AN 2')));
    await eventually(() => {
      assert.ok(s.ended(), 'el flujo sigue abierto');
      assert.ok(s.text().includes('event: gone\ndata: {}\n\n'), 'falta el evento gone');
    });
  } finally { if (s) s.stop(); b.stop(); }
});

test('mezcla: todo canal con nombre sale, también en -∞; ocultos y de fábrica no; /api/set acepta el de -∞', async () => {
  const b = await startBridge();
  try {
    for (const p of capturaComoPaquetes(CAPTURA)) await b.raw(p);
    // Voz 1 con su envío a la salida 1 en cero; Voz 2 (entrada 9) oculta
    await b.raw(bundle(message('/input/8/name', 'Voz 1'), message('/mix/in/8/1/faderlin', 0), message('/input/9/color', 0)));
    await eventually(async () => {
      const mix = await b.get('/api/mix?m=o1');
      assert.deepStrictEqual(mix.channels.find((c) => c.key === 'in-8'), { key: 'in-8', label: 'Voz 1', sub: 'AN 9', value: 0, level: null });
      assert.ok(!mix.channels.some((c) => c.key === 'in-9'), 'canal oculto salió en la mezcla');
      assert.ok(!mix.channels.some((c) => c.key === 'in-7'), 'canal de fábrica (AN 8) salió en la mezcla');
      assert.ok(!mix.channels.some((c) => /^(AN|PH|AES|ADAT)/i.test(c.label)), 'etiqueta de fábrica en la mezcla');
    });
    assert.strictEqual((await b.post('/api/set', { m: 'o1', k: 'in-8', v: 0.5 })).status, 200);
    await eventually(() => assert.strictEqual(b.last('/mix/in/8/1/faderlin').args[0], 0.5));
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
    // todos los canales con nombre (en -∞ también); ni el de fábrica (in-7) ni la pareja derecha (pb-1, pb-3)
    assert.deepStrictEqual(mix.channels.map((c) => c.key),
      ['in-0', 'in-1', 'in-2', 'in-3', 'in-4', 'in-5', 'in-6', 'in-8', 'in-9', 'in-10', 'in-11', 'pb-0', 'pb-2']);
    assert.strictEqual(mix.channels.find((c) => c.key === 'in-6').value, 0);
    assert.deepStrictEqual([mix.master.label, mix.master.sub, mix.master.level], ['DRUMMER', 'PH 9/10', -28]);
    assert.ok(Math.abs(mix.master.value - 0.8) < 1e-6);
  } finally { app.stop(); }
});
