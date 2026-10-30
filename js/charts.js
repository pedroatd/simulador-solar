// Gráficas en canvas del análisis anual: mapa de calor día × hora y curva del día seleccionado.

import { doyToDate } from './solar.js';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const METRICS = {
  power: { label: 'Potencia', unit: 'W', fmt: (v) => `${Math.round(v)} W` },
  depth: { label: 'Penetración', unit: 'm', fmt: (v) => `${v.toFixed(2)} m` },
  frac: { label: 'Ventana soleada', unit: '%', fmt: (v) => `${Math.round(v)} %` },
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hexToRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ramp() {
  const stops = css('--seq').split(',').map((s) => hexToRgb(s.trim()));
  return (t) => {
    t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t));
    const f = t - i;
    const a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
}

export const fmtTime = (min) => {
  const m = Math.round(min) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function fmtDate(year, doy) {
  const d = doyToDate(year, doy);
  return `${d.day} ${MONTHS[d.month - 1]}`;
}

/** Serie (Float32Array days*steps) para métrica y escenario. */
export function seriesFor(data, metric, scenario) {
  const key = { power: 'power', depth: 'depth', frac: 'frac' }[metric];
  const scale = metric === 'frac' ? 100 : 1;
  const A = data[key + 'A'], N = data[key + 'N'];
  const out = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) {
    out[i] = scale * (scenario === 'A' ? A[i] : scenario === 'N' ? N[i] : N[i] - A[i]);
  }
  return out;
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export class Heatmap {
  constructor(canvas, tooltip, scaleEl, onPick) {
    this.canvas = canvas;
    this.tt = tooltip;
    this.scaleEl = scaleEl;
    this.m = { l: 38, r: 8, t: 6, b: 20 };
    canvas.addEventListener('mousemove', (e) => this.hover(e));
    canvas.addEventListener('mouseleave', () => (this.tt.style.display = 'none'));
    canvas.addEventListener('click', (e) => {
      const c = this.cellAt(e);
      if (c) onPick(c.doy, c.minutes);
    });
  }

  setData(data, values, metric, year) {
    this.data = data;
    this.values = values;
    this.metric = metric;
    this.year = year;
    let max = 0;
    for (const v of values) if (v > max) max = v;
    this.max = max;
    const color = ramp();
    const empty = hexToRgb(css('--empty'));
    const off = document.createElement('canvas');
    off.width = data.days;
    off.height = data.steps;
    const g = off.getContext('2d');
    const img = g.createImageData(data.days, data.steps);
    for (let d = 0; d < data.days; d++) {
      for (let k = 0; k < data.steps; k++) {
        const v = values[d * data.steps + k];
        const c = v > max * 1e-3 && max > 0 ? color(v / max) : empty;
        const p = (k * data.days + d) * 4;
        img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.image = off;
    const stops = css('--seq');
    this.scaleEl.innerHTML = `<span>0</span><span class="bar" style="background:linear-gradient(90deg,${stops})"></span><span>${METRICS[metric].fmt(max)}</span>`;
  }

  cellAt(e) {
    if (!this.data) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const { l, r: mr, t, b } = this.m;
    const pw = r.width - l - mr, ph = r.height - t - b;
    if (x < l || x > l + pw || y < t || y > t + ph) return null;
    const d = Math.min(this.data.days - 1, Math.floor(((x - l) / pw) * this.data.days));
    const k = Math.min(this.data.steps - 1, Math.floor(((y - t) / ph) * this.data.steps));
    return { doy: d + 1, k, minutes: (k + 0.5) * this.data.stepMin, x, y, v: this.values[d * this.data.steps + k] };
  }

  hover(e) {
    const c = this.cellAt(e);
    if (!c) return (this.tt.style.display = 'none');
    this.tt.style.display = 'block';
    this.tt.innerHTML = `${fmtDate(this.year, c.doy)} · ${fmtTime(c.minutes)}<br><b>${METRICS[this.metric].fmt(c.v)}</b>`;
    const w = this.canvas.clientWidth;
    this.tt.style.left = Math.min(c.x + 12, w - 130) + 'px';
    this.tt.style.top = c.y + 12 + 'px';
  }

  draw(doy, minutes) {
    const { g, w, h } = setupCanvas(this.canvas);
    const { l, r, t, b } = this.m;
    const pw = w - l - r, ph = h - t - b;
    const ink2 = css('--ink-2'), ink = css('--ink');
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = ink2;
    if (!this.image) {
      g.fillText('Calculando…', l + 8, t + 20);
      return;
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(this.image, l, t, pw, ph);
    // Ejes
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let hr = 0; hr <= 24; hr += 3) g.fillText(`${hr}h`, l - 5, t + (hr / 24) * ph);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let m = 0; m < 12; m++) {
      const doy0 = Math.round((Date.UTC(this.year, m, 1) - Date.UTC(this.year, 0, 1)) / 86400000) + 1;
      const doy1 = Math.round((Date.UTC(this.year, m + 1, 1) - Date.UTC(this.year, 0, 1)) / 86400000) + 1;
      g.fillText(MONTHS[m], l + (((doy0 + doy1) / 2 - 1) / this.data.days) * pw, t + ph + 5);
    }
    // Cursor del instante actual
    const cx = l + ((doy - 0.5) / this.data.days) * pw;
    const cy = t + (minutes / 1440) * ph;
    g.strokeStyle = ink;
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(cx, t); g.lineTo(cx, t + ph);
    g.moveTo(l, cy); g.lineTo(l + pw, cy);
    g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.arc(cx, cy, 4, 0, Math.PI * 2);
    g.stroke();
  }
}

export class DailyChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tt = tooltip;
    this.m = { l: 48, r: 10, t: 10, b: 22 };
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.redraw();
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.tt.style.display = 'none';
      this.redraw();
    });
  }

  set(data, metric, doy, minutes) {
    this.args = { data, metric, doy, minutes };
    this.redraw();
  }

  redraw() {
    if (!this.args) return;
    const { data, metric, doy, minutes } = this.args;
    const { g, w, h } = setupCanvas(this.canvas);
    const { l, r, t, b } = this.m;
    const pw = w - l - r, ph = h - t - b;
    const ink2 = css('--ink-2'), grid = css('--grid'), ink = css('--ink');
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = ink2;
    if (!data) {
      g.fillText('Calculando…', l + 8, t + 20);
      return;
    }
    const sA = seriesFor(data, metric, 'A'), sN = seriesFor(data, metric, 'N');
    const off = (doy - 1) * data.steps;
    let max = 0;
    for (let k = 0; k < data.steps; k++) max = Math.max(max, sA[off + k], sN[off + k]);
    const top = niceMax(max);
    const X = (min) => l + (min / 1440) * pw;
    const Y = (v) => t + ph - (v / top) * ph;

    // Rejilla y ejes
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (top * i) / 4;
      g.beginPath();
      g.moveTo(l, Y(v)); g.lineTo(l + pw, Y(v));
      g.stroke();
      g.fillText(metric === 'power' ? Math.round(v) : metric === 'frac' ? Math.round(v) : v.toFixed(1), l - 6, Y(v));
    }
    g.save();
    g.translate(11, t + ph / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillText(METRICS[metric].unit, 0, 0);
    g.restore();
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let hr = 0; hr <= 24; hr += 3) g.fillText(`${hr}h`, X(hr * 60), t + ph + 6);

    const line = (s, color, dash) => {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.setLineDash(dash);
      g.lineJoin = 'round';
      g.beginPath();
      for (let k = 0; k < data.steps; k++) {
        const x = X((k + 0.5) * data.stepMin), y = Y(s[off + k]);
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
    };
    line(sN, css('--series-none'), [5, 4]);
    line(sA, css('--series-with'), []);

    // Hora actual
    g.strokeStyle = ink;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(X(minutes), t); g.lineTo(X(minutes), t + ph);
    g.stroke();

    // Hover
    if (this.hoverX != null && this.hoverX >= l && this.hoverX <= l + pw) {
      const k = Math.min(data.steps - 1, Math.max(0, Math.floor(((this.hoverX - l) / pw) * data.steps)));
      const x = X((k + 0.5) * data.stepMin);
      g.strokeStyle = ink2;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, t); g.lineTo(x, t + ph);
      g.stroke();
      g.setLineDash([]);
      for (const [s, c] of [[sN, css('--series-none')], [sA, css('--series-with')]]) {
        g.fillStyle = c;
        g.strokeStyle = css('--surface');
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, Y(s[off + k]), 4, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      const f = METRICS[metric].fmt;
      this.tt.style.display = 'block';
      this.tt.innerHTML = `${fmtTime((k + 0.5) * data.stepMin)}<br>Sin toldo: <b>${f(sN[off + k])}</b><br>Con toldo: <b>${f(sA[off + k])}</b>`;
      this.tt.style.left = Math.min(x + 12, w - 150) + 'px';
      this.tt.style.top = t + 8 + 'px';
    }
  }
}
