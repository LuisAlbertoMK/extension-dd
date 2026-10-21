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
- `CONCURRENCY`: cuántas URLs se procesan en paralelo (por defecto **3**). Con listas de decenas o cientos de enlaces, la extensión no abre todas las pestañas de golpe: va tomando URLs de la cola de a `CONCURRENCY` a la vez.
- `NAV_STAGGER_MS`: separación mínima entre el inicio de dos navegaciones (por defecto **800 ms**, más hasta 400 ms de jitter). Sumado a `CONCURRENCY=3` deja ~1 navegación por segundo: menos throughput, pero el borde (Akamai) no ve una ráfaga. Subilo si te bloquean; bajalo solo si sabés que la IP está allowlisteada.

## Rendimiento (rama perf/*)
- Durante cada corrida se bloquean imágenes, video y fuentes vía `declarativeNetRequest` (`BLOCK_HEAVY_RESOURCES`): recorta segundos por página sin afectar data layers (scripts, XHR y documentos nunca se bloquean). Al terminar (o cancelar) la regla se retira sola, incluso si el worker muere a mitad. Si el sitio empieza a responder 403/429 (ver `edge-blocked`), probá con `BLOCK_HEAVY_RESOURCES=false`: un navegador que nunca pide imágenes es un perfil menos humano, y el costo es velocidad, no datos.
- Calibración con datos reales (368 URLs en 12m05s ≈ 9.9 s de carga por página en serie, con `CONCURRENCY=5`): el ritmo ya no lo fija solo la concurrencia sino `NAV_STAGGER_MS`, que serializa los arranques (~1 navegación/s con el default). Subir `CONCURRENCY` sin bajar el stagger no acelera nada. Si tu `digitalData` aparece temprano, baja `DIGITALDATA_MAX_WAIT_MS` (8s→4s) y `POST_LOAD_WAIT_MS` (1.5s→0.8s). Riesgo: perder data layers tardíos.
- Diferido a propósito: caché entre corridas (en auditoría, saltear URLs es dato rancio — solo tendría sentido como modo opt-in "qué cambió") y pool de tabs (invasivo en el `runQueue` actual para la ganancia que da).
- Un reintento transitorio cuesta hasta `RETRY_BASE_DELAY_MS` (400 ms) con jitter, y solo se paga cuando falla la infraestructura (no en páginas lentas ni en errores de red, que no se reintentan).

## Verdad del dato (rama perf/*)
- Cada entry guarda `finalUrl` (URL post-redirect, o `chrome-error://` si la página nunca cargó): el data layer pertenece a ESA página. Si difiere de la pedida, la tarjeta lo muestra en amarillo.
- Un `digitalData` definido pero **vacío** ya no cuenta como dato: se espera a que tenga contenido y se mantenga igual durante `DIGITALDATA_STABLE_POLLS` polls (por defecto 2). Antes el primer objeto truthy —aunque fuera `{}`— cortaba la espera y se reportaba como OK.
- Un `digitalData` **con estructura pero sin identidad** (`pageName`, `hierarchy`, `siteSection`, `pageType`, `pageDomain`) es un cascarón, y se acepta como respuesta en cuanto está poblado y estable: **no** se espera la identidad. La hipótesis contraria se midió y se descartó: en 28 cargas (dos corridas de 14 URLs con la espera activa) la identidad no apareció ni una vez, y en cuatro corridas de esas URLs apareció una sola vez, ya presente antes del primer poll — exactamente lo que atrapa el camino rápido. Esperarla costaba ~7 s por página sin capturar nada. El cascarón es un hallazgo del sitio (AA suele tener el `pageName` completo), no una medición nuestra a medias.
- Cada entry guarda `capture_ms`: cuánto tardó la captura hasta resolverse. Una resolución normal ronda los 1-2 s; acercarse a `DIGITALDATA_MAX_WAIT_MS` (~8000 ms) significa que el payload nunca se estabilizó y se devolvió el último visto. Sin ese campo, "no se estabilizó" y "captura prematura" se ven iguales en el export.
- El snapshot de Adobe es el **más rico** visto durante la espera, no el último: `s` suele estar completo cerca del beacon y quedar vacío después, así que leerlo al final (cuando el DD ya llegó) perdería eVars que sí existían.
- Un timeout de carga (25s) o una página de error de red (`chrome-error://`) se reportan como **error**, no como "sin digitalData": antes la auditoría culpaba al sitio por una página que la extensión nunca llegó a leer.
- Cada entry guarda `http_status`, el código de la respuesta del `main_frame` final (permiso `webRequest`, solo lectura). Es lo que distingue tres casos que antes se veían iguales —página sin DD, IP bloqueada, URL muerta—:
  - **403/429** → `edge-blocked` (env): el borde no sirvió la página (regla de bot o rate limit). No es un defecto del sitio, y es la señal de que hay que bajar el ritmo.
  - **5xx** → `server-error` (env); **404/410** → `not-found` (env): el DD no llegó a existir porque la página no era la página.
  - Sin `http_status` (corridas viejas), un título de denegación (`Access Denied`, `Web Page Blocked`, …) alcanza para el mismo veredicto; nunca pisa un código real.
