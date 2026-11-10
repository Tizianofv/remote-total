'use strict';
// Pantalla del músico: elegir rol y mover su mezcla. Habla con server.js.
// Los canales se identifican por `key` (no por posición); la lista puede crecer, cambiar o quedar vacía.
// Cada rol tiene además su salida (`master`, key "out"): fija a la derecha, siempre visible.

const app = document.getElementById('app');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STRIP_W = 76;   // ancho mínimo de un canal (px), con la escala de la captura
const GAP = 2;        // separación entre canales (px)
const OUT_W = 84;     // ancho fijo de la salida del rol (px)
const FX_MIN = -65;   // rango del retorno FX en dB: -65 es apagado (se muestra -∞), 0 es el máximo
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
// Pico retenido (rayita del medidor y lectura de arriba). Constantes de la sala:
const SIGNAL_DB = -60;          // por debajo de esto no hay señal: la rayita no se ve
const PEAK_HOLD_MS = 2000;      // cuánto se queda quieta la rayita tras un máximo
const PEAK_FALL_DB_PER_S = 20;  // velocidad de bajada después de ese tiempo (provisional, lo decide la sala)
const labelHtml = (c) => `<b>${esc(c.label)}</b><small>${esc(c.sub)}</small>`;
// Si dos marcas de la escala quedan a menos de 11 px, se oculta la etiqueta de la de menor prioridad
// (0, 60, 20, 40, 10, 6). La rayita siempre se queda.
const SCALE_PRI = { 0: 0, 60: 1, 20: 2, 40: 3, 10: 4, 6: 5 };
function fitScale() {
  // Solo actúa en el horizontal bajo: el 320 px vive en un único sitio, el @media de index.html,
  // que pone --scale-fit en 1. Fuera de ahí no se oculta ninguna etiqueta.
  const narrow = getComputedStyle(document.documentElement).getPropertyValue('--scale-fit').trim() === '1';
  document.querySelectorAll('.fader .tick b.hid').forEach((b) => b.classList.remove('hid'));
  if (!narrow) return;
  document.querySelectorAll('.fader').forEach((f) => {
    const H = f.clientHeight;
    const marks = [...f.querySelectorAll('.tick')].map((t) => {
      const b = t.querySelector('b');
      if (b) b.classList.remove('hid');
      const db = Number(t.dataset.db);
      return { b, y: 10 + dbPos(db) * (H - 20), p: SCALE_PRI[Math.abs(db)] ?? 9 };
    });
    marks.sort((a, c) => a.p - c.p);
    const kept = [];
    for (const m of marks) {
      if (!m.b) continue;
      if (kept.some((y) => Math.abs(y - m.y) < 11)) m.b.classList.add('hid');
      else kept.push(m.y);
    }
  });
}

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function recall(k) { try { return localStorage.getItem(k); } catch { return null; } }

async function api(p, opts) {
  const r = await fetch(p, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `error ${r.status}`);
  return r.json();
}

