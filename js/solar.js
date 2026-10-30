// Posición solar (algoritmo NOAA, precisión ~0.01°) y utilidades de tiempo.
// Módulo puro: sin dependencias del DOM, usable desde el hilo principal y desde el worker.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

const mod = (a, n) => ((a % n) + n) % n;

/**
 * Posición del sol para un instante UTC.
 * @param {number} utcMs  milisegundos desde epoch (UTC)
 * @param {number} lat    latitud en grados (+N)
 * @param {number} lon    longitud en grados (+E)
 * @returns {{altitude:number, azimuth:number, declination:number, eqTime:number}}
 *   altitude en grados sobre el horizonte (con refracción), azimuth en grados desde el norte en sentido horario.
 */
export function sunPosition(utcMs, lat, lon) {
  const jd = utcMs / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;

  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * D2R;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const omega = (125.04 - 1934.136 * T) * D2R;
  const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * D2R;
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * D2R;

  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * D2R;
  const eqTime =
    4 * R2D *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr)); // minutos

  const utcMinutes = mod(utcMs / 60000, 1440);
  const tst = mod(utcMinutes + eqTime + 4 * lon, 1440);
  const ha = (tst / 4 - 180) * D2R;
  const latr = lat * D2R;

  const cosZ = Math.sin(latr) * Math.sin(decl) + Math.cos(latr) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  let alt = 90 - zenith * R2D;

  // Refracción atmosférica (NOAA)
  let refr = 0;
  if (alt > 85) refr = 0;
  else if (alt > 5) {
    const te = Math.tan(alt * D2R);
    refr = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  } else if (alt > -0.575) {
    refr = 1735 + alt * (-518.2 + alt * (103.4 + alt * (-12.79 + alt * 0.711)));
  } else {
    refr = -20.772 / Math.tan(alt * D2R);
  }
  alt += refr / 3600;

  const az = mod(
    Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(latr) - Math.tan(decl) * Math.cos(latr)) * R2D + 180,
    360
  );
  return { altitude: alt, azimuth: az, declination: decl * R2D, eqTime };
}

/** Irradiancia directa normal de cielo despejado (W/m²), modelo de Meinel con masa de aire de Kasten-Young. */
export function clearSkyDNI(altitudeDeg) {
  if (altitudeDeg <= 0) return 0;
  const z = 90 - altitudeDeg;
  const am = 1 / (Math.cos(z * D2R) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
  return 1361 * Math.pow(0.7, Math.pow(am, 0.678));
}

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInYear = (y) => (isLeap(y) ? 366 : 365);

/** Fecha (año, mes 1-12, día) a partir del día del año (1..365/366). */
export function doyToDate(year, doy) {
  const d = new Date(Date.UTC(year, 0, doy));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const fmtCache = new Map();
function formatterFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Desfase (minutos, local − UTC) de una zona horaria IANA en un instante dado. */
export function tzOffsetMinutes(utcMs, tz) {
  const parts = {};
  for (const p of formatterFor(tz).formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * Convierte (día del año, minutos locales) a instante UTC.
 * tz: nombre IANA (p. ej. "Atlantic/Canary") o "SOLAR" para hora solar media del meridiano local.
 */
export function localToUtc(year, doy, minutes, tz, lon) {
  const base = Date.UTC(year, 0, doy) + minutes * 60000;
  if (tz === 'SOLAR') return base - lon * 4 * 60000;
  let guess = base - tzOffsetMinutes(base, tz) * 60000;
  guess = base - tzOffsetMinutes(guess, tz) * 60000;
  return guess;
}