- Paridad entre ramas: corre el mismo set en ambas, descarga el DD de cada una y compara con `npm run parity -- base-dd.json perf-dd.json` (exit 0 = paridad, 1 = divergencia). Adoptar perf solo con paridad total.

## Diagnóstico de problemas (derivado, no capturado)
Cada entry guarda la evidencia cruda; el veredicto se **calcula al mostrarla**. No
se escribe en `ddR:<n>`: si cambian las reglas, la misma corrida se vuelve a
diagnosticar sin crawlear el sitio otra vez.

- La página de resultados agrega chips por tarjeta con el código de cada problema
  y un botón **Descargar problemas** con `{ generatedAt, summary, results }`.
- `lib/diagnose.js` es puro y corre igual en el navegador y en node. El CLI
  diagnostica un export ya descargado:

  ```bash
  npm run diagnose -- digitalData-resultados-123.json --out problemas.json
  ```

  El CLI valida el contrato del export combinado y **rechaza las vistas DD/AA
  separadas** (exit 2): no traen `adobeAnalytics`, así que diagnosticarlas marcaba
  todas las páginas como `dd-without-aa` cuando en realidad AA nunca se midió.

- Para verificar que una corrida nueva reproduce las mismas reglas, compará su
  export contra un baseline del mismo alcance:

  ```bash
  npm run compare-diagnosis -- baseline-problemas.json nueva-problemas.json
  ```

  Sale 0 si el veredicto de cada entry es idéntico, 1 si algo se movió (nombra los
  índices y los deltas por código) y 2 si el alcance no coincide. Un diff no es
  automáticamente una regresión: puede ser que el sitio cambió entre corridas; el
  índice es el punto de partida para distinguirlo.

- Cada problema lleva `code`, `severity` (high/medium/low) y `attribution`:
  - `site` → la página no informa el dato; es lo que se convierte en AJUSTES.
  - `tool` → la auditoría no pudo producir evidencia confiable (truncado).
  - `env` → respuesta del entorno (redirect, preview, página que no cargó).
- `siteSeverity` es la peor severidad **solo de problemas `site`**: un `load-error`
  no debe mandar una URL a AJUSTES.