// ---- Pantalla completa ----
// El navegador solo deja entrar con un gesto del usuario, y en el celular ese gesto llega con pointerup/click
// (no con pointerdown del tacto). Se pide en los toques que terminan hasta que una petición llega a pantalla completa (fsAutoDone); luego ya no, mientras no esté en pantalla completa
// y el usuario no haya salido a propósito con el botón. Un intento rechazado no gasta nada: se reintenta en el siguiente toque.
const fsSupported = !!((document.documentElement.requestFullscreen && document.fullscreenEnabled) ||
  (document.documentElement.webkitRequestFullscreen && document.webkitFullscreenEnabled));
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
let fsUserExited = false; // true tras salir con el botón; vuelve a false al pulsar Completa (o al recargar)
let fsPending = false;    // hay una petición en vuelo: no se lanza otra encima
let fsAutoDone = false;   // true en cuanto una petición llega a pantalla completa: la entrada automática se apaga para la visita (el botón sigue)
function fsEnter() {
  if (fsPending) return;
  try {
    const el = document.documentElement;
    const p = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen();
    if (p && p.then) {
      fsPending = true;
      p.then(() => { fsPending = false; }, () => { fsPending = false; }); // rechazado: se ignora, nada queda gastado
    }
  } catch {}
}
function fsExit() {
  try {
    const p = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen();
    if (p && p.catch) p.catch(() => {});
  } catch {}
}
// Icono en línea (sin librerías): cuatro esquinas hacia afuera = entrar; hacia adentro = salir.
const FS_ENTER = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M4 9V4h5M4 4l6 6M20 9V4h-5M20 4l-6 6M4 15v5h5M4 20l6-6M20 15v5h-5M20 20l-6-6"/></svg>';
const FS_EXIT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M9 4v5H4M9 9L3 3M15 4v5h5M15 9l6-6M9 20v-5H4M9 15l-6 6M15 20v-5h5M15 15l6 6"/></svg>';
const fsAttrs = () => (fsEl() ? { label: 'Salir de pantalla completa', icon: FS_EXIT } : { label: 'Pantalla completa', icon: FS_ENTER });
function fsSync() {
  if (fsEl()) fsAutoDone = true; // ya entró: no más entrada automática en esta visita, salga como salga
  const b = $('fsbtn');
  if (!b) return;
  const a = fsAttrs();
  b.innerHTML = a.icon;
  b.setAttribute('aria-label', a.label);
  b.setAttribute('title', a.label);
}
if (fsSupported) {
  const onBtn = (e) => !!(e.target.closest && e.target.closest('#fsbtn'));
  // Un toque o arrastre que termina (pointerup) y el click de respaldo (teclado, accesibilidad) piden pantalla completa.
  // Fase de captura y sin cancelar: la acción del toque sigue igual.
  const autoEnter = (e) => {
    if (onBtn(e) || fsUserExited || fsAutoDone || fsEl()) return;
    fsEnter();
  };
  document.addEventListener('pointerup', autoEnter, { capture: true });
  document.addEventListener('click', autoEnter, { capture: true });
  document.addEventListener('click', (e) => {
    if (!onBtn(e)) return;
    if (fsEl()) { fsUserExited = true; fsExit(); }
    else { fsUserExited = false; fsEnter(); }
  });
  document.addEventListener('fullscreenchange', fsSync);
  document.addEventListener('webkitfullscreenchange', fsSync);
}

