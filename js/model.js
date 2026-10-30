// Modelo geométrico de la ventana, la calle, el edificio de enfrente y el toldo.
// Módulo puro (sin DOM ni three.js): lo usan la escena, la interfaz y el worker de análisis anual.
//
// Sistema de coordenadas local (metros), el mismo que la escena 3D:
//   x: perpendicular a la fachada, positivo hacia el INTERIOR (derecha en la vista de canto)
//   y: vertical, 0 = suelo de la habitación; la calle está en y = −room.floorElevation
//   z: horizontal a lo largo de la fachada (x × y), 0 = centro de la ventana
// La cara interior del vidrio está en x = 0 y la cara exterior del muro en x = −grosor.

import { D2R, sunPosition, clearSkyDNI, localToUtc, tzOffsetMinutes, daysInYear } from './solar.js';

export const DEFAULT_CONFIG = {
  location: {
    lat: 28.4874,
    lon: -16.3159,
    tz: 'Atlantic/Canary',
    year: new Date().getFullYear(),
  },
  facade: {
    azimuth: 180, // orientación de la normal exterior de la fachada, grados desde el norte (180 = mira al sur)
    wallThickness: 0.25,
    buildingHeight: 10,
  },
  street: {
    separation: 10, // de fachada a fachada (m)
    oppositeHeight: 9, // cota máxima del edificio de enfrente (m) respecto a la calle
  },
  room: {
    floorElevation: 0, // cota del suelo de la habitación sobre la calle (m); 0 = planta baja
    ceilingHeight: 3, // altura libre interior (m)
    sillHeight: 0, // la ventana empieza a esta altura sobre el suelo (0 = de suelo a techo)
    windowHeight: 3, // la ventana termina a esta altura sobre el suelo (dintel)
    windowWidth: 3,
    depth: 10,
    width: 5,
    glassTransmittance: 0.8,
  },
  awning: {
    enabled: true,
    mountHeight: 3.2, // altura del eje de giro sobre el suelo de la habitación (m)
    angle: 20, // grados por debajo de la horizontal (0 = horizontal, 90 = colgando vertical)
    length: 2.5, // longitud del brazo/tela desplegada (m)
    width: 3.5, // ancho a lo largo de la fachada (m)
    transmittance: 0, // fracción de luz directa que atraviesa la tela
  },
};

export function cloneConfig(c) {
  return JSON.parse(JSON.stringify(c));
}

/** Mezcla profunda de un objeto parcial sobre la configuración por defecto (para importar/localStorage). */
export function mergeConfig(partial) {
  const out = cloneConfig(DEFAULT_CONFIG);
  if (!partial || typeof partial !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (partial[k] && typeof partial[k] === 'object') {
      for (const j of Object.keys(out[k])) {
        if (partial[k][j] !== undefined && typeof partial[k][j] === typeof out[k][j]) out[k][j] = partial[k][j];
      }
    }
  }
  return out;
}

/** Vector unitario hacia el sol en coordenadas locales. */
export function sunVectorLocal(azimuth, altitude, facadeAz) {
  const h = altitude * D2R;
  const g = (azimuth - facadeAz) * D2R;
  return { x: -Math.cos(h) * Math.cos(g), y: Math.sin(h), z: -Math.cos(h) * Math.sin(g) };
}

/** Ángulo de perfil (sombra vertical): ángulo del rayo proyectado en el plano de sección. */
export function profileAngle(s) {
  if (s.x >= 0) return null;
  return Math.atan2(s.y, -s.x) / D2R;
}

/** Geometría del toldo en la sección: eje (bisagra) y punta. */
export function awningSection(cfg) {
  const a = cfg.awning;
  const t = cfg.facade.wallThickness;
  const al = a.angle * D2R;
  return {
    hinge: { x: -t, y: a.mountHeight },
    tip: { x: -t - a.length * Math.cos(al), y: a.mountHeight - a.length * Math.sin(al) },
  };
}

/**
 * Sigue un rayo solar que llega al punto (0, y, z) de la cara interior del vidrio.
 * Devuelve qué lo bloquea (si algo) y dónde, y el punto de impacto en el interior.
 */
export function traceRay(cfg, s, y, z, useAwning = true) {
  const { room, street, awning, facade } = cfg;
  const t = facade.wallThickness;
  const res = { blockedBy: null, block: null, weight: 1, hit: null, hitSurface: null };
  if (s.y <= 0 || s.x >= 0) {
    res.blockedBy = 'night';
    return res;
  }
  const dx = -s.x;

  // 1) Mocheta/dintel: el rayo debe atravesar el hueco en la cara exterior del muro (x = −t)
  const kr = t / dx;
  const yr = y + kr * s.y;
  const zr = z + kr * s.z;
  if (yr > room.windowHeight || Math.abs(zr) > room.windowWidth / 2) {
    res.blockedBy = yr > room.windowHeight ? 'dintel' : 'jamba';
    res.block = { x: -t, y: yr, z: zr };
    return res;
  }

  // 2) Edificio de enfrente (plano vertical infinito a lo largo de la calle); su cota se mide desde la calle
  const kb = (t + street.separation) / dx;
  const yb = y + kb * s.y;
  if (yb < street.oppositeHeight - room.floorElevation) {
    res.blockedBy = 'edificio';
    res.block = { x: -t - street.separation, y: yb, z: z + kb * s.z };
    return res;
  }

  // 3) Toldo (rectángulo plano con bisagra en la fachada)
  if (useAwning && awning.enabled && awning.length > 0) {
    const al = awning.angle * D2R;
    const e1x = -Math.cos(al), e1y = -Math.sin(al);
    const nx = -Math.sin(al), ny = Math.cos(al);
    const hx = -t, hy = awning.mountHeight;
    const denom = nx * s.x + ny * s.y;
    if (Math.abs(denom) > 1e-9) {
      const k = (nx * hx + ny * (hy - y)) / denom;
      if (k > 0) {
        const qx = k * s.x, qy = y + k * s.y, qz = z + k * s.z;
        const u = (qx - hx) * e1x + (qy - hy) * e1y;
        if (u >= 0 && u <= awning.length && Math.abs(qz) <= awning.width / 2) {
          res.weight = awning.transmittance;
          res.block = { x: qx, y: qy, z: qz };
          res.blockedBy = 'toldo';
          if (res.weight <= 0) return res;
        }
      }
    }
  }

  // 4) Recorrido interior: suelo o pared del fondo
  const kf = y / s.y;
  const xf = kf * dx;
  if (xf <= room.depth) {
    res.hit = { x: xf, y: 0, z: z - kf * s.z };
    res.hitSurface = Math.abs(res.hit.z) <= room.width / 2 ? 'suelo' : 'lateral';
  } else {
    const kw = room.depth / dx;
    res.hit = { x: room.depth, y: y - kw * s.y, z: z - kw * s.z };
    res.hitSurface = 'fondo';
  }
  return res;
}