| Código | Sev | Attr | Qué prueba |
|---|---|---|---|
| `dd-missing` | high | site | No hay DD, ni snapshot AA, ni beacon Adobe en una página que respondió 200 |
| `missing-required` | high | site | Falta un campo del contrato (`DEFAULT_REQUIRED_FIELDS`) |
| `dd-truncated` | high | tool | El entry tocó el tope de 256 KB |
| `dd-unreadable` | high | tool | `digitalData` quedó como texto crudo: no se pueden leer campos |
| `edge-blocked` | high | env | HTTP 403/429 (o página de denegación): el borde no sirvió la página |
| `server-error` | high | env | HTTP 5xx: el servidor falló antes de cualquier data layer |
| `load-error` | high | env | La página no cargó: no es veredicto sobre el sitio |
| `pageName-mismatch` | medium | site | `page.pageName` no menciona el slug (opt-in: `checkPageName`) |
| `aa-without-dd` | medium | site | Hay AA (o un beacon) y no hay DD; con beacon, el snapshot de `s` no era legible |
| `dd-without-aa` | medium | site | Hay DD y AA no se midió |
| `locale-mismatch` | medium | site | `metrics_locale` no corresponde al país del host |
| `auth-wall` | medium | env | Redirigió a un IdP: la página pedida nunca se vio |
| `not-found` | medium | env | HTTP 404/410: la URL ya no existe en ese entorno |
| `error-page-no-pagename` | medium | site | La plantilla de error 404 está instrumentada y manda un page view de AA con `pageName` vacío |
| `request-rejected` | high | env | HTTP 431/414: el servidor rechazó la *petición* (headers demasiado grandes); la página nunca corrió |
| `invalid-status` | medium | tool | Estado fuera del enum del contrato |
| `incomplete-entry` | medium | tool | El entry no trae `adobeAnalytics`: AA nunca se midió |
| `redirect` | low | env | El DD pertenece a `finalUrl`, no a la URL pedida |
| `template-old` | low | site | Señal, no veredicto (opt-in: `checkTemplate`) |
| `adl-truncated` | low | tool | Solo se guardaron los primeros 50 eventos |
| `preview-env` | low/medium | env | Host de preview; `medium` si no se pudo verificar |
| `pending` | low | tool | La URL quedó en cola y nunca se procesó |

Ningún veredicto `site` se deriva de evidencia incompleta: un entry truncado, una
URL pendiente, un estado inválido, un payload ilegible o un export sin AA producen
solo problemas `tool`. Antes cada uno de esos casos se reportaba como defecto del
sitio de severidad alta.

Tampoco se deriva de una página que no llegó a servirse. `edge-blocked` (403/429),
`server-error` (5xx), `not-found` (404/410) y `request-rejected` (431/414) son
`env`. El último se agregó tras medirlo: cinco URLs de `ford.com.pr` respondieron
**431** en una corrida (y 404 en la anterior) tras esperar los ~8 s de captura.
Un 431 rechaza la petición por headers demasiado grandes, así que no hay
documento y nada que decir del data layer: era nuestro perfil de request, no el
sitio.

Los tres 404 de Lincoln quedan además fuera de `missing-required`: su shell llega
con `pageName`, `hierarchy` y `siteSection` vacíos porque es la plantilla de error,
y pedirle identidad a una página que no existe era doble conteo. Lo que sí se
reporta, como un defecto `site` medium por URL, es que esa plantilla dispara el
beacon de AA con `pageName` vacío: los tres payloads eran idénticos salvo la URL
(mismo `client`, `site`, `radUIVersion`, mismo `prop17` de otro vehículo), así que
es un fix de plantilla, no tres defectos de página. El 404 de `ford.com.pr`
(`title: "File not found"`, sin DD ni beacon) no dispara nada: ahí no hay
instrumentación que corregir.

Los campos obligatorios son datos, no código: se pueden cambiar por plantilla con
`diagnoseEntry(entry, { requiredFields: [...] })` cuando el cliente fije el
contrato real.

### Calibración con una corrida real (155 URLs Ford/Lincoln MX)

Las reglas se midieron contra un export real antes de darlas por buenas. Tres
supuestos no sobrevivieron:

- `page.pageInfo.pageType` y `page.category.primaryCategory` existen en **0/137**
  páginas: esta implementación usa `page.descriptor`, `page.tool`,
  `page.hierarchy`. El default quedó en `page.pageName` (90%), el único campo
  del contrato que el sitio realmente publica.
- `pageName-mismatch` disparaba en **103/137** páginas sanas porque el cliente
  nombra semánticamente (`service:home`, `ford owners:benefits`). Ahora es
  opt-in y solo aplica cuando `pageName` replica la ruta.
- `template-old` disparaba en **154/155** mientras 134/155 mandaban beacon de AA:
  el loader lo inyecta el tag manager, así que la señal es el piso, no un hallazgo.
  También opt-in.