// En la mezcla (`centerFs`) el botón de pantalla completa va en su propio hueco (.fsslot), centrado entre el logo
// y el estado. En elegir rol la cabecera no cambia: el botón queda junto al estado.
function header(extra = '', centerFs = false) {
  const fsBtn = fsSupported ? `<button class="fs" id="fsbtn" type="button" aria-label="${fsAttrs().label}" title="${fsAttrs().label}">${fsAttrs().icon}</button>` : '';
  const status = `<div class="status" id="status"><span class="dot"></span><span id="stxt">TotalMix</span></div>`;
  const brand = `<div class="brand">${document.getElementById('logo-tpl').innerHTML}</div>`;
  if (centerFs) return `<div class="top">${brand}<div class="fsslot">${fsBtn}</div><div class="topr">${status}</div></div>${extra}`;
  return `<div class="top">
    ${brand}
    <div class="topr">${fsBtn}${status}</div>
  </div>${extra}`;
}
function setStatus(ok, text) {
  const s = $('status');
  if (!s) return;
  s.classList.toggle('off', !ok);
  $('stxt').textContent = text;
  // En la mezcla el texto no se ve (solo el punto): va en aria-label y title. En elegir rol no cambia nada.
  if (app.classList.contains('mix')) { s.setAttribute('aria-label', text); s.setAttribute('title', text); }
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
  app.classList.remove('mix');
  app.classList.add('pick');
  let timer = 0;
  let shown = null; // firma de la lista pintada: solo se repinta si cambia
  cleanup = () => clearTimeout(timer);
  history.replaceState(null, '', location.pathname);
  app.innerHTML = header() + `
    <div>
      <p class="kicker">Caribbean Dream Studios</p>
      <h1>Tu Sonido!!</h1>
      <p class="lede">Elige quién eres en la sesión</p>
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
      $('err').textContent = '';
      // Se vuelve a pedir cada 3 s; solo se repinta si cambió algo (id, nombre o salida), para no perder el toque.
      const sig = JSON.stringify(list.map((m) => [m.id, m.name, m.out]));
      if (sig !== shown) {
        shown = sig;
        if (!list.length) {
          // TotalMix aún no ha respondido: esperar a que haya roles.
          grid.innerHTML = `<p class="hint" style="padding:22px 0 0">
            <b style="display:block;font:800 18px/1.2 var(--f-title);text-transform:uppercase;letter-spacing:.04em;color:var(--fg);margin-bottom:6px">Esperando a TotalMix…</b>
            Los roles son las salidas de TotalMix.</p>`;
        } else {
          grid.innerHTML = list.map((m, i) => `
            <button class="who" data-id="${esc(m.id)}">
              <span class="num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
              <span class="name">${esc(m.name)}</span>
              <span class="out">${esc(m.out)}</span>
            </button>`).join('');
          grid.querySelectorAll('.who').forEach((b) => (b.onclick = () => showMix(b.dataset.id)));
        }
      }
      timer = setTimeout(load, 3000);
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

  app.classList.remove('pick');
  app.classList.add('mix');
  app.innerHTML = header(`
    <div class="mixhead">
      <div>
        <h1 id="title">${esc(data.name)}</h1>
        <div class="route">Mezcla → <b id="out">${esc(data.out)}</b></div>
      </div>
      <button class="back" id="back">Cambiar</button>
    </div>`, true) + `
    <div id="body"></div>
    <p class="foot">Los nombres los pone el técnico</p>`;

  $('back').onclick = () => { store('rol', null); showPicker(); };

  // Estado por clave de canal (key). La salida del rol es la clave "out".
  let keys = [];                 // claves pintadas: canales de entrada y, al final, la salida (si hay)
  let inCount = 0;               // cuántos canales de entrada hay pintados
  let visible = 3;               // canales de entrada que caben por página
  let selKey = null;             // clave del último canal tocado o movido (recuadro rojo; nulo al entrar)
  let cur = { chs: data.channels || [], master: data.master ?? null }; // lo último recibido
  let fxDb = data.master?.fx?.value ?? null; // retorno FX en dB (-65..0), null = sin datos: la tira se ve deshabilitada
  const val = new Map();         // valor 0..1 o null (lo que muestra el fader)
  const touched = new Map();     // hasta cuándo ignorar lo que llega de TotalMix (guarda de 700 ms)
  const meter = new Map();       // nivel suavizado del medidor
  const target = new Map();      // nivel real 0..1
  const timers = new Map();      // envío diferido por canal
  const lastSent = new Map();
  const holdDb = new Map();      // pico retenido por clave, dB (ausente = sin señal)
  const holdAt = new Map();      // momento (ms) en que se fijó el último máximo
  const instDb = new Map();      // último nivel instantáneo por clave, dB (null = sin dato)
  const peakShown = (k) => (holdDb.get(k) == null ? '—' : fmtDb(holdDb.get(k)));

  const render = (i) => {
    const f = $(`fader-${i}`);
    if (!f) return;
    const v = val.get(keys[i]);
    const has = v != null;
    $(`cap-${i}`).style.bottom = `calc(10px + ${has ? v : 0} * (100% - 20px))`;
    $(`cap-${i}`).style.opacity = has ? 1 : 0.35;
    $(`fill-${i}`).style.height = `calc(${has ? v : 0} * (100% - 20px))`;
    const d = has ? faderToDb(v) : null;
    $(`db-${i}`).textContent = has ? fmtDb(d) : '—';
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
  // Recuadro rojo en el canal seleccionado (el último tocado o movido). Solo cambia la clase; no toca el fader.
  const applySel = () => keys.forEach((k, i) => {
    const s = $(`fader-${i}`)?.closest('.strip');
    if (s) s.classList.toggle('sel', k === selKey);
  });

  const change = (i, v) => {
    const k = keys[i];
    if (selKey !== k) { selKey = k; applySel(); }
    val.set(k, Math.min(1, Math.max(0, v)));
    touched.set(k, Date.now() + 700);
    render(i);
    clearTimeout(timers.get(k));
    if (Date.now() - (lastSent.get(k) || 0) > 40) push(k);
    else timers.set(k, setTimeout(() => push(k), 40));
  };

  const bindStrip = (i) => {
    const f = $(`fader-${i}`);
    if (!f) return; // salida sin datos: no hay fader
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

  // Fader FX (retorno de TotalMix, master.fx): pequeño, dentro de la salida, a la derecha del fader grande.
  // Lineal en dB de -65 a 0 (-65 = apagado, se ve -∞). Sin medidor. Su área de toque es propia (no mueve el grande).
  const fxFaderHtml = () => `<div class="fxf" id="fxfader" tabindex="0" role="slider" aria-label="Retorno FX" aria-valuemin="${FX_MIN}" aria-valuemax="0">
            <b class="fxv" id="fxv">—</b>
            <div class="fxtrack" id="fxtrack"><div class="rail"></div><div class="lvl"></div><div class="cap" id="fxcap"></div></div>
            <span class="fxl">FX</span>
          </div>`;
  // Lectura del FX: master.fx.value con un decimal (como los faders de canal), -65 es -∞.
  const fxShort = (d) => (d <= FX_MIN + 0.05 ? '−∞' : fmtDb(d));
  const renderFx = () => {
    const f = $('fxfader');
    if (!f) return;
    const has = fxDb != null && Number.isFinite(fxDb);
    const pos = has ? Math.min(1, Math.max(0, (fxDb - FX_MIN) / -FX_MIN)) : 0;
    f.classList.toggle('off', !has);
    f.style.setProperty('--p', pos);
    $('fxcap').style.bottom = `calc(${pos} * (100% - 17px))`;
    $('fxv').textContent = has ? fxShort(fxDb) : '—';
    f.setAttribute('aria-valuenow', has ? fxDb : FX_MIN);
    f.setAttribute('aria-valuetext', has ? (fxDb <= FX_MIN + 0.05 ? '−∞' : fxDb.toFixed(1) + ' dB') : 'sin dato');
  };
  // Envío del retorno FX, mismo ritmo que los canales (como mucho cada 40 ms). Va con k "fx".
  const pushFx = () => {
    if (fxDb == null) return;
    lastSent.set('fx', Date.now());
    fetch('/api/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ m: id, k: 'fx', v: fxDb }) })
      .then((r) => { if (err()) err().textContent = r.ok ? '' : 'El estudio no aceptó el cambio.'; })
      .catch(() => { if (err()) err().textContent = 'Sin conexión con el estudio.'; });
  };
  const setFx = (db) => {
    fxDb = db;
    touched.set('fx', Date.now() + 700);
    renderFx();
    clearTimeout(timers.get('fx'));
    if (Date.now() - (lastSent.get('fx') || 0) > 40) pushFx();
    else timers.set('fx', setTimeout(pushFx, 40));
  };
  const bindFx = () => {
    const f = $('fxfader');
    if (!f) return;
    const fromY = (y) => {
      if (fxDb == null) return; // sin datos: deshabilitada
      // La pista del FX es más corta que el área de toque: el dedo se mide contra el riel (clamp en los extremos).
      const r = $('fxtrack').getBoundingClientRect();
      const p = Math.min(1, Math.max(0, 1 - (y - r.top - 8.5) / (r.height - 17)));
      const db = Math.round((FX_MIN + p * -FX_MIN) * 10) / 10;
      setFx(db <= FX_MIN + 0.05 ? FX_MIN : db);
    };
    f.addEventListener('pointerdown', (e) => { f.setPointerCapture(e.pointerId); fromY(e.clientY); });
    f.addEventListener('pointermove', (e) => { if (f.hasPointerCapture(e.pointerId)) fromY(e.clientY); });
    f.addEventListener('keydown', (e) => {
      if (fxDb == null) return;
      const step = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setFx(Math.min(0, fxDb + step));
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setFx(Math.max(FX_MIN, fxDb - step));
      else return;
      e.preventDefault();
    });
  };

  const stripHtml = (c, i, extra = '') => `
      <div class="strip ${extra}">
        <div class="label" id="lab-${i}">${labelHtml(c)}</div>
        <div class="peak" id="pk-${i}">${peakShown(c.key)}</div>
        <div class="body">
          <div class="meter"><i id="m-${i}"></i><b class="hold" id="h-${i}"></b></div>
          <div class="fader" id="fader-${i}" tabindex="0" role="slider" aria-label="${esc(c.label)}" aria-valuemin="0" aria-valuemax="100">
            <div class="rail"></div>
            ${[-6, -10, -20, -40, -60].map((d) => `<div class="tick" data-db="${d}" style="bottom:calc(10px + ${dbPos(d)} * (100% - 20px))"><b>${Math.abs(d)}</b></div>`).join('')}
            <div class="tick zero" data-db="0" style="bottom:calc(10px + ${ZERO} * (100% - 20px))"><b>0</b></div>
            <div class="fill" id="fill-${i}"></div>
            <div class="cap" id="cap-${i}"></div>
          </div>
          ${extra === 'out' ? fxFaderHtml() : ''}
        </div>
        <div class="db" id="db-${i}"></div>
      </div>`;

  // Salida del rol sin datos de TotalMix: se ve, deshabilitada.
  const outOffHtml = `
      <div class="strip out off" aria-disabled="true">
        <div class="label"><b>Salida</b><small>sin datos</small></div>
        <div class="peak">—</div>
        <div class="body"></div>
        <div class="db">—</div>
      </div>`;

  const bodyHtml = (chs, master) => {
    const paged = chs.length > visible;
    const inputs = !chs.length
      ? `<div class="hint" style="padding:26px 8px">
          <b style="display:block;font:800 17px/1.25 var(--f-title);text-transform:uppercase;letter-spacing:.04em;color:var(--fg);margin-bottom:8px">Todavía no hay canales en tu mezcla.</b>
          Pídele al ingeniero que suba en TotalMix los canales que quieres escuchar.</div>`
      : `${paged ? `<div class="pager">
          <button class="pg" id="pgl" aria-label="Faders anteriores">‹</button>
          <span id="pgtxt"></span>
          <button class="pg" id="pgr" aria-label="Más faders">›</button>
        </div>` : ''}
        <div class="strips ${paged ? 'scroll' : 'fixed'}" id="strips" style="--n:${visible}">${chs.map((c, i) => stripHtml(c, i)).join('')}
        </div>`;
    const outs = master ? stripHtml(master, chs.length, 'out') : outOffHtml;
    return `<div class="rack">
      <div class="inputs">${inputs}</div>
      <div class="outs">${outs}</div>
    </div>
    <p id="err"></p>`;
  };

  // Mantiene valores y medidores de cada clave; quita lo que ya no existe.
  const sync = (all) => {
    const live = new Set(all.map((c) => c.key));
    for (const k of [...val.keys()]) {
      if (live.has(k)) continue;
      val.delete(k); meter.delete(k); target.delete(k); touched.delete(k); lastSent.delete(k);
      holdDb.delete(k); holdAt.delete(k); instDb.delete(k);
      clearTimeout(timers.get(k)); timers.delete(k);
    }
    all.forEach((c) => {
      if (!val.has(c.key)) val.set(c.key, c.value ?? null);
      if (!meter.has(c.key)) meter.set(c.key, 0);
      target.set(c.key, levelToMeter(c.level));
    });
  };

  const allOf = (chs, master) => (master ? [...chs, master] : chs);

  // Cuántos canales de entrada caben: el ancho del cuerpo menos la salida fija.
  const visibleNow = () => Math.max(1, Math.floor(($('body').clientWidth - OUT_W) / (STRIP_W + GAP)));

  // Pinta el cuerpo (paginado, faders o mensaje vacío) y la salida fija a la derecha.
  const mount = (chs, master) => {
    const prev = $('strips')?.scrollLeft ?? 0;
    visible = visibleNow();
    keys = allOf(chs, master).map((c) => c.key);
    inCount = chs.length;
    $('body').innerHTML = bodyHtml(chs, master);
    keys.forEach((_, i) => { render(i); bindStrip(i); });
    bindFx();
    renderFx();
    bindPager();
    const box = $('strips');
    if (box) box.scrollLeft = prev;
    applySel();
    fitScale();
  };

  // Paginado de a `visible` canales de entrada cuando hay más.
  const bindPager = () => {
    const box = $('strips');
    if (!box || inCount <= visible) return;
    const stepW = () => (box.clientWidth + GAP) / visible;
    const update = () => {
      if (!$('pgtxt')) return;
      const first = Math.round(box.scrollLeft / stepW());
      const last = Math.min(inCount, first + visible);
      $('pgtxt').textContent = `Faders ${first + 1}–${last} de ${inCount}`;
      $('pgl').disabled = first === 0;
      $('pgr').disabled = last >= inCount;
    };
    box.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
    $('pgl').onclick = () => box.scrollBy({ left: -stepW() * visible, behavior: reduce ? 'auto' : 'smooth' });
    $('pgr').onclick = () => box.scrollBy({ left: stepW() * visible, behavior: reduce ? 'auto' : 'smooth' });
    update();
  };

  sync(allOf(cur.chs, cur.master));
  mount(cur.chs, cur.master);

  // Al girar el celular o cambiar el ancho, se recalcula cuántos faders caben.
  let rt = 0;
  const onResize = () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (visibleNow() !== visible) mount(cur.chs, cur.master); fitScale(); }, 150);
  };
  window.addEventListener('resize', onResize);

  // Valores y niveles en vivo desde TotalMix.
  const es = new EventSource('/api/stream?m=' + encodeURIComponent(id));
  es.onopen = () => setStatus(true, 'Conectado');
  es.onerror = () => setStatus(false, 'Reconectando…');
  // El rol dejó de existir en TotalMix: volver a la lista de roles y olvidar el rol recordado.
  es.addEventListener('gone', () => { store('rol', null); showPicker(); });
  es.onmessage = (ev) => {
    setStatus(true, 'Conectado');
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.name) $('title').textContent = d.name;
    if (d.out != null) $('out').textContent = d.out;
    const chs = d.channels || [];
    const master = d.master ?? null;
    cur = { chs, master };
    // Retorno FX: el valor de TotalMix entra si el músico no lo acaba de mover (guarda de 700 ms, como los canales).
    if (Date.now() > (touched.get('fx') ?? 0)) {
      const nfx = master?.fx?.value ?? null;
      if (nfx !== fxDb) { fxDb = nfx; renderFx(); }
    }
    const all = allOf(chs, master);
    const same = all.length === keys.length && all.every((c, i) => c.key === keys[i]);
    sync(all);
    if (!same) mount(chs, master); // se añadieron, quitaron o reordenaron canales: repintar conservando valores
    all.forEach((c, i) => {
      const lab = $(`lab-${i}`);
      const html = labelHtml(c);
      if (lab && lab.innerHTML !== html) lab.innerHTML = html;
      const k = c.key;
      // Pico retenido: sube al máximo nuevo y, si no, espera en loop() a que pase PEAK_HOLD_MS.
      const lv = c.level == null || !Number.isFinite(c.level) ? null : c.level;
      instDb.set(k, lv);
      if (lv != null && lv > SIGNAL_DB && (holdDb.get(k) == null || lv >= holdDb.get(k))) {
        holdDb.set(k, lv);
        holdAt.set(k, performance.now());
      }
      const pk = $(`pk-${i}`);
      if (pk) pk.textContent = peakShown(k);
      const f = $(`fader-${i}`);
      if (f) f.setAttribute('aria-label', c.label ?? '');
      if (c.value != null && Date.now() > (touched.get(k) ?? 0) && c.value !== val.get(k)) {
        val.set(k, c.value);
        render(i);
      }
    });
  };

  let raf = 0;
  let lastT = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    keys.forEach((k, i) => {
      const t = target.get(k) ?? 0;
      const m = meter.get(k) ?? 0;
      const next = m + (t - m) * (t > m ? 0.7 : 0.15);
      meter.set(k, next);
      const el = $(`m-${i}`);
      if (el) { el.style.height = (next * 100).toFixed(1) + '%'; el.style.setProperty('--h', el.parentElement.clientHeight + 'px'); }

      // Rayita de pico retenido: quieta PEAK_HOLD_MS, luego baja hasta el nivel actual.
      let h = holdDb.get(k);
      if (h != null) {
        if (now - (holdAt.get(k) ?? 0) > PEAK_HOLD_MS) h -= PEAK_FALL_DB_PER_S * dt;
        const cur = instDb.get(k);
        if (cur != null && h < cur) h = cur;
        if (h <= SIGNAL_DB) h = null;
        if (h == null) holdDb.delete(k); else holdDb.set(k, h);
      }
      const hel = $(`h-${i}`);
      if (hel) {
        if (h == null) hel.style.display = 'none';
        else { hel.style.display = 'block'; hel.style.bottom = `calc(${levelToMeter(h)} * 100%)`; }
      }
      const pk = $(`pk-${i}`);
      const txt = peakShown(k);
      if (pk && pk.textContent !== txt) pk.textContent = txt;
    });
    raf = requestAnimationFrame(loop);
  };
  loop();

  cleanup = () => {
    es.close();
    cancelAnimationFrame(raf);
    clearTimeout(rt);
    window.removeEventListener('resize', onResize);
    for (const t of timers.values()) clearTimeout(t);
  };
}

const start = new URLSearchParams(location.search).get('m') || recall('rol');
start ? showMix(start) : showPicker();
