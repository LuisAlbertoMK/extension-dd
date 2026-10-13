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
   - Botón para copiar el JSON combinado al portapapeles.
   - Botón "Descargar resumen": JSON compacto con totales por estado
     (ok / sin digitalData / error), top 5 errores agrupados, truncados,
     conteo con Adobe Analytics y tiempos — para evaluar la corrida sin
     scrollear las 368 tarjetas.

## Configuración opcional (background.js)
- `POST_LOAD_WAIT_MS`: espera extra tras cargar la página antes de buscar el objeto (por defecto 1.5s).
- `DIGITALDATA_MAX_WAIT_MS`: tiempo máximo reintentando buscar `window.digitalData` dentro de la página (por defecto 8s).
- `CLOSE_TABS_AFTER_READ`: pon `false` si quieres que las pestañas se queden abiertas en vez de cerrarse solas.
- `CONCURRENCY`: cuántas URLs se procesan en paralelo (por defecto 5). Con listas de decenas o cientos de enlaces, la extensión ya no abre todas las pestañas de golpe: va tomando URLs de la cola de a `CONCURRENCY` a la vez, lo cual evita saturar Chrome y reduce el riesgo de que un sitio te bloquee por exceso de peticiones simultáneas. Puedes subirlo si tu equipo aguanta más carga, o bajarlo si notas lentitud/errores.

## Notas
- Si una página no define `window.digitalData`, aparecerá como "Sin digitalData".
- Requiere permisos amplios (`<all_urls>`) porque debe poder inyectar código en cualquier sitio que pegues.

## Tests (node, sin dependencias)
Las funciones puras viven en `lib/` y se prueban con el runner nativo:
- `npm test` — 25 tests (urls, formato, resultados, quota, contrato de export).
- `node --test --experimental-test-coverage test/` — medición (~99% líneas en `lib/`).
El `test/contract.test.js` valida el schema que consumen importadores externos
(p. ej. MYCO paso 5): si cambia el export, el contrato falla explícito en vez de
romper la auditoría en silencio.

## Configuración local (Ford AEM, opcional)1. Copia `config.example.js` a `config.local.js` (ese archivo está en `.gitignore` y nunca se sube).
2. Completa tus valores reales (`edgeValue`, `cookieValue`).
3. Recarga la extensión. Sin ese archivo, el bypass de Ford queda desactivado y todo lo demás funciona igual.
