// Punto de entrada: estado, enlace de controles, animación y análisis anual.

import { DEFAULT_CONFIG, mergeConfig, cloneConfig, solarState, computeInstant, profileAngle, awningSection } from './model.js';
import { daysInYear } from './solar.js';
import { SectionScene } from './scene.js';
import { SiteMap } from './map.js';
import { Heatmap, DailyChart, METRICS, seriesFor, fmtTime, fmtDate } from './charts.js';

const STORAGE_KEY = 'simulador-solar-escaparate:v1';
const $ = (id) => document.getElementById(id);

// ---------- Enlace compartible: estado completo en el fragmento #c=<base64url(JSON)> ----------
function encodeShare(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeShare(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

function readShared() {
  const m = location.hash.match(/[#&]c=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    return decodeShare(m[1]);
  } catch {
    return null;
  }
}
const shared = readShared();
// Pegar un enlace compartido en una pestaña ya abierta solo cambia el fragmento: recargar para aplicarlo
window.addEventListener('hashchange', () => {
  if (readShared()) location.reload();
});

// ---------- Configuración inicial: localStorage < enlace compartido < parámetros de la URL ----------
function loadConfig() {
  let cfg;
  try {
    cfg = mergeConfig(shared ? shared.cfg : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    cfg = cloneConfig(DEFAULT_CONFIG);
  }
  // ?lat=28.48&lon=-16.31&az=180&sep=8&hopp=12&hwin=3&tz=Atlantic/Canary
  const q = new URLSearchParams(location.search);
  const num = (k, setter) => {
    const v = parseFloat(q.get(k));
    if (Number.isFinite(v)) setter(v);
  };
  num('lat', (v) => (cfg.location.lat = v));
  num('lon', (v) => (cfg.location.lon = v));
  num('az', (v) => (cfg.facade.azimuth = v));
  num('sep', (v) => (cfg.street.separation = v));
  num('hopp', (v) => (cfg.street.oppositeHeight = v));
  num('hwin', (v) => (cfg.room.windowHeight = v));
  if (q.get('tz')) cfg.location.tz = q.get('tz');
  return cfg;
}

const saveConfig = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cfg));
  } catch {
    /* almacenamiento no disponible */
  }
};

const today = new Date();
const state = {
  cfg: loadConfig(),
  doy: Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(today.getFullYear(), 0, 1)) / 86400000) + 1,
  minutes: 12 * 60,
  playing: false,
  annual: null,
};
if (shared) {
  if (Number.isFinite(shared.doy)) state.doy = Math.min(Math.max(1, Math.round(shared.doy)), daysInYear(state.cfg.location.year));
  if (Number.isFinite(shared.minutes)) state.minutes = Math.min(Math.max(0, shared.minutes), 1435);
  for (const id of ['metric', 'scenario', 'cut-mode']) {
    const el = $(id);
    if (shared.view && [...el.options].some((o) => o.value === shared.view[id])) el.value = shared.view[id];
  }
  // Quitar el fragmento: a partir de aquí manda lo que el usuario cambie (se guarda en localStorage)
  history.replaceState(null, '', location.pathname + location.search);
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o[k], obj);
const setPath = (obj, path, v) => {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = v;
};

// ---------- Escena, mapa y gráficas ----------
const scene = new SectionScene($('viewport'));
const heatmap = new Heatmap($('heatmap'), $('tt-heat'), $('heat-scale'), (doy, minutes) => {
  state.doy = doy;
  state.minutes = Math.round(minutes / 5) * 5;
  update();
});
const daily = new DailyChart($('daily'), $('tt-daily'));

const MAP_KEYS = {
  lat: 'location.lat',
  lon: 'location.lon',
  azimuth: 'facade.azimuth',
  separation: 'street.separation',
  oppositeHeight: 'street.oppositeHeight',
  buildingHeight: 'facade.buildingHeight',
};

