// Mapa OpenStreetMap (Leaflet): ubicación, orientación de la fachada y detección automática
// de la calle con datos de edificios de OSM (API Overpass).

/* global L */

// Servidores Overpass públicos; si uno falla (saturación frecuente) se prueba el siguiente
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`Overpass ${res.status}`);
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? new Error('los servidores Overpass no responden; inténtalo más tarde') : e;
    }
  }
  throw lastErr;
}
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const ARROW_LEN = 22; // m

const R = 6378137;
const toRad = (d) => (d * Math.PI) / 180;

/** Proyección local equirectangular (metros) alrededor de un origen. */
function projector(lat0, lon0) {
  const kx = R * Math.cos(toRad(lat0)) * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  return {
    fwd: (lat, lon) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky }),
    inv: (x, y) => ({ lat: lat0 + y / ky, lon: lon0 + x / kx }),
  };
}

function offset(lat, lon, azDeg, dist) {
  const p = projector(lat, lon);
  return p.inv(Math.sin(toRad(azDeg)) * dist, Math.cos(toRad(azDeg)) * dist);
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function closestOnSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
  const q = { x: a.x + t * vx, y: a.y + t * vy };
  return { q, d: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** Distancia a lo largo del rayo o + k·dir hasta el segmento ab (o null). */
function raySegment(o, dir, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y;
  const den = dir.x * ey - dir.y * ex;
  if (Math.abs(den) < 1e-12) return null;
  const k = ((a.x - o.x) * ey - (a.y - o.y) * ex) / den;
  const u = ((a.x - o.x) * dir.y - (a.y - o.y) * dir.x) / den;
  return k > 0.3 && u >= 0 && u <= 1 ? k : null;
}

function buildingHeight(tags = {}) {
  const h = parseFloat(String(tags.height || '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0) return { value: h, source: 'height' };
  const lv = parseFloat(tags['building:levels']);
  if (Number.isFinite(lv) && lv > 0) {
    const roof = parseFloat(tags['roof:levels']) || 0;
    return { value: Math.round((lv + roof) * 3 * 10) / 10, source: 'building:levels × 3 m' };
  }
  return null;
}

export class SiteMap {
  /**
   * @param {HTMLElement} el
   * @param {{onChange:(patch:object)=>void, onStatus:(msg:string, kind?:string)=>void}} hooks
   */
  constructor(el, hooks) {
    this.hooks = hooks;
    this.map = L.map(el, { zoomControl: true }).setView([28.4874, -16.3159], 18);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);

    this.marker = L.marker([0, 0], { draggable: true, title: 'Ventana' }).addTo(this.map);
    this.arrow = L.polyline([], { color: '#d7263d', weight: 4 }).addTo(this.map);
    this.opposite = L.polyline([], { color: '#1f6feb', weight: 4, dashArray: '6 6' }).addTo(this.map);
    this.facadeLine = L.polyline([], { color: '#222', weight: 3 }).addTo(this.map);
    this.handle = L.marker([0, 0], {
      draggable: true,
      icon: L.divIcon({ className: 'arrow-handle', iconSize: [16, 16] }),
      title: 'Arrastra para orientar la fachada',
    }).addTo(this.map);
    this.buildingsLayer = L.layerGroup().addTo(this.map);

    this.map.on('click', (e) => this.hooks.onChange({ lat: e.latlng.lat, lon: e.latlng.lng }));
    this.marker.on('drag', (e) => {
      const ll = e.target.getLatLng();
      this.hooks.onChange({ lat: ll.lat, lon: ll.lng }, { live: true });
    });
    this.marker.on('dragend', (e) => {
      const ll = e.target.getLatLng();
      this.hooks.onChange({ lat: ll.lat, lon: ll.lng });
    });
    const handleAz = (e) => {
      const ll = e.target.getLatLng();
      const p = projector(this.lat, this.lon).fwd(ll.lat, ll.lng);
      const az = ((Math.atan2(p.x, p.y) * 180) / Math.PI + 360) % 360;
      return Math.round(az * 10) / 10;
    };
    this.handle.on('drag', (e) => this.hooks.onChange({ azimuth: handleAz(e) }, { live: true }));
    this.handle.on('dragend', (e) => this.hooks.onChange({ azimuth: handleAz(e) }));
  }

  /** Redibuja marcador, flecha de la normal exterior y fachada de enfrente. */
  update({ lat, lon, azimuth, separation }, recenter = false) {
    this.lat = lat;
    this.lon = lon;
    this.az = azimuth;
    this.marker.setLatLng([lat, lon]);
    const tip = offset(lat, lon, azimuth, Math.max(ARROW_LEN, separation * 0.6));
    this.arrow.setLatLngs([[lat, lon], [tip.lat, tip.lon]]);
    this.handle.setLatLng([tip.lat, tip.lon]);
    const fa = offset(lat, lon, azimuth + 90, 15), fb = offset(lat, lon, azimuth - 90, 15);
    this.facadeLine.setLatLngs([[fa.lat, fa.lon], [fb.lat, fb.lon]]);
    const c = offset(lat, lon, azimuth, separation);
    const a = offset(c.lat, c.lon, azimuth + 90, 15), b = offset(c.lat, c.lon, azimuth - 90, 15);
    this.opposite.setLatLngs([[a.lat, a.lon], [b.lat, b.lon]]);
    if (recenter) this.map.setView([lat, lon], Math.max(this.map.getZoom(), 17));
  }

  invalidate() {
    this.map.invalidateSize();
  }

  async search(q) {
    const url = `${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const data = await res.json();
    if (!data.length) throw new Error('Sin resultados');
    const lat = +data[0].lat, lon = +data[0].lon;
    this.map.setView([lat, lon], 18);
    return { lat, lon, name: data[0].display_name };
  }

  /**
   * Busca en OSM el edificio cuya fachada está más cerca del marcador, calcula su normal exterior
   * y lanza un rayo a lo largo de ella para encontrar el edificio de enfrente (distancia y altura).
   */
  async detect() {
    const { lat, lon } = this;
    const q = `[out:json][timeout:25];way["building"](around:120,${lat},${lon});out tags geom;`;
    const data = await overpass(q);
    const proj = projector(lat, lon);
    const P = { x: 0, y: 0 };
    const buildings = (data.elements || [])
      .filter((e) => e.geometry && e.geometry.length > 2)
      .map((e) => ({ id: e.id, tags: e.tags || {}, pts: e.geometry.map((g) => proj.fwd(g.lat, g.lon)) }));
    if (!buildings.length) throw new Error('No hay edificios en OSM cerca de ese punto');

    this.buildingsLayer.clearLayers();
    for (const b of buildings) {
      L.polygon(b.pts.map((p) => { const ll = proj.inv(p.x, p.y); return [ll.lat, ll.lon]; }), {
        color: '#888', weight: 1, fillOpacity: 0.08,
      }).addTo(this.buildingsLayer);
    }

    // Arista más cercana = fachada del local
    let best = null;
    for (const b of buildings) {
      for (let i = 0; i < b.pts.length - 1; i++) {
        const c = closestOnSegment(P, b.pts[i], b.pts[i + 1]);
        if (!best || c.d < best.d) best = { ...c, b, a: b.pts[i], c2: b.pts[i + 1] };
      }
    }
    if (best.d > 30) throw new Error('El punto está lejos de cualquier fachada (>30 m)');
    const ex = best.c2.x - best.a.x, ey = best.c2.y - best.a.y;
    const len = Math.hypot(ex, ey);
    let n = { x: ey / len, y: -ex / len };
    if (pointInPolygon({ x: best.q.x + n.x * 0.5, y: best.q.y + n.y * 0.5 }, best.b.pts)) n = { x: -n.x, y: -n.y };
    const azimuth = Math.round((((Math.atan2(n.x, n.y) * 180) / Math.PI + 360) % 360) * 10) / 10;

    // Rayo hacia el exterior: primer edificio distinto
    let hit = null;
    for (const b of buildings) {
      if (b.id === best.b.id) continue;
      for (let i = 0; i < b.pts.length - 1; i++) {
        const k = raySegment(best.q, n, b.pts[i], b.pts[i + 1]);
        if (k !== null && (!hit || k < hit.k)) hit = { k, b };
      }
    }
    const foot = proj.inv(best.q.x, best.q.y);
    const patch = { lat: foot.lat, lon: foot.lon, azimuth };
    const own = buildingHeight(best.b.tags);
    if (own) patch.buildingHeight = own.value;
    let msg = `Fachada detectada: orientación ${azimuth}°.`;
    if (hit && hit.k < 80) {
      patch.separation = Math.round(hit.k * 10) / 10;
      const h = buildingHeight(hit.b.tags);
      msg += ` Edificio de enfrente a ${patch.separation} m`;
      if (h) {
        patch.oppositeHeight = h.value;
        msg += `, altura ${h.value} m (${h.source}).`;
      } else msg += '; OSM no tiene su altura: introdúcela a mano.';
    } else msg += ' No se encontró edificio enfrente en 80 m.';
    return { patch, msg };
  }
}
