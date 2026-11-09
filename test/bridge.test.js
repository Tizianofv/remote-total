'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encodeMessage, decodeMessage } = require('../osc');

test('codifica un float OSC según la especificación', () => {
  const buf = encodeMessage('/1/volume1', [0.5]);
  // "/1/volume1\0" + relleno a 12, ",f\0\0", float32 BE de 0.5
  assert.strictEqual(buf.length, 12 + 4 + 4);
  assert.strictEqual(buf.toString('ascii', 0, 10), '/1/volume1');
  assert.strictEqual(buf.toString('ascii', 12, 14), ',f');
  assert.deepStrictEqual([...buf.subarray(16)], [0x3f, 0x00, 0x00, 0x00]);
  assert.deepStrictEqual(decodeMessage(buf), { address: '/1/volume1', args: [0.5] });
});

test('8 músicos a la vez: cada cambio llega como setSubmix -> bus -> fader, sin mezclarse', async () => {
  const udp = dgram.createSocket('udp4');
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  const received = [];
  udp.on('message', (b) => received.push(decodeMessage(b)));

  const musicians = Array.from({ length: 8 }, (_, i) => ({
    id: 'm' + i, name: 'Músico ' + i, submix: i * 2,
    channels: [{ label: 'Yo', bus: i % 2 ? 'playback' : 'input', fader: (i % 8) + 1 }],
  }));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const cfg = { port, totalmix: { host: '127.0.0.1', port: udp.address().port, gapMs: 1 }, musicians };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, CONFIG: cfgPath } });
  await new Promise((r) => proc.stdout.once('data', r));
  try {
    await Promise.all(musicians.map((m, i) => fetch(`http://127.0.0.1:${port}/api/set`, {
      method: 'POST', body: JSON.stringify({ m: m.id, c: 0, v: i / 10 }),
    }).then((r) => assert.strictEqual(r.status, 200))));
    const deadline = Date.now() + 3000;
    while (received.length < 24 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(received.length, 24);
    const seen = new Set();
    for (let k = 0; k < 24; k += 3) {
      const [sub, bus, vol] = received.slice(k, k + 3);
      assert.strictEqual(sub.address, '/setSubmix');
      const i = sub.args[0] / 2;
      const m = musicians[i];
      assert.strictEqual(bus.address, m.channels[0].bus === 'input' ? '/1/busInput' : '/1/busPlayback');
      assert.strictEqual(vol.address, `/1/volume${m.channels[0].fader}`);
      assert.ok(Math.abs(vol.args[0] - i / 10) < 1e-6);
      seen.add(i);
    }
    assert.strictEqual(seen.size, 8);
  } finally {
    proc.kill(); udp.close();
  }
});
