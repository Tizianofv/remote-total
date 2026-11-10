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
  let end = buf.indexOf(0, offset);
  if (end < 0) end = buf.length;
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

// Un paquete UDP de TotalMix llega como bundle OSC: "#bundle\0", timetag de 8 bytes y
// elementos [int32 tamaño][contenido], donde el contenido puede ser un mensaje o otro bundle.
// Devuelve todos los mensajes del paquete. Nunca lanza: un elemento mal formado se salta
// (un tamaño que se sale del paquete corta el bundle ahí) y los mensajes anteriores se conservan.
function decodePackets(buf, out = []) {
  try {
    if (buf.length >= 16 && buf.toString('ascii', 0, 8) === '#bundle\0') {
      let off = 16;
      while (off + 4 <= buf.length) {
        const size = buf.readInt32BE(off);
        off += 4;
        if (size < 0 || off + size > buf.length) break; // elemento truncado: lo que sigue no es fiable
        decodePackets(buf.subarray(off, off + size), out);
        off += size;
      }
    } else if (buf.length > 0 && buf[0] === 0x2f) { // '/': mensaje suelto
      out.push(decodeMessage(buf));
    }
  } catch { /* paquete mal formado: quedan los mensajes ya leídos */ }
  return out;
}

module.exports = { encodeMessage, decodeMessage, decodePackets };
