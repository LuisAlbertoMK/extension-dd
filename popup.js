const urlsEl = document.getElementById('urls');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const viewBtn = document.getElementById('viewResults');

// parseUrls, isPreviewUrl and formatElapsed live in lib/ (loaded before this script).

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
