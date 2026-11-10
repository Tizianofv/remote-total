'use strict';
// Codificación mínima de mensajes OSC 1.0 (solo argumentos float32),
// suficiente para hablar con TotalMix FX sin dependencias externas.

function padString(str) {
  const raw = Buffer.from(str + '\0', 'ascii');
  const len = Math.ceil(raw.length / 4) * 4;
  const out = Buffer.alloc(len);
  raw.copy(out);
  return out;
}

function encodeMessage(address, floats = []) {
  const parts = [padString(address), padString(',' + 'f'.repeat(floats.length))];
  for (const f of floats) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(f, 0);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function readString(buf, offset) {
  const end = buf.indexOf(0, offset);
  const str = buf.toString('utf8', offset, end);
  return { str, next: Math.ceil((end + 1) / 4) * 4 };
}

// Decodifica un mensaje simple (no bundles); se usa en las pruebas
// y para mostrar lo que TotalMix responde.
function decodeMessage(buf) {
  const a = readString(buf, 0);
  const t = readString(buf, a.next);
  let off = t.next;
  const args = [];
  for (const tag of t.str.slice(1)) {
    if (tag === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (tag === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (tag === 's') { const s = readString(buf, off); args.push(s.str); off = s.next; }
    else break;
  }
  return { address: a.str, args };
}

module.exports = { encodeMessage, decodeMessage };
