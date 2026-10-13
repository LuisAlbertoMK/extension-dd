const urlsEl = document.getElementById('urls');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const viewBtn = document.getElementById('viewResults');

function parseUrls(raw) {
  const seen = new Set();
  const urls = [];
  raw.split('\n').forEach((line) => {
    const s = line.trim();
    if (!s) return;
    // Reject an explicit non-http(s) scheme instead of force-prefixing it.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return;
    const candidate = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (e) {
      return; // ignore malformed URLs
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    const normalized = parsed.href;
    if (seen.has(normalized)) return; // dedupe
    seen.add(normalized);
    urls.push(normalized);
  });
  return urls;
}

// Matches preview/staging/author hosts. Extend with team-specific patterns as needed.
const PREVIEW_PATTERN = /preview|author[-.]|stage|dev[-.]|test[-.]|localhost|127\.0\.0\.1|\.corp|aem.*preview|hlx.*preview/i;

function isPreviewUrl(url) {
  try {
    const u = new URL(url);
    return PREVIEW_PATTERN.test(u.hostname) || PREVIEW_PATTERN.test(u.href);
  } catch (e) {
    return false;
  }
}

async function refreshStatus() {
  const { ddJobRunning, ddTotal, ddResults, ddStartedAt, ddFinishedAt } = await chrome.storage.local.get([
    'ddJobRunning',
    'ddTotal',
    'ddResults',
    'ddStartedAt',
    'ddFinishedAt'
  ]);
  const done = ddResults ? Object.keys(ddResults).length : 0;
  startBtn.disabled = !!ddJobRunning;
  const elapsed = formatElapsed(ddStartedAt, ddJobRunning ? Date.now() : ddFinishedAt);
  if (ddJobRunning) {
    statusEl.textContent = `Procesando... ${done}/${ddTotal || 0} completadas · ${elapsed}`;
  } else if (ddTotal) {
    statusEl.textContent = `Última corrida: ${done}/${ddTotal} completadas en ${elapsed}. Pulsa "Ver resultados".`;
  } else {
    statusEl.textContent = '';
  }
}

function formatElapsed(start, end) {
  if (!start || !end || end < start) return '—';
  const s = (end - start) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(0)}s`;
}

// Live ticking counter while the job runs
setInterval(() => {
  chrome.storage.local.get('ddJobRunning').then(({ ddJobRunning }) => {
    if (ddJobRunning) refreshStatus();
  }).catch(() => {});
}, 1000);

startBtn.addEventListener('click', async () => {
  const urls = parseUrls(urlsEl.value);
  if (!urls.length) {
    statusEl.textContent = 'Ingresa al menos una URL válida.';
    return;
  }
  // Guard: never start a second job while one is already running.
  const { ddJobRunning } = await chrome.storage.local.get('ddJobRunning');
  if (ddJobRunning) {
    statusEl.textContent = 'Ya hay un análisis en curso. Espera a que termine.';
    return;
  }
  startBtn.disabled = true;
  statusEl.textContent = `Iniciando... 0/${urls.length}`;
  try {
    const previews = urls.filter(isPreviewUrl);
    if (previews.length) {
      const goOn = confirm(
        `Detecté ${previews.length} URL(s) de preview. ¿Activaste la VPN empresarial? Aceptar = continuar, Cancelar = volver.`
      );
      if (!goOn) {
        startBtn.disabled = false;
        statusEl.textContent = 'Análisis cancelado: activa la VPN para las URLs de preview.';
        return;
      }
    }
    const res = await chrome.runtime.sendMessage({ type: 'START_JOB', urls });
    if (res && res.ok === false) {
      startBtn.disabled = false;
      statusEl.textContent = res.reason === 'already-running'
        ? 'Ya hay un análisis en curso.'
        : 'No se pudo iniciar el análisis.';
    }
  } catch (e) {
    startBtn.disabled = false;
    statusEl.textContent = 'No se pudo iniciar el análisis.';
  }
});

viewBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') refreshStatus();
});

refreshStatus();
