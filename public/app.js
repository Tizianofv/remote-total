'use strict';
// Pantalla del músico: elegir rol y mover su mezcla. Habla con server.js.
// Los canales se identifican por `key` (no por posición); la lista puede crecer, cambiar o quedar vacía.

const app = document.getElementById('app');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const VISIBLE = 4;
let cleanup = () => {};
let gen = 0; // cambia al salir de cada pantalla; las respuestas viejas se descartan

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);

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
  const s = $('status');
  if (!s) return;
  s.classList.toggle('off', !ok);
  $('stxt').textContent = text;
}

// Sale de la pantalla actual: para timers, stream y animaciones, e invalida respuestas pendientes.
function leave() {
  gen++;
  const c = cleanup;
  cleanup = () => {};
  c();
}

async function showPicker() {
  leave();
  const g = gen;
  let timer = 0;
  cleanup = () => clearTimeout(timer);
  history.replaceState(null, '', location.pathname);
  app.innerHTML = header() + `
    <div>
      <h1>¿Cuál es tu <span>rol</span>?</h1>
      <p class="lede">Elige qué tocas en la sesión y controla lo que escuchas en tus audífonos.</p>
    </div>
    <div class="grid" id="grid"></div>
    <p id="err"></p>`;

  const load = async () => {
    if (g !== gen) return;
    try {
      const list = await api('/api/musicians');
      if (g !== gen) return;
      setStatus(true, 'Conectado');
      const grid = $('grid');
      if (!list.length) {
        // TotalMix aún no ha respondido: reintentar hasta que haya roles.
        grid.innerHTML = `<p class="hint" style="padding:22px 0 0">
          <b style="display:block;font:700 18px/1.2 var(--display);color:var(--text);margin-bottom:6px">Esperando a TotalMix…</b>
          Los roles son las salidas de TotalMix.</p>`;
        timer = setTimeout(load, 3000);
        return;
      }
      grid.innerHTML = list.map((m) => `
        <button class="who" data-id="${esc(m.id)}">
          <span class="name">${esc(m.name)}</span>
          <span class="out">${esc(m.out)}</span>
        </button>`).join('');
      grid.querySelectorAll('.who').forEach((b) => (b.onclick = () => showMix(b.dataset.id)));
    } catch {
      if (g !== gen) return;
      setStatus(false, 'Sin conexión');
      $('err').textContent = 'No hay conexión con el estudio. Revisa que estés en la WiFi del estudio.';
      timer = setTimeout(load, 3000);
    }
  };
  load();
}