let siteMap = null;
const mapStatus = (msg, kind = '') => {
  $('map-status').textContent = msg;
  $('map-status').className = 'status ' + kind;
};
try {
  siteMap = new SiteMap($('map'), {
    onChange: (patch, opts = {}) => {
      for (const [k, v] of Object.entries(patch)) {
        if (MAP_KEYS[k]) setPath(state.cfg, MAP_KEYS[k], Math.round(v * 1e6) / 1e6);
      }
      configChanged({ live: opts.live });
    },
    onStatus: mapStatus,
  });
} catch (e) {
  mapStatus('No se pudo cargar el mapa: ' + e.message, 'error');
}

// ---------- Controles de parámetros ----------
const fields = [...document.querySelectorAll('[data-path]')];

function writeFields() {
  for (const el of fields) {
    if (el === document.activeElement && el.type === 'number') continue;
    const v = getPath(state.cfg, el.dataset.path);
    if (el.type === 'checkbox') el.checked = v;
    else el.value = v;
  }
}

function validate(cfg) {
  const r = cfg.room;
  r.ceilingHeight = Math.max(2, r.ceilingHeight);
  r.windowHeight = Math.min(Math.max(0.3, r.windowHeight), r.ceilingHeight);
  r.sillHeight = Math.min(Math.max(0, r.sillHeight), r.windowHeight - 0.2);
  r.windowWidth = Math.max(0.3, r.windowWidth);
  r.width = Math.max(r.width, r.windowWidth);
  r.depth = Math.max(1, r.depth);
  r.glassTransmittance = Math.min(1, Math.max(0, r.glassTransmittance));
  cfg.street.separation = Math.max(0.5, cfg.street.separation);
  cfg.street.oppositeHeight = Math.max(0, cfg.street.oppositeHeight);
  cfg.facade.azimuth = ((cfg.facade.azimuth % 360) + 360) % 360;
  cfg.facade.buildingHeight = Math.max(r.ceilingHeight + 0.3, cfg.facade.buildingHeight);
  cfg.facade.wallThickness = Math.min(1, Math.max(0, cfg.facade.wallThickness));
  const a = cfg.awning;
  a.angle = Math.min(90, Math.max(0, a.angle));
  a.length = Math.max(0, a.length);
  a.transmittance = Math.min(1, Math.max(0, a.transmittance));
  cfg.location.lat = Math.min(89.9, Math.max(-89.9, cfg.location.lat));
  cfg.location.year = Math.round(cfg.location.year);
}

for (const el of fields) {
  const handler = () => {
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.tagName === 'SELECT') v = el.value;
    else {
      v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
    }
    setPath(state.cfg, el.dataset.path, v);
    configChanged();
  };
  el.addEventListener(el.type === 'range' ? 'input' : 'change', handler);
  if (el.type === 'number') el.addEventListener('input', handler);
}

const AZ_NAMES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

function configChanged({ live = false } = {}) {
  validate(state.cfg);
  writeFields();
  const c = state.cfg;
  $('az-name').textContent = `La fachada mira al ${AZ_NAMES[Math.round(c.facade.azimuth / 22.5) % 16]}`;
  const sec = awningSection(c);
  $('awning-geo').textContent = c.awning.enabled
    ? `Vuelo horizontal ${(-sec.tip.x - c.facade.wallThickness).toFixed(2)} m · borde inferior a ${sec.tip.y.toFixed(2)} m del suelo` +
      (sec.tip.y < 2.2 ? ' — ¡ojo, por debajo de 2,2 m!' : '')
    : 'Toldo recogido.';
  const days = daysInYear(c.location.year);
  $('day').max = days;
  state.doy = Math.min(state.doy, days);
  buildMonthTicks();
  scene.setConfig(c, false);
  if (siteMap) siteMap.update({ lat: c.location.lat, lon: c.location.lon, azimuth: c.facade.azimuth, separation: c.street.separation });
  update();
  if (!live) {
    saveConfig();
    scheduleAnnual();
  }
}

