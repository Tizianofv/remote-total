'use strict';
// Pantalla del músico: elegir rol y mover su mezcla. Habla con server.js.

const app = document.getElementById('app');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const VISIBLE = 4;
let cleanup = () => {};

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Curva oficial de fader de TotalMix (tabla Global OSC de RME).
function faderToDb(lin) {
  const pos = lin * 1023;
  const db = pos >= 649 ? pos * 0.0320855615 - 26.8235294118 : pos * pos * (-1 / 11033) + pos * 0.1497326203 - 65;
  return db < -64.9 ? -Infinity : db;
}
const dbPos = (d) => Math.min(1, Math.max(0, (d >= -6 ? (d + 26.8235294118) / 0.0320855615 : 826 - Math.sqrt(-34869 - 11033 * d)) / 1023));
const ZERO = dbPos(0); // posición de 0 dB
const fmtDb = (d) => (d === -Infinity ? '−∞' : (d > 0.05 ? '+' : d < -0.05 ? '−' : '') + Math.abs(d).toFixed(1));
const levelToMeter = (db) => (db == null || !Number.isFinite(db) ? 0 : Math.min(1, Math.max(0, (db + 60) / 60)));

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function recall(k) { try { return localStorage.getItem(k); } catch { return null; } }

async function api(p, opts) {
  const r = await fetch(p, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `error ${r.status}`);
  return r.json();
}

function header(extra = '') {
  return `<div class="top">
    <div class="brand"><b>Remote</b> Total</div>
    <div class="topr"><div class="status" id="status"><span class="dot"></span><span id="stxt">TotalMix</span></div></div>
  </div>${extra}`;
}
function setStatus(ok, text) {
  const s = document.getElementById('status');
  if (!s) return;
  s.classList.toggle('off', !ok);
  document.getElementById('stxt').textContent = text;
}

async function showPicker() {
  cleanup(); cleanup = () => {};
  history.replaceState(null, '', location.pathname);
  app.innerHTML = header() + `
    <div>
      <h1>¿Cuál es tu <span>rol</span>?</h1>
      <p class="lede">Elige qué tocas en la sesión y controla lo que escuchas en tus audífonos.</p>
    </div>
    <div class="grid" id="grid"></div>
    <p id="err"></p>`;
  try {
    const list = await api('/api/musicians');
    setStatus(true, 'Conectado');
    const grid = document.getElementById('grid');
    grid.innerHTML = list.map((m) => `
      <button class="who" data-id="${esc(m.id)}">
        <span class="name">${esc(m.name)}</span>
        <span class="out">${esc(m.out)}</span>
      </button>`).join('');
    grid.querySelectorAll('.who').forEach((b) => (b.onclick = () => showMix(b.dataset.id)));
  } catch (e) {
    setStatus(false, 'Sin conexión');
    document.getElementById('err').textContent = 'No hay conexión con el estudio. Revisa que estés en la WiFi del estudio.';
  }
}

