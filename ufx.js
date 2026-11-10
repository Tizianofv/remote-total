'use strict';
// Nombres de canales de la Fireface UFX (original) -> número de canal de Global OSC.
// Global OSC cuenta desde 0 y una pareja estéreo se nombra por su canal izquierdo
// (tabla oficial de RME, "OSC-Commands TotalMix FX 2.1 beta 2").
//
// Orden medido con TotalMix real (captura de 10-nov-2026, test/fixtures/captura-real.txt):
// AN 1–12 = 0–11, AES = 12, ADAT 1/2 = 14 … ADAT 15/16 = 28.

function channelIndex(name) {
  if (typeof name === 'number') return name;
  const s = String(name).trim().toUpperCase().replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/^(?:AN|ANALOG|PH|PHONES)\s*(\d+)(?:\s*\/\s*\d+)?$/))) return Number(m[1]) - 1;
  if ((m = s.match(/^AES(?:\s*(L|R|1|2))?(?:\s*\/\s*(?:R|2))?$/))) return 12 + (m[1] === 'R' || m[1] === '2' ? 1 : 0);
  if ((m = s.match(/^ADAT\s*(\d+)(?:\s*\/\s*\d+)?$/))) return 14 + Number(m[1]) - 1;
  if (/^\d+$/.test(s)) return Number(s);
  throw new Error(`No reconozco el canal "${name}". Usa por ejemplo "AN 9", "AN 9/10", "AES L" o "ADAT 3".`);
}

function channelLabel(index) {
  if (index < 12) return `AN ${index + 1}`;
  if (index < 14) return index === 12 ? 'AES L' : 'AES R';
  return `ADAT ${index - 13}`;
}

// Curva oficial de fader de TotalMix (hoja "Fader curve" de la tabla de RME).
function faderToDb(lin) {
  const pos = lin * 1023;
  const db = pos >= 649 ? pos * 0.0320855615 - 26.8235294118
    : pos * pos * (-1 / 11033) + pos * 0.1497326203 - 65;
  return db < -64.9 ? -Infinity : db;
}
function dbToFader(db) {
  const pos = db >= -6
    ? (db + 26.8235294118) / 0.0320855615
    : 826 - Math.sqrt(Math.max(0, -34869 - 11033 * db));
  return Math.min(1, Math.max(0, pos / 1023));
}

module.exports = { channelIndex, channelLabel, faderToDb, dbToFader };