// ---------- Tiempo ----------
function buildMonthTicks() {
  const year = state.cfg.location.year;
  const days = daysInYear(year);
  const el = $('month-ticks');
  el.innerHTML = '';
  ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].forEach((m, i) => {
    const doy = Math.round((Date.UTC(year, i, 15) - Date.UTC(year, 0, 1)) / 86400000) + 1;
    const s = document.createElement('span');
    s.textContent = m;
    s.style.left = `${((doy - 1) / (days - 1)) * 100}%`;
    el.appendChild(s);
  });
}

$('hour').addEventListener('input', (e) => {
  state.minutes = +e.target.value;
  update();
});
$('day').addEventListener('input', (e) => {
  state.doy = +e.target.value;
  update();
});

function speedInfo() {
  const p = +$('speed').value;
  if ($('play-mode').value === 'days') {
    const dps = Math.pow(10, p / 50 - 0.5); // 0,3 … 32 días/s
    return { dps, text: `${dps < 10 ? dps.toFixed(1) : Math.round(dps)} días/s` };
  }
  const mps = Math.pow(10, p / 25); // 1 … 10 000 min/s
  const text = mps < 60 ? `${mps.toFixed(mps < 10 ? 1 : 0)} min/s` : mps < 1440 ? `${(mps / 60).toFixed(1)} h/s` : `${(mps / 1440).toFixed(1)} días/s`;
  return { mps, text };
}
const showSpeed = () => ($('speed-out').textContent = speedInfo().text);
$('speed').addEventListener('input', showSpeed);
$('play-mode').addEventListener('change', showSpeed);

$('play').addEventListener('click', () => {
  state.playing = !state.playing;
  $('play').textContent = state.playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', state.playing ? 'Pausa' : 'Reproducir');
  last = performance.now();
});

let last = performance.now();
let dayAcc = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.playing) {
    const days = daysInYear(state.cfg.location.year);
    const sp = speedInfo();
    if ($('play-mode').value === 'days') {
      dayAcc += sp.dps * dt;
      const whole = Math.floor(dayAcc);
      dayAcc -= whole;
      if (whole) state.doy = ((state.doy - 1 + whole) % days) + 1;
    } else {
      let mps = sp.mps;
      if ($('skip-night').checked && state.current && state.current.altitude < -2) mps *= 30;
      state.minutes += mps * dt;
      while (state.minutes >= 1440) {
        state.minutes -= 1440;
        state.doy = (state.doy % days) + 1;
      }
    }
    update();
  }
  requestAnimationFrame(tick);
}