async function showMix(id) {
  cleanup();
  let data;
  try { data = await api('/api/mix?m=' + encodeURIComponent(id)); }
  catch { store('rol', null); return showPicker(); }
  store('rol', id);
  history.replaceState(null, '', '?m=' + encodeURIComponent(id));
  const ch = data.channels;
  const paged = ch.length > VISIBLE;

  app.innerHTML = header(`
    <div class="mixhead">
      <div>
        <h1 id="title">${esc(data.name)}</h1>
        <div class="route">Mezcla → <b>${esc(data.out)}</b></div>
      </div>
      <button class="back" id="back">Cambiar</button>
    </div>`) + `
    ${paged ? `<div class="pager">
      <button class="pg" id="pgl" aria-label="Faders anteriores">‹</button>
      <span id="pgtxt"></span>
      <button class="pg" id="pgr" aria-label="Más faders">›</button>
    </div>` : ''}
    <div class="strips ${paged ? 'scroll' : ''}" id="strips" style="--n:${Math.min(ch.length, VISIBLE)}">${ch.map((c, i) => `
      <div class="strip ${i === 0 ? 'me' : ''}">
        <div class="db" id="db-${i}"></div>
        <div class="body">
          <div class="meter"><i id="m-${i}"></i></div>
          <div class="fader" id="fader-${i}" tabindex="0" role="slider" aria-label="${esc(c.label)}" aria-valuemin="0" aria-valuemax="100">
            <div class="rail"></div>
            ${[6, -6, -10, -20, -40, -60].map((d) => `<div class="tick" style="bottom:calc(10px + ${dbPos(d)} * (100% - 20px))"><b>${Math.abs(d)}</b></div>`).join('')}
            <div class="tick zero" style="bottom:calc(10px + ${ZERO} * (100% - 20px))"><b>0</b></div>
            <div class="fill" id="fill-${i}"></div>
            <div class="cap" id="cap-${i}"></div>
          </div>
        </div>
        <div class="label" id="lab-${i}">${esc(c.label)}<small>${esc(c.sub)}</small></div>
      </div>`).join('')}
    </div>
    <p id="err"></p>
    <p class="foot">Los cambios solo afectan tu mezcla</p>`;

  document.getElementById('back').onclick = () => { store('rol', null); showPicker(); };

  const val = ch.map((c) => c.value);
  const touched = ch.map(() => 0); // hasta cuándo ignorar lo que llega de TotalMix
  const meter = ch.map(() => 0);
  const target = ch.map((c) => levelToMeter(c.level));

  const render = (i) => {
    const v = val[i];
    const f = document.getElementById(`fader-${i}`);
    const has = v != null;
    document.getElementById(`cap-${i}`).style.bottom = `calc(10px + ${has ? v : 0} * (100% - 20px))`;
    document.getElementById(`cap-${i}`).style.opacity = has ? 1 : 0.35;
    document.getElementById(`fill-${i}`).style.height = `calc(${has ? v : 0} * (100% - 20px))`;
    const d = has ? faderToDb(v) : null;
    document.getElementById(`db-${i}`).innerHTML = has ? fmtDb(d) + '<small>dB</small>' : '—';
    f.setAttribute('aria-valuenow', has ? Math.round(v * 100) : 0);
    f.setAttribute('aria-valuetext', has ? fmtDb(d) + ' dB' : 'sin dato');
  };

  // Envío al estudio, como mucho cada 40 ms por fader.
  const timers = {}, lastSent = {};
  const err = () => document.getElementById('err');
  const push = (i) => {
    lastSent[i] = Date.now();
    fetch('/api/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ m: id, c: i, v: val[i] }) })
      .then((r) => { if (err()) err().textContent = r.ok ? '' : 'El estudio no aceptó el cambio.'; })
      .catch(() => { if (err()) err().textContent = 'Sin conexión con el estudio.'; });
  };
  const change = (i, v) => {
    val[i] = Math.min(1, Math.max(0, v));
    touched[i] = Date.now() + 700;
    render(i);
    clearTimeout(timers[i]);
    if (Date.now() - (lastSent[i] || 0) > 40) push(i); else timers[i] = setTimeout(() => push(i), 40);
  };

  ch.forEach((c, i) => {
    render(i);
    const f = document.getElementById(`fader-${i}`);
    const fromY = (y) => {
      const r = f.getBoundingClientRect();
      change(i, 1 - (y - r.top - 10) / (r.height - 20));
    };
    f.addEventListener('pointerdown', (e) => { f.setPointerCapture(e.pointerId); fromY(e.clientY); });
    f.addEventListener('pointermove', (e) => { if (f.hasPointerCapture(e.pointerId)) fromY(e.clientY); });
    f.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const cur = val[i] ?? 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') change(i, cur + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') change(i, cur - step);
      else return;
      e.preventDefault();
    });
  });

  // Paginado de a 4 cuando hay más faders.
  const box = document.getElementById('strips');
  if (paged) {
    const stepW = () => box.querySelector('.strip').getBoundingClientRect().width + 8;
    const update = () => {
      const first = Math.round(box.scrollLeft / stepW());
      const last = Math.min(ch.length, first + VISIBLE);
      document.getElementById('pgtxt').textContent = `Faders ${first + 1}–${last} de ${ch.length}`;
      document.getElementById('pgl').disabled = first === 0;
      document.getElementById('pgr').disabled = last >= ch.length;
    };
    box.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
    document.getElementById('pgl').onclick = () => box.scrollBy({ left: -stepW() * VISIBLE, behavior: reduce ? 'auto' : 'smooth' });
    document.getElementById('pgr').onclick = () => box.scrollBy({ left: stepW() * VISIBLE, behavior: reduce ? 'auto' : 'smooth' });
    update();
  }

  // Valores y niveles en vivo desde TotalMix.
  const es = new EventSource('/api/stream?m=' + encodeURIComponent(id));
  es.onopen = () => setStatus(true, 'Conectado');
  es.onerror = () => setStatus(false, 'Reconectando…');
  es.onmessage = (ev) => {
    setStatus(true, 'Conectado');
    const d = JSON.parse(ev.data);
    if (d.name) document.getElementById('title').textContent = d.name;
    (d.labels || []).forEach(([l, sub], i) => {
      const el = document.getElementById(`lab-${i}`);
      const html = `${esc(l)}<small>${esc(sub)}</small>`;
      if (el && el.innerHTML !== html) el.innerHTML = html;
    });
    d.values.forEach((v, i) => {
      if (v != null && Date.now() > touched[i] && v !== val[i]) { val[i] = v; render(i); }
    });
    d.levels.forEach((l, i) => { target[i] = levelToMeter(l); });
  };

  let raf = 0;
  const loop = () => {
    ch.forEach((c, i) => {
      meter[i] += (target[i] - meter[i]) * (target[i] > meter[i] ? 0.7 : 0.15);
      const el = document.getElementById(`m-${i}`);
      if (el) { el.style.height = (meter[i] * 100).toFixed(1) + '%'; el.style.setProperty('--h', el.parentElement.clientHeight + 'px'); }
    });
    raf = requestAnimationFrame(loop);
  };
  loop();

  cleanup = () => { es.close(); cancelAnimationFrame(raf); Object.values(timers).forEach(clearTimeout); };
}

const start = new URLSearchParams(location.search).get('m') || recall('rol');
start ? showMix(start) : showPicker();
