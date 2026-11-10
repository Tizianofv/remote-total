'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encodeMessage, decodeMessage } = require('../osc');
const ufx = require('../ufx');

test('codifica un float OSC según la especificación', () => {
  const buf = encodeMessage('/1/volume1', [0.5]);
  assert.strictEqual(buf.length, 20);
  assert.deepStrictEqual([...buf.subarray(16)], [0x3f, 0x00, 0x00, 0x00]);
  assert.deepStrictEqual(decodeMessage(buf), { address: '/1/volume1', args: [0.5] });
});

test('nombres de canales UFX y curva oficial de fader', () => {
  assert.strictEqual(ufx.channelIndex('AN 1'), 0);
  assert.strictEqual(ufx.channelIndex('AN 9/10'), 8);
  assert.strictEqual(ufx.channelIndex('AN 12'), 11);
  assert.ok(Math.abs(ufx.faderToDb(1) - 6) < 0.01);
  assert.ok(Math.abs(ufx.faderToDb(ufx.dbToFader(-20)) + 20) < 0.01);
  assert.strictEqual(ufx.faderToDb(0), -Infinity);
});

async function startBridge(cfg) {
  const udp = dgram.createSocket('udp4');
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  const received = [];
  udp.on('message', (b) => received.push(decodeMessage(b)));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const listenPort = 19000 + Math.floor(Math.random() * 1000);
  const full = { port, ...cfg, totalmix: { host: '127.0.0.1', port: udp.address().port, listenPort, gapMs: 1 } };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(full));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, CONFIG: cfgPath } });
  let out = '';
  await new Promise((r) => proc.stdout.on('data', (d) => { out += d; if (out.includes('Abrir desde')) r(); }));
  return { udp, proc, port, listenPort, received, stop: () => { proc.kill(); udp.close(); } };
}

test('Global OSC: 8 músicos a la vez, una orden directa por fader, y lee lo que devuelve TotalMix', async () => {
  const musicians = Array.from({ length: 8 }, (_, i) => ({
    id: 'm' + i, name: 'Músico ' + i, output: i < 6 ? `AN ${i + 1}` : `AN ${i === 6 ? '9/10' : '11/12'}`,
    channels: [{ input: `AN ${i + 1}` }, { label: 'Pista', playback: 'AN 1/2' }],
  }));
  const b = await startBridge({ mode: 'global', useTotalMixNames: true, musicians });
  try {
    await new Promise((r) => setTimeout(r, 150));
    // al arrancar pide nombres y valores
    assert.ok(b.received.some((m) => m.address === '/sendchan/output/0'));
    b.received.length = 0;
    await Promise.all(musicians.map((m, i) => fetch(`http://127.0.0.1:${b.port}/api/set`, {
      method: 'POST', body: JSON.stringify({ m: m.id, c: 0, v: i / 10 }),
    })));
    const deadline = Date.now() + 3000;
    while (b.received.length < 8 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const outs = [0, 1, 2, 3, 4, 5, 8, 10];
    for (let i = 0; i < 8; i++) {
      const msg = b.received.find((m) => m.address === `/mix/in/${i}/${outs[i]}/faderlin`);
      assert.ok(msg, `falta orden del músico ${i}`);
      assert.ok(Math.abs(msg.args[0] - i / 10) < 1e-6);
    }
    // TotalMix responde: nombre de la salida y un fader movido desde la consola
    const s = dgram.createSocket('udp4');
    const reply = (addr, v) => new Promise((r) => s.send(Buffer.concat([
      typeof v === 'string'
        ? Buffer.concat([pad(addr), pad(',s'), pad(v)])
        : encodeMessage(addr, [v]),
    ]), b.listenPort, '127.0.0.1', r));
    await reply('/output/0/name', 'Batería');
    await reply('/input/0/name', 'MIC 1');
    await reply('/mix/pb/0/0/faderlin', 0.25);
    s.close();
    await new Promise((r) => setTimeout(r, 100));
    const mix = await (await fetch(`http://127.0.0.1:${b.port}/api/mix?m=m0`)).json();
    assert.strictEqual(mix.name, 'Batería');
    assert.strictEqual(mix.channels[0].label, 'MIC 1');
    assert.ok(Math.abs(mix.channels[1].value - 0.25) < 1e-6);
  } finally { b.stop(); }
});

function pad(str) { const raw = Buffer.from(str + '\0'); const o = Buffer.alloc(Math.ceil(raw.length / 4) * 4); raw.copy(o); return o; }

test('modo clásico: setSubmix -> bus -> fader en orden', async () => {
  const b = await startBridge({ mode: 'classic', musicians: [{ id: 'a', name: 'A', submix: 2, channels: [{ label: 'Yo', bus: 'input', fader: 9 }] }] });
  try {
    await fetch(`http://127.0.0.1:${b.port}/api/set`, { method: 'POST', body: JSON.stringify({ m: 'a', c: 0, v: 0.5 }) });
    const deadline = Date.now() + 2000;
    while (b.received.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(b.received.map((m) => m.address), ['/setSubmix', '/1/busInput', '/1/volume9']);
  } finally { b.stop(); }
});
