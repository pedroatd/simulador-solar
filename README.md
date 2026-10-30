# Simulador solar de escaparate

Simulación 3D de la luz solar directa que entra por una ventana de suelo a techo de un local
comercial a lo largo del año. La ventana se ve de canto: exterior a la izquierda, interior a la derecha.

## Arrancar

```bash
python serve.py
```

Se abre `http://localhost:8765`. Hace falta un servidor (los módulos ES y el *worker* no funcionan
con `file://`) y conexión a internet (three.js, Leaflet y las teselas de OSM se cargan de CDN).
Las pruebas del modelo están en `http://localhost:8765/tests.html`.

## Qué hace

- **Escena 3D en sección** (three.js): calle, edificio de enfrente, fachada con su hueco, local y toldo.
  Las sombras salen del *shadow map* con la geometría completa; los rayos dibujados y las cifras salen del
  trazado analítico de `js/model.js`.
- **Controles de tiempo**: hora (arriba), día del año (abajo), reproducir/pausa, velocidad,
  modo "hora fija, avanzar días" y opción de saltar las noches.
- **Ubicación en mapa OpenStreetMap**: búsqueda (Nominatim), clic para situar la ventana y arrastre de la
  flecha roja para orientar la fachada. El botón **Detectar** consulta los edificios de OSM (Overpass),
  toma la arista más cercana como fachada, calcula su normal exterior y lanza un rayo para hallar
  la separación y la altura (`height` o `building:levels × 3 m`) del edificio de enfrente.
- **Toldo**: altura de anclaje, ángulo bajo la horizontal, longitud, ancho y transmitancia de la tela.
- **Análisis anual** (en un Web Worker, pasos de 15 min): mapa día × hora y curva del día de potencia,
  penetración o fracción soleada, con toldo, sin toldo o la reducción; energía anual, horas de sol y
  penetración máxima.

## Guardar y compartir

- Los parámetros se guardan solos en el navegador y se pueden exportar/importar en JSON.
- **Copiar enlace** copia una dirección con toda la configuración, el día, la hora, la métrica, el escenario
  y el corte codificados tras `#c=`. Al abrirla se carga ese caso tal cual, aunque la otra persona tenga otra
  configuración guardada. Para compartirla con otra persona, la web tiene que estar publicada
  (Netlify Drop, GitHub Pages…); un enlace a `localhost` solo funciona en tu ordenador.
- También se aceptan parámetros sueltos por URL:
  `?lat=28.4874&lon=-16.3159&az=180&sep=10&hopp=9&hwin=3&tz=Atlantic/Canary`.

## Modelo y supuestos

- Posición solar: algoritmo NOAA. Hora civil por zona IANA (con horario de verano) u hora solar media.
- Irradiancia directa de cielo despejado (Meinel + masa de aire de Kasten-Young). Sin difusa ni reflejada.
- Edificio de enfrente: plano vertical continuo, paralelo a la fachada, de altura constante.
- La calle está a la cota del suelo del local.
- Se tiene en cuenta el grosor del muro (jambas y dintel), el toldo como rectángulo plano centrado en la
  ventana y la transmitancia del vidrio.
- `azimuth` de fachada = dirección hacia la que mira la fachada (normal exterior), en grados desde el norte.

## Estructura

| Archivo | Contenido |
|---|---|
| `index.html`, `css/style.css` | Interfaz |
| `js/solar.js` | Posición solar, DNI, zonas horarias (puro) |
| `js/model.js` | Configuración, trazado de rayos, métricas instantáneas y anuales (puro) |
| `js/worker.js` | Cálculo anual fuera del hilo principal |
| `js/scene.js` | Escena three.js en sección |
| `js/map.js` | Mapa Leaflet + detección OSM |
| `js/charts.js` | Mapa de calor y curva diaria (canvas) |
| `js/main.js` | Estado, controles, animación |
| `tests.html` | Pruebas del modelo en el navegador |