// ---------- Actualización del instante ----------
function update() {
  const c = state.cfg;
  const st = solarState(c, state.doy, state.minutes);
  const inst = computeInstant(c, st.s, st.dni, { ny: 50, nz: 21, useAwning: true });
  const instN = c.awning.enabled ? computeInstant(c, st.s, st.dni, { ny: 50, nz: 21, useAwning: false }) : inst;
  state.current = st;
  scene.setSun(st, inst);

  $('hour').value = Math.round(state.minutes / 5) * 5;
  $('day').value = state.doy;
  const tzName = c.location.tz === 'SOLAR' ? 'hora solar' : c.location.tz;
  $('hour-out').textContent = `${fmtTime(state.minutes)} (${tzName.split('/').pop().replace('_', ' ')})`;
  $('day-out').textContent = `${fmtDate(c.location.year, state.doy)} ${c.location.year} · día ${state.doy}`;

  const prof = profileAngle(st.s);
  const facing = st.altitude > 0 && st.s.x < 0;
  $('readout').innerHTML =
    `<b>${fmtDate(c.location.year, state.doy)} · ${fmtTime(state.minutes)}</b><br>` +
    `Sol: altura ${st.altitude.toFixed(1)}° · azimut ${st.azimuth.toFixed(1)}°<br>` +
    (st.altitude <= 0
      ? 'Sol bajo el horizonte'
      : facing
        ? `Ángulo de perfil ${prof.toFixed(1)}° · DNI ${Math.round(st.dni)} W/m²`
        : 'El sol está detrás de la fachada');

  const pct = (v) => `${Math.round(v * 100)} %`;
  const rows = [
    ['Altura del sol', `${st.altitude.toFixed(1)}°`],
    ['Azimut del sol', `${st.azimuth.toFixed(1)}°`],
    ['Ángulo de perfil', facing ? `${prof.toFixed(1)}°` : '—'],
    ['Irradiancia directa (DNI)', `${Math.round(st.dni)} W/m²`],
    ['Ventana soleada', `${pct(inst.litFraction)}${c.awning.enabled ? ` (sin toldo ${pct(instN.litFraction)})` : ''}`],
    ['Potencia directa entrante', `${Math.round(inst.power)} W${c.awning.enabled ? ` (sin toldo ${Math.round(instN.power)} W)` : ''}`],
    ['Penetración máx. en suelo', `${inst.depth.toFixed(2)} m${c.awning.enabled ? ` (sin toldo ${instN.depth.toFixed(2)} m)` : ''}`],
    ['Área soleada en suelo', `${inst.floorArea.toFixed(2)} m²`],
    ['Soleado en pared del fondo', `${inst.backWallArea.toFixed(2)} m²`],
  ];
  $('instant').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  heatmap.draw(state.doy, state.minutes);
  daily.set(state.annual, $('metric').value, state.doy, state.minutes);
  $('daily-caption').textContent = `${METRICS[$('metric').value].label} el ${fmtDate(c.location.year, state.doy)}`;
}

// ---------- Análisis anual en worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobId = 0;
let annualTimer = null;

function scheduleAnnual() {
  clearTimeout(annualTimer);
  annualTimer = setTimeout(() => {
    jobId++;
    $('annual-status').textContent = 'Calculando…';
    worker.postMessage({ id: jobId, cfg: state.cfg, stepMin: 15 });
  }, 400);
}

worker.onmessage = (ev) => {
  const { id, progress, result } = ev.data;
  if (id !== jobId) return;
  if (progress !== undefined) {
    $('annual-status').textContent = `Calculando… ${Math.round(progress * 100)} %`;
    return;
  }
  state.annual = result;
  $('annual-status').textContent = '';
  refreshAnalysis();
};
worker.onerror = (e) => ($('annual-status').textContent = 'Error en el cálculo anual: ' + e.message);

function refreshAnalysis() {
  const data = state.annual;
  if (!data) return;
  const metric = $('metric').value;
  heatmap.setData(data, seriesFor(data, metric, $('scenario').value), metric, state.cfg.location.year);
  renderTiles(data);
  update();
}
$('metric').addEventListener('change', refreshAnalysis);
$('scenario').addEventListener('change', refreshAnalysis);
window.addEventListener('resize', () => update());

function renderTiles(d) {
  const hStep = d.stepMin / 60;
  let eA = 0, eN = 0, hA = 0, hN = 0, maxA = 0, maxN = 0, maxAi = 0, maxNi = 0;
  for (let i = 0; i < d.powerA.length; i++) {
    eA += d.powerA[i] * hStep;
    eN += d.powerN[i] * hStep;
    if (d.fracA[i] > 0.05) hA += hStep;
    if (d.fracN[i] > 0.05) hN += hStep;
    if (d.depthA[i] > maxA) { maxA = d.depthA[i]; maxAi = i; }
    if (d.depthN[i] > maxN) { maxN = d.depthN[i]; maxNi = i; }
  }
  const year = state.cfg.location.year;
  const when = (i) => `${fmtDate(year, Math.floor(i / d.steps) + 1)} ${fmtTime(((i % d.steps) + 0.5) * d.stepMin)}`;
  const aw = state.cfg.awning.enabled;
  const tiles = [
    ['Energía directa anual', `${Math.round(eA / 1000)} kWh`, aw ? `sin toldo ${Math.round(eN / 1000)} kWh` : 'toldo recogido'],
    ['Reducción por el toldo', aw && eN > 0 ? `${Math.round((1 - eA / eN) * 100)} %` : '—', aw ? `${Math.round((eN - eA) / 1000)} kWh/año menos` : ''],
    ['Horas con sol directo', `${Math.round(hA)} h/año`, aw ? `sin toldo ${Math.round(hN)} h` : ''],
    ['Penetración máxima', `${maxA.toFixed(2)} m`, maxA > 0 ? when(maxAi) : ''],
    ['Penetración máx. sin toldo', `${maxN.toFixed(2)} m`, maxN > 0 ? when(maxNi) : ''],
  ];
  $('tiles').innerHTML = tiles
    .map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
    .join('');
}

