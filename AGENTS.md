# Notas para agentes de código

- Proyecto web estático sin build: módulos ES nativos, three.js y Leaflet desde CDN (import map en `index.html`).
- Servir con `python serve.py` (sin caché). Pruebas: abrir `/tests.html`; todas deben salir en verde.
- `js/solar.js` y `js/model.js` son puros (sin DOM): los usa también `js/worker.js`. Mantenerlos así.
- Coordenadas locales: x hacia el interior (cara interior del vidrio en x = 0, cara exterior del muro en
  x = −grosor), y vertical con y = 0 en el suelo de la habitación (la calle está en y = −room.floorElevation),
  z a lo largo de la fachada. La escena 3D usa el mismo sistema. Las alturas de edificios (propio y de enfrente)
  se miden desde la calle; las de ventana, techo y toldo, desde el suelo de la habitación.
- Cualquier cambio geométrico debe hacerse a la vez en `traceRay` (`model.js`) y en `setConfig` (`scene.js`)
  para que las sombras de three.js y las cifras coincidan. Añadir un caso a `tests.html` si cambia el modelo.
- Interfaz y textos en español.