/**
 * Métricas instantáneas para un vector solar dado.
 * Muestrea la ventana en una rejilla ny × nz.
 */
export function computeInstant(cfg, s, dni, { ny = 40, nz = 15, useAwning = true } = {}) {
  const { room } = cfg;
  const out = { litFraction: 0, power: 0, depth: 0, floorArea: 0, backWallArea: 0, cosIncidence: 0 };
  if (s.y <= 0 || s.x >= 0 || dni <= 0) return out;
  const h = room.windowHeight - room.sillHeight;
  if (h <= 0 || room.windowWidth <= 0) return out;
  const dA = (h * room.windowWidth) / (ny * nz);
  const dx = -s.x;
  let lit = 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = -room.windowWidth / 2 + ((iz + 0.5) * room.windowWidth) / nz;
    for (let iy = 0; iy < ny; iy++) {
      const y = room.sillHeight + ((iy + 0.5) * h) / ny;
      const r = traceRay(cfg, s, y, z, useAwning);
      if (!r.hit) continue;
      const w = r.weight;
      lit += w;
      if (r.hitSurface === 'suelo') {
        out.floorArea += (w * dA * dx) / s.y;
        if (w >= 1 && r.hit.x > out.depth) out.depth = r.hit.x;
      } else if (r.hitSurface === 'fondo') {
        out.backWallArea += w * dA;
        if (w >= 1) out.depth = room.depth;
      }
    }
  }
  out.litFraction = lit / (ny * nz);
  out.cosIncidence = dx;
  out.power = dni * dx * lit * dA * room.glassTransmittance;
  return out;
}

/** Estado solar completo para un día del año y minutos locales. */
export function solarState(cfg, doy, minutes) {
  const { lat, lon, tz, year } = cfg.location;
  const utc = localToUtc(year, doy, minutes, tz, lon);
  const pos = sunPosition(utc, lat, lon);
  const s = sunVectorLocal(pos.azimuth, pos.altitude, cfg.facade.azimuth);
  return { utc, ...pos, s, dni: clearSkyDNI(pos.altitude) };
}

/**
 * Simulación anual (día × paso) con y sin toldo.
 * Devuelve matrices planas Float32Array de tamaño days*steps (índice = (doy−1)*steps + paso).
 */
export function computeAnnual(cfg, { stepMin = 15, ny = 18, nz = 7, onProgress } = {}) {
  const { lat, lon, tz, year } = cfg.location;
  const days = daysInYear(year);
  const steps = Math.round(1440 / stepMin);
  const n = days * steps;
  const r = {
    days, steps, stepMin,
    powerA: new Float32Array(n), depthA: new Float32Array(n), fracA: new Float32Array(n),
    powerN: new Float32Array(n), depthN: new Float32Array(n), fracN: new Float32Array(n),
  };
  for (let d = 1; d <= days; d++) {
    // Desfase horario calculado una vez por día (a mediodía); el error solo afecta a las horas del cambio de hora.
    const noon = Date.UTC(year, 0, d, 12);
    const off = tz === 'SOLAR' ? lon * 4 : tzOffsetMinutes(noon, tz);
    for (let k = 0; k < steps; k++) {
      const minutes = (k + 0.5) * stepMin;
      const utc = Date.UTC(year, 0, d) + (minutes - off) * 60000;
      const pos = sunPosition(utc, lat, lon);
      if (pos.altitude <= 0) continue;
      const s = sunVectorLocal(pos.azimuth, pos.altitude, cfg.facade.azimuth);
      if (s.x >= 0) continue;
      const dni = clearSkyDNI(pos.altitude);
      const i = (d - 1) * steps + k;
      const a = computeInstant(cfg, s, dni, { ny, nz, useAwning: true });
      r.powerA[i] = a.power; r.depthA[i] = a.depth; r.fracA[i] = a.litFraction;
      if (cfg.awning.enabled) {
        const b = computeInstant(cfg, s, dni, { ny, nz, useAwning: false });
        r.powerN[i] = b.power; r.depthN[i] = b.depth; r.fracN[i] = b.litFraction;
      } else {
        r.powerN[i] = a.power; r.depthN[i] = a.depth; r.fracN[i] = a.litFraction;
      }
    }
    if (onProgress && d % 20 === 0) onProgress(d / days);
  }
  return r;
}