La regla que sí se agregó con evidencia: `auth-wall` (2 portales de propietario
redirigen a `login.<marca>`; culpar al sitio por un DD que nunca se pudo ver es
un falso positivo) y `preview-env` en `medium` cuando el host de preview no
entregó datos (VPN).

### Alcance de la lista, no de las reglas

Las URLs `/overlay/*` son fragmentos modales que se inyectan en otra página: no
tienen `digitalData` propio por diseño. No se excluyen con una regla (sería una
decisión de alcance escondida en el código, imposible de auditar): se sacan de la
lista de entrada. La corrida cruda queda intacta como evidencia y el diagnóstico
se puede recalcular sobre ese crudo en cualquier momento.

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

## Versionado y procedencia

Un export sin versión no se puede auditar: "el campo no está" y "el código que
hizo la corrida no producía ese campo" se ven idénticos, y esa ambigüedad ya
costó una corrida.

- `manifest.json` es la versión de la extensión y se sube con **cada cambio de
  comportamiento** (hoy `1.1.4`). El export de resumen y el de problemas llevan
  `extensionVersion`: si un export nuevo no lo trae, la recarga no tomó.
- El export de problemas lleva además `rulesVersion` (constante `RULES_VERSION`
  en `lib/diagnose.js`). Se sube cuando una regla cambia el significado de un
  veredicto: comparar contra un baseline de otra versión de reglas no mide al
  sitio, mide el cambio de reglas.
- `npm run compare-diagnosis` imprime el ruleset de cada lado:
  `Rules: v1 on both sides` (determinismo dentro del mismo ruleset) o
  `[info] different ruleset: base v0, candidate v1 — a diff is expected, not a
  site change`. Un cambio de reglas **no** cambia el exit code: cambia cómo se
  lee el diff, no si hay regresión.
- El export combinado sigue siendo un array plano por contrato (compatibilidad
  con importadores externos), así que la versión viaja en los sobres: resumen y
  problemas.

## Completitud: el reporte declara lo que no midió

Un reporte de 148 entradas sobre una lista de 149 es un reporte equivocado, no
uno más chico. Y el modo de perder una URL es silencioso: al cancelar, los
workers devuelven **sin** persistir las capturas en vuelo, así que quedan huecos
en el medio del índice mientras el resto de la cola ya terminó. El export
contaba sólo lo capturado y se veía completo.

Por eso el sobre de problemas y el de resumen llevan `completeness`:

```json
{ "expectedTotal": 149, "captured": 148, "notCaptured": 1,
  "missing": [{ "index": 68, "url": "https://…” }],
  "cancelled": false, "basis": "queue", "complete": false }
```

- `basis: "queue"` sabe el total porque tiene la cola guardada (`ddJob.urls`) y
  puede **nombrar** la URL que no corrió. `basis: "indices"` (CLI sobre el
  export combinado) sólo prueba que no hay huecos dentro del rango capturado: una
  cola que nunca arrancó es invisible desde ahí, y el sobre lo dice en vez de
  fingir certeza.
- `cancelled` sale del marcador de la corrida: una corrida cancelada no es
  completa aunque no falte ningún índice.
- La CLI avisa por stderr (`WARNING: capture is incomplete…`), el comparador
  imprime `[info] base capture is incomplete…` antes del veredicto, y la página
  de resultados muestra una fila `Medición`.
- El export combinado y las vistas DD/AA siguen siendo arrays planos: la
  completitud viaja en los sobres, igual que la versión.

## Tests (node, sin dependencias)
Las funciones puras viven en `lib/` y se prueban con el runner nativo:
- `npm test` — 199 tests (urls, formato, resultados, quota, estado de carga,
  contrato de export, reglas y CLI del diagnóstico, comparador de diagnósticos,
  reglas y CLI del comparador de resúmenes, y un arnés de integración de
  `background.js` con la API de Chrome simulada: layout por URL, reanudación,
  aborto por cuota, página de error, cancelación con y sin worker vivo, watchdog
  al despertar y al reiniciar una cola muda, reintento transitorio y extractor de
  `digitalData`).
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
