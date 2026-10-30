// Worker del análisis anual: calcula la matriz día × hora fuera del hilo de la interfaz.
import { computeAnnual } from './model.js';

self.onmessage = (ev) => {
  const { id, cfg, stepMin } = ev.data;
  const r = computeAnnual(cfg, {
    stepMin,
    onProgress: (p) => self.postMessage({ id, progress: p }),
  });
  self.postMessage(
    { id, result: r },
    [r.powerA.buffer, r.depthA.buffer, r.fracA.buffer, r.powerN.buffer, r.depthN.buffer, r.fracN.buffer]
  );
};