// ---------- Vista, búsqueda, detección OSM, import/export ----------
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => scene.resetView(b.dataset.view)));
$('cut-mode').addEventListener('change', (e) => {
  scene.setCutMode(e.target.value);
  scene.resetView('section');
});

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search').value.trim();
  if (!q || !siteMap) return;
  mapStatus('Buscando…');
  try {
    const r = await siteMap.search(q);
    mapStatus(r.name, 'ok');
    state.cfg.location.lat = r.lat;
    state.cfg.location.lon = r.lon;
    configChanged();
  } catch (err) {
    mapStatus('Búsqueda: ' + err.message, 'error');
  }
});

$('btn-detect').addEventListener('click', async () => {
  if (!siteMap) return;
  mapStatus('Consultando edificios en OpenStreetMap…');
  $('btn-detect').disabled = true;
  try {
    const { patch, msg } = await siteMap.detect();
    for (const [k, v] of Object.entries(patch)) if (MAP_KEYS[k]) setPath(state.cfg, MAP_KEYS[k], v);
    configChanged();
    mapStatus(msg, 'ok');
  } catch (err) {
    mapStatus('Detección: ' + err.message, 'error');
  } finally {
    $('btn-detect').disabled = false;
  }
});

function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2500);
}

$('btn-share').addEventListener('click', async () => {
  const payload = {
    v: 1,
    cfg: state.cfg,
    doy: state.doy,
    minutes: Math.round(state.minutes),
    view: { metric: $('metric').value, scenario: $('scenario').value, 'cut-mode': $('cut-mode').value },
  };
  const url = `${location.origin}${location.pathname}#c=${encodeShare(payload)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Enlace copiado: abre la web con esta configuración, día y hora');
  } catch {
    window.prompt('Copia este enlace:', url);
  }
});

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'simulacion-solar.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    state.cfg = mergeConfig(JSON.parse(await f.text()));
    buildMonthTicks();
    configChanged();
    scene.resetView('section');
    if (siteMap) siteMap.update({ ...state.cfg.location, azimuth: state.cfg.facade.azimuth, separation: state.cfg.street.separation }, true);
  } catch (err) {
    alert('JSON no válido: ' + err.message);
  }
  e.target.value = '';
});
$('btn-reset').addEventListener('click', () => {
  state.cfg = cloneConfig(DEFAULT_CONFIG);
  buildMonthTicks();
  configChanged();
  scene.resetView('section');
  if (siteMap) siteMap.update({ ...state.cfg.location, azimuth: state.cfg.facade.azimuth, separation: state.cfg.street.separation }, true);
});

// ---------- Arranque ----------
window.sim = { state, scene, update, configChanged }; // acceso para depuración desde la consola
buildMonthTicks();
showSpeed();
scene.setCutMode($('cut-mode').value);
configChanged();
scene.resetView('section');
if (siteMap) {
  const c = state.cfg;
  siteMap.update({ lat: c.location.lat, lon: c.location.lon, azimuth: c.facade.azimuth, separation: c.street.separation }, true);
  setTimeout(() => siteMap.invalidate(), 200);
}
requestAnimationFrame(tick);
