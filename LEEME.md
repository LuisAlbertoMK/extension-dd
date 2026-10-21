# DigitalData Multi-URL Extractor

## Instalación (modo desarrollador)
1. Descarga y descomprime el ZIP.
2. Ve a `chrome://extensions`.
3. Activa "Modo de desarrollador" (esquina superior derecha).
4. Haz clic en "Cargar extensión sin empaquetar" ("Load unpacked").
5. Selecciona la carpeta `digitaldata-extension`.

## Uso
1. Haz clic en el ícono de la extensión.
2. Pega tus URLs, una por línea, en el cuadro de texto.
3. Pulsa "Abrir y analizar".
4. La extensión abrirá cada URL en una pestaña en segundo plano, esperará a que
   cargue, buscará `window.digitalData` (reintentando hasta 8 segundos por si
   se define de forma asíncrona) y cerrará la pestaña automáticamente.
5. Al terminar todas, se abre sola la pestaña "Ver resultados" con:
   - Una tarjeta por URL con su `digitalData` en JSON.
   - Debajo, sección "Adobe Analytics" con resumen de `window.s` (pageName, events, eVars/props), metadata de `_satellite` (property, environment) y eventos de `adobeDataLayer` (hasta 50 por página).
   - Botón para descargar todo combinado en un único archivo `.json`.
   - Botones "Descargar DD" / "Descargar AA": vistas separadas con el mismo
     orden e índices, cada una con status honesto por vista, para que agentes
     o validadores independientes consuman solo lo suyo sin contaminarse.
   - Botón para copiar el JSON combinado al portapapeles.
   - Botón "Descargar resumen": JSON compacto con totales por estado
     (ok / sin digitalData / error), top 5 errores agrupados, truncados,
     conteo con Adobe Analytics y tiempos — para evaluar la corrida sin
     scrollear las 368 tarjetas.
   - El resumen separa prod vs preview (mismo patrón del preflight) y el
     conteo de errores abre un modal con URL + mensaje de cada fallo.

## Modo sitio (sitemap + enlaces)
Marca "Auditar sitio" en el popup y pega hosts semilla (uno por línea, ej. `https://www.ford.mx`). La corrida deja de tratar la lista como definitiva:
1. Descarga `https://<host>/sitemap.xml` (y sus hijos si es un índice) desde el worker, con la sesión del navegador. Si el sitemap no se puede leer, la corrida sigue con las semillas y el resumen lo informa.
2. Suma al final de la cola los enlaces internos del mismo host encontrados en cada página, hasta la profundidad elegida (0 = solo semillas, 1 = sitemap, 2 = enlaces de esas páginas; por defecto 2, máximo 3).
3. Deduplica por URL normalizada (sin fragmento, sin barra final, con query) y descarta assets (pdf, imágenes, css, js, etc.).
4. Tope de 800 URLs por corrida: al alcanzarlo deja de encolar y el resumen muestra "tope de URLs alcanzado".

Cada entry gana campos opcionales para el informe: `template` (`new` si la página carga el loader `metrics.ford.<locale>.js` o `metrics.lincoln.<locale>.js`; `old` si no), `metrics_files`, `metrics_locale`, `title`, `links_found` (anclas vistas en la página, no URLs nuevas), `has_fmc_context` (`FMC.context` en scripts inline) y `has_aa_beacon` (request a `smetrics.ford.com`). Son aditivos: el contrato de export no cambia y los importadores viejos los ignoran.

La página de resultados agrega chips por tarjeta y filas de resumen (plantilla nueva/legacy, FMC.context, beacon Adobe), y el `ddJob.site` persistido conserva la profundidad, el conteo descubierto y los errores de sitemap para el resumen.