async function showMix(id) {
  leave();
  const g = gen;
  let data;
  try { data = await api('/api/mix?m=' + encodeURIComponent(id)); }
  catch { if (g !== gen) return; store('rol', null); return showPicker(); }
  if (g !== gen) return;
  store('rol', id);
  history.replaceState(null, '', '?m=' + encodeURIComponent(id));

  app.innerHTML = header(`
    <div class="mixhead">
      <div>
        <h1 id="title">${esc(data.name)}</h1>
        <div class="route">Mezcla → <b id="out">${esc(data.out)}</b></div>
      </div>
      <button class="back" id="back">Cambiar</button>
    </div>`) + `
    <div id="body"></div>
    <p class="foot">Nombres y canales vienen de TotalMix</p>`;

  $('back').onclick = () => { store('rol', null); showPicker(); };

  // Estado por clave de canal (key).
  let keys = [];                 // claves pintadas, en orden de pantalla
  const val = new Map();         // valor 0..1 o null (lo que muestra el fader)
  const touched = new Map();     // hasta cuándo ignorar lo que llega de TotalMix (guarda de 700 ms)
  const meter = new Map();       // nivel suavizado del medidor
  const target = new Map();      // nivel real 0..1
  const timers = new Map();      // envío diferido por canal
  const lastSent = new Map();

  const render = (i) => {
    const f = $(`fader-${i}`);
    if (!f) return;
    const v = val.get(keys[i]);
    const has = v != null;
    $(`cap-${i}`).style.bottom = `calc(10px + ${has ? v : 0} * (100% - 20px))`;
    $(`cap-${i}`).style.opacity = has ? 1 : 0.35;
    $(`fill-${i}`).style.height = `calc(${has ? v : 0} * (100% - 20px))`;
    const d = has ? faderToDb(v) : null;
    $(`db-${i}`).innerHTML = has ? fmtDb(d) + '<small>dB</small>' : '—';
    f.setAttribute('aria-valuenow', has ? Math.round(v * 100) : 0);
    f.setAttribute('aria-valuetext', has ? fmtDb(d) + ' dB' : 'sin dato');
  };

  // Envío al estudio, como mucho cada 40 ms por fader. Va con `k` (clave del canal).
  const err = () => $('err');
  const push = (k) => {
    if (!val.has(k)) return; // el canal ya no existe
    lastSent.set(k, Date.now());
    fetch('/api/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ m: id, k, v: val.get(k) }) })
      .then((r) => { if (err()) err().textContent = r.ok ? '' : 'El estudio no aceptó el cambio.'; })
      .catch(() => { if (err()) err().textContent = 'Sin conexión con el estudio.'; });
  };
  const change = (i, v) => {
    const k = keys[i];
    val.set(k, Math.min(1, Math.max(0, v)));
    touched.set(k, Date.now() + 700);
    render(i);
    clearTimeout(timers.get(k));
    if (Date.now() - (lastSent.get(k) || 0) > 40) push(k);
    else timers.set(k, setTimeout(() => push(k), 40));
  };

  const bindStrip = (i) => {
    const f = $(`fader-${i}`);
    const fromY = (y) => {
      const r = f.getBoundingClientRect();
      change(i, 1 - (y - r.top - 10) / (r.height - 20));
    };
    f.addEventListener('pointerdown', (e) => { f.setPointerCapture(e.pointerId); fromY(e.clientY); });
    f.addEventListener('pointermove', (e) => { if (f.hasPointerCapture(e.pointerId)) fromY(e.clientY); });
    f.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const cur = val.get(keys[i]) ?? 0;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') change(i, cur + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') change(i, cur - step);
      else return;
      e.preventDefault();
    });
  };

  const stripHtml = (c, i) => `
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
      </div>`;

  const bodyHtml = (chs) => {
    if (!chs.length) {
      return `<div class="hint" style="padding:26px 8px">
        <b style="display:block;font:700 17px/1.25 var(--display);color:var(--text);margin-bottom:8px">Todavía no hay canales en tu mezcla.</b>
        Pídele al ingeniero que suba en TotalMix los canales que quieres escuchar.</div>
        <p id="err"></p>`;
    }
    const paged = chs.length > VISIBLE;
    return `${paged ? `<div class="pager">
      <button class="pg" id="pgl" aria-label="Faders anteriores">‹</button>
      <span id="pgtxt"></span>
      <button class="pg" id="pgr" aria-label="Más faders">›</button>
    </div>` : ''}
    <div class="strips ${paged ? 'scroll' : ''}" id="strips" style="--n:${Math.min(chs.length, VISIBLE)}">${chs.map(stripHtml).join('')}
    </div>
    <p id="err"></p>`;
  };

  // Mantiene valores y medidores de cada clave; quita lo que ya no existe.
  const sync = (chs) => {
    const live = new Set(chs.map((c) => c.key));
    for (const k of [...val.keys()]) {
      if (live.has(k)) continue;
      val.delete(k); meter.delete(k); target.delete(k); touched.delete(k); lastSent.delete(k);
      clearTimeout(timers.get(k)); timers.delete(k);
    }
    chs.forEach((c) => {
      if (!val.has(c.key)) val.set(c.key, c.value ?? null);
      if (!meter.has(c.key)) meter.set(c.key, 0);
      target.set(c.key, levelToMeter(c.level));
    });
  };

  // Pinta el cuerpo (paginado, faders o mensaje vacío) con la lista de canales dada.
  const mount = (chs) => {
    const prev = $('strips')?.scrollLeft ?? 0;
    keys = chs.map((c) => c.key);
    $('body').innerHTML = bodyHtml(chs);
    keys.forEach((_, i) => { render(i); bindStrip(i); });
    bindPager();
    const box = $('strips');
    if (box) box.scrollLeft = prev;
  };

  // Paginado de a 4 cuando hay más faders.
  const bindPager = () => {
    const box = $('strips');
    if (!box || keys.length <= VISIBLE) return;
    const stepW = () => box.querySelector('.strip').getBoundingClientRect().width + 8;
    const update = () => {
      if (!$('pgtxt')) return;
      const first = Math.round(box.scrollLeft / stepW());
      const last = Math.min(keys.length, first + VISIBLE);
      $('pgtxt').textContent = `Faders ${first + 1}–${last} de ${keys.length}`;
      $('pgl').disabled = first === 0;
      $('pgr').disabled = last >= keys.length;
    };
    box.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
    $('pgl').onclick = () => box.scrollBy({ left: -stepW() * VISIBLE, behavior: reduce ? 'auto' : 'smooth' });
    $('pgr').onclick = () => box.scrollBy({ left: stepW() * VISIBLE, behavior: reduce ? 'auto' : 'smooth' });
    update();
  };

  const initial = data.channels || [];
  sync(initial);
  mount(initial);

  // Valores y niveles en vivo desde TotalMix.
  const es = new EventSource('/api/stream?m=' + encodeURIComponent(id));
  es.onopen = () => setStatus(true, 'Conectado');
  es.onerror = () => setStatus(false, 'Reconectando…');
  es.onmessage = (ev) => {
    setStatus(true, 'Conectado');
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.name) $('title').textContent = d.name;
    if (d.out != null) $('out').textContent = d.out;
    const chs = d.channels || [];
    const same = chs.length === keys.length && chs.every((c, i) => c.key === keys[i]);
    sync(chs);
    if (!same) mount(chs); // se añadieron, quitaron o reordenaron canales: repintar conservando valores
    chs.forEach((c, i) => {
      const lab = $(`lab-${i}`);
      const html = `${esc(c.label)}<small>${esc(c.sub)}</small>`;
      if (lab && lab.innerHTML !== html) lab.innerHTML = html;
      const f = $(`fader-${i}`);
      if (f) f.setAttribute('aria-label', c.label ?? '');
      const k = c.key;
      if (c.value != null && Date.now() > (touched.get(k) ?? 0) && c.value !== val.get(k)) {
        val.set(k, c.value);
        render(i);
      }
    });
  };

  let raf = 0;
  const loop = () => {
    keys.forEach((k, i) => {
      const t = target.get(k) ?? 0;
      const m = meter.get(k) ?? 0;
      const next = m + (t - m) * (t > m ? 0.7 : 0.15);
      meter.set(k, next);
      const el = $(`m-${i}`);
      if (el) { el.style.height = (next * 100).toFixed(1) + '%'; el.style.setProperty('--h', el.parentElement.clientHeight + 'px'); }
    });
    raf = requestAnimationFrame(loop);
  };
  loop();

  cleanup = () => {
    es.close();
    cancelAnimationFrame(raf);
    for (const t of timers.values()) clearTimeout(t);
  };
}

const start = new URLSearchParams(location.search).get('m') || recall('rol');
start ? showMix(start) : showPicker();
