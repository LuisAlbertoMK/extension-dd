const listEl = document.getElementById('list');
const summaryEl = document.getElementById('summary');
const statsEl = document.getElementById('stats');

function badgeClass(status) {
  return status || 'pending';
}

function statusLabel(status) {
  switch (status) {
    case 'ok': return 'OK';
    case 'no-data': return 'Sin digitalData';
    case 'error': return 'Error';
    default: return 'Pendiente';
  }
}

// entryIndex, orderedResults, buildCombinedJson and formatElapsed live in lib/.

async function loadResults() {
  const { ddResults, ddTotal, ddJobRunning, ddStartedAt, ddFinishedAt } = await chrome.storage.local.get([
    'ddResults',
    'ddTotal',
    'ddJobRunning',
    'ddStartedAt',
    'ddFinishedAt'
  ]);
  const entries = orderedResults(ddResults || {});
  const elapsed = formatElapsed(ddStartedAt, ddJobRunning ? Date.now() : ddFinishedAt);

  summaryEl.textContent = ddJobRunning
    ? `Procesando... ${entries.length}/${ddTotal || 0} · ${elapsed}`
    : `${entries.length}/${ddTotal || entries.length} URLs procesadas en ${elapsed}`;

  renderStats(buildSummary(entries, {
    startedAt: ddStartedAt,
    finishedAt: ddJobRunning ? Date.now() : ddFinishedAt
  }));

  if (!entries.length) {
    listEl.innerHTML = '<div class="empty">Todavía no hay resultados. Ejecuta un análisis desde el popup de la extensión.</div>';
    return;
  }

  listEl.innerHTML = '';
  entries.forEach(({ entry }) => {
    const card = document.createElement('div');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card-header';

    const urlSpan = document.createElement('span');
    urlSpan.className = 'url';
    urlSpan.textContent = entry.url;

    const badge = document.createElement('span');
    badge.className = `badge ${badgeClass(entry.status)}`;
    badge.textContent = statusLabel(entry.status);

    header.appendChild(urlSpan);
    header.appendChild(badge);

    const pre = document.createElement('pre');
    if (entry.status === 'error') {
      pre.textContent = 'Error: ' + entry.error;
    } else if (entry.status === 'no-data') {
      pre.textContent = 'No se encontró window.digitalData ni datos de Adobe Analytics en esta página.';
    } else if (entry.truncated && typeof entry.digitalData === 'string') {
      pre.textContent = entry.digitalData +
        '\n\n[... contenido truncado por límite de almacenamiento ...]';
    } else {
      pre.textContent = JSON.stringify(entry.digitalData, null, 2);
    }
    if (entry.adobeAnalytics) {
      pre.textContent += '\n\n--- Adobe Analytics ---\n' +
        JSON.stringify(entry.adobeAnalytics, null, 2);
    }

    card.appendChild(header);
    card.appendChild(pre);
    listEl.appendChild(card);
  });
}

// Renders the audit summary with textContent only (entries may carry untrusted strings).
function renderStats(summary) {
  statsEl.innerHTML = '';
  function row(label, value) {
    const div = document.createElement('div');
    div.className = 'stat-row';
    const b = document.createElement('b');
    b.textContent = label + ': ';
    const span = document.createElement('span');
    span.textContent = value;
    div.appendChild(b);
    div.appendChild(span);
    statsEl.appendChild(div);
  }
  const pct = (n) => summary.total ? ` (${Math.round((n / summary.total) * 100)}%)` : '';
  row('OK', `${summary.byStatus.ok}${pct(summary.byStatus.ok)}`);
  row('Sin digitalData', `${summary.byStatus['no-data']}${pct(summary.byStatus['no-data'])}`);
  row('Errores', `${summary.byStatus.error}${pct(summary.byStatus.error)}`);
  row('Truncados', String(summary.truncated));
  row('Con Adobe Analytics', `${summary.adobe.with} / ${summary.total}`);
  summary.topErrors.forEach((e) => row(`Top error ×${e.count}`, e.message));
}

document.getElementById('downloadSummary').addEventListener('click', async () => {
  const { ddResults, ddTotal, ddStartedAt, ddFinishedAt } = await chrome.storage.local.get([
    'ddResults', 'ddTotal', 'ddStartedAt', 'ddFinishedAt'
  ]);
  const summary = buildSummary(orderedResults(ddResults || {}), { startedAt: ddStartedAt, finishedAt: ddFinishedAt });
  summary.generatedAt = new Date().toISOString();
  summary.expectedTotal = ddTotal || summary.total;
  const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `digitalData-resumen-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('downloadJson').addEventListener('click', async () => {
  const { ddResults } = await chrome.storage.local.get('ddResults');
  const combined = buildCombinedJson(ddResults || {});
  const blob = new Blob([JSON.stringify(combined, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `digitalData-resultados-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('copyJson').addEventListener('click', async () => {
  const { ddResults } = await chrome.storage.local.get('ddResults');
  const combined = buildCombinedJson(ddResults || {});
  await navigator.clipboard.writeText(JSON.stringify(combined, null, 2));
  const btn = document.getElementById('copyJson');
  const original = btn.textContent;
  btn.textContent = '¡Copiado!';
  setTimeout(() => (btn.textContent = original), 1200);
});

document.getElementById('refresh').addEventListener('click', loadResults);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') loadResults();
});

loadResults();