## Configuración opcional (background.js)
- `POST_LOAD_WAIT_MS`: espera extra tras cargar la página antes de buscar el objeto (por defecto 1.5s).
- `DIGITALDATA_MAX_WAIT_MS`: tiempo máximo reintentando buscar `window.digitalData` dentro de la página (por defecto 8s).
- `DIGITALDATA_STABLE_POLLS`: cuántos polls seguidos con el mismo contenido debe mantener `digitalData` para aceptarlo (por defecto 2 → ~500ms extra por página con dato). Bajarlo a 1 acelera pero vuelve a aceptar payloads parciales.
- `CLOSE_TABS_AFTER_READ`: pon `false` si quieres que las pestañas se queden abiertas en vez de cerrarse solas.
- `CONCURRENCY`: cuántas URLs se procesan en paralelo (por defecto 5). Con listas de decenas o cientos de enlaces, la extensión ya no abre todas las pestañas de golpe: va tomando URLs de la cola de a `CONCURRENCY` a la vez, lo cual evita saturar Chrome y reduce el riesgo de que un sitio te bloquee por exceso de peticiones simultáneas. Puedes subirlo si tu equipo aguanta más carga, o bajarlo si notas lentitud/errores.

## Rendimiento (rama perf/*)
- Durante cada corrida se bloquean imágenes, video y fuentes vía `declarativeNetRequest` (`BLOCK_HEAVY_RESOURCES`): recorta segundos por página sin afectar data layers (scripts, XHR y documentos nunca se bloquean). Al terminar (o cancelar) la regla se retira sola, incluso si el worker muere a mitad.
- Calibración con datos reales (368 URLs en 12m05s ≈ 9.9 s de carga por página en serie, ≈2 s por URL de reloj de pared con `CONCURRENCY=5`): si tu `digitalData` aparece temprano, baja `DIGITALDATA_MAX_WAIT_MS` (8s→4s) y `POST_LOAD_WAIT_MS` (1.5s→0.8s); si la máquina aguantó bien, sube `CONCURRENCY` (5→8). Riesgo: perder data layers tardíos.
- Diferido a propósito: caché entre corridas (en auditoría, saltear URLs es dato rancio — solo tendría sentido como modo opt-in "qué cambió") y pool de tabs (invasivo en el `runQueue` actual para la ganancia que da).
- Un reintento transitorio cuesta hasta `RETRY_BASE_DELAY_MS` (400 ms) con jitter, y solo se paga cuando falla la infraestructura (no en páginas lentas ni en errores de red, que no se reintentan).

## Verdad del dato (rama perf/*)
- Cada entry guarda `finalUrl` (URL post-redirect, o `chrome-error://` si la página nunca cargó): el data layer pertenece a ESA página. Si difiere de la pedida, la tarjeta lo muestra en amarillo.
- Un `digitalData` definido pero **vacío** ya no cuenta como dato: se espera a que tenga contenido y se mantenga igual durante `DIGITALDATA_STABLE_POLLS` polls (por defecto 2). Antes el primer objeto truthy —aunque fuera `{}`— cortaba la espera y se reportaba como OK.
- Un timeout de carga (25s) o una página de error de red (`chrome-error://`) se reportan como **error**, no como "sin digitalData": antes la auditoría culpaba al sitio por una página que la extensión nunca llegó a leer.
- Paridad entre ramas: corre el mismo set en ambas, descarga el DD de cada una y compara con `npm run parity -- base-dd.json perf-dd.json` (exit 0 = paridad, 1 = divergencia). Adoptar perf solo con paridad total.

## Validación A/B (antes de adoptar perf)
Adoptar la rama `perf/*` sin medirla es fe. El procedimiento:
1. Congela la lista de URLs (el `.txt` que pegás en el popup) y usa **la misma** en las dos corridas.
2. Corre el set en la base (`checkpoint/pre-fase1`), recarga la extensión en `chrome://extensions`, corre el mismo set en la rama perf: mismo día, misma máquina, misma red.
3. Descarga el resumen de cada corrida y compáralos con
   `npm run compare -- base-resumen.json perf-resumen.json` (exit 0 = adoptar, 1 = ajustar/rechazar, 2 = input inválido).
   El comando verifica que la lista coincida, que `ok` no baje, que los errores nuevos expliquen los "sin digitalData" que faltan, y que el tiempo por URL no suba más de 15% (25% bloquea). Una corrida que no terminó la lista se rechaza como **incompleta** (el export trae `expectedTotal`, el tamaño de la lista al arrancar) en vez de compararse: dos corridas cortadas en el mismo punto tendrían totales iguales y el veredicto sería humo.
4. `npm run parity -- base-dd.json perf-dd.json` para el contenido del data layer, no solo los conteos.

## Notas
- Si una página no define `window.digitalData`, aparecerá como "Sin digitalData".
- La detección de plantilla depende de que el loader `metrics.ford.<locale>.js` (o `metrics.lincoln.<locale>.js`) esté en un `<script src>` de la página: si se inyecta desde un tag manager, la página queda como `old`. `FMC.context` y el beacon a `smetrics.ford.com` se reportan como corroboración, nunca promueven una página a `new`.
- Requiere permisos amplios (`<all_urls>`) porque debe poder inyectar código en cualquier sitio que pegues.

## Persistencia (una clave por URL)
Cada URL terminada se guarda en su propia clave `ddR:<índice>` y el progreso en
`ddProgress`. Antes se reescribía la corrida completa en cada URL (coste
cuadrático) y un fallo de cuota se ignoraba, perdiendo la corrida entera en
memoria. Ahora:
- La escritura por URL es de tamaño constante y el worker no acumula payloads.
- Con `unlimitedStorage` la cuota de 10 MB deja de ser un techo realista.
- Si una escritura falla igual (disco lleno), la corrida se detiene, se conservan
  los resultados ya guardados y el popup/resumen muestran el motivo
  (`storage-quota` / `storage-write`).

## Resiliencia (watchdog, cancelación, reintentos)
- **Watchdog** (`chrome.alarms`, cada minuto, solo mientras hay corrida): Chrome
  puede matar el service worker a mitad de una corrida y nada lo despertaba
  hasta abrir el popup. Ahora la alarma despierta al worker, reanuda la corrida y
  además reinicia una cola que lleva `WATCHDOG_STALL_MS` (2 min) sin guardar
  resultados: se descartan las pestañas colgadas y se reanuda desde el primer
  índice sin resultado, sin reprocesar lo ya hecho.
- **Cancelar** (botón en el popup): funciona incluso si el worker fue suspendido
  y ya no tiene el job en memoria (el estado persistido manda). Una corrida
  cancelada no vuelve a escribir progreso —sus contadores serían viejos— y deja
  `ddJobError: 'cancelled'` para que popup y resultados lo digan explícito.
- **Reintentos**: un fallo transitorio de infraestructura (pestaña rechazada,
  pestaña descartada por memoria) se reintenta una vez con jitter. Una página de
  error de red o un timeout **no** se reintentan: son la respuesta del sitio, no
  un hipo de la extensión, y reintentarlos duplicaría el tiempo para el mismo
  veredicto. El reintento no agrega campos al contrato del entry, así que los
  mensajes de error siguen siendo comparables entre corridas.
- Las pestañas huérfanas de un worker muerto sí se cierran: los ids vivos se
  guardan en `ddProgress.tabIds` y `closeOrphanTabs()` lee también esa clave
  (antes leía solo `ddJob`, que no se actualiza a mitad de corrida, así que las
  pestañas quedaban abiertas para siempre).

## Tests (node, sin dependencias)
Las funciones puras viven en `lib/` y se prueban con el runner nativo:
- `npm test` — 87 tests (urls, formato, resultados, quota, estado de carga,
  contrato de export, reglas y CLI del comparador de resúmenes, y un arnés de
  integración de `background.js` con la API de Chrome simulada: layout por URL,
  reanudación, aborto por cuota, página de error, cancelación con y sin worker
  vivo, watchdog al despertar y al reiniciar una cola muda, reintento transitorio
  y extractor de `digitalData`).
- `node --test --experimental-test-coverage test/` — cobertura de `lib/` entre
  89% y 100% por archivo (`lib/schema.js` es el más bajo: ramas de violación), y
  `tools/compare-summaries.js` en ~99% (reglas y CLI probadas).
- `node --test --experimental-test-coverage test/` — medición (~99% líneas en `lib/`).
El `test/contract.test.js` valida el schema que consumen importadores externos
( p. ej. MYCO paso 5): si cambia el export, el contrato falla explícito en vez de
romper la auditoría en silencio.

## Configuración local (Ford AEM, opcional)1. Copia `config.example.js` a `config.local.js` (ese archivo está en `.gitignore` y nunca se sube).
2. Completa tus valores reales (`edgeValue`, `cookieValue`).
3. Recarga la extensión. Sin ese archivo, el bypass de Ford queda desactivado y todo lo demás funciona igual.
