const listEl = document.getElementById('list');
const summaryEl = document.getElementById('summary');
const statsEl = document.getElementById('stats');
let lastEntries = [];
let entriesByIndex = new Map();
let cardEls = new Map();
let lastMeta = { total: 0, running: false, startedAt: null, finishedAt: null, jobError: null };
let reloadTimer = null;

function metaFromStorage(raw) {
  const job = raw.ddJob || {};
  return {
    total: raw.ddTotal || 0,
    running: !!raw.ddJobRunning,
    startedAt: raw.ddStartedAt,
    finishedAt: raw.ddFinishedAt,
    jobError: raw.ddJobError || null,
    site: job.site || null,
    // The submitted queue, kept so an export can name the URLs that never ran.
    urls: Array.isArray(job.urls) ? job.urls : []
  };
}

// Completeness of the run behind the current results: what was submitted versus
// what produced an entry. Computed on demand for downloads, and from lastMeta for
// the summary row.
function completenessOf(meta, done) {
  return captureCompleteness(
    { urls: meta && meta.urls ? meta.urls : [] },
    done,
    { expectedTotal: meta ? meta.total : 0, cancelled: !!(meta && meta.jobError === 'cancelled') }
  );
}

function describeJobError(code) {
  switch (code) {
    case 'storage-quota': return 'almacenamiento lleno (cuota)';
    case 'storage-write': return 'error de escritura en el almacenamiento';
    case 'cancelled': return 'cancelada';
    default: return code || 'error desconocido';
  }
}

function classifyEnv(url) {
  try {
    return (typeof isPreviewUrl === 'function' && isPreviewUrl(url)) ? 'preview' : 'prod';
  } catch (e) {
    return 'prod';
  }
}

// Diagnosis options live here because isPreviewUrl is a page global (lib/urls.js).
const DIAG_OPTIONS = {
  isPreviewUrl: (url) => classifyEnv(url) === 'preview'
};

// Which build produced an export. Without it, an export that lacks a new field
// cannot be told apart from a capture that simply did not produce it. The
// manifest version is the identifier Chrome guarantees, so it is bumped with
// every behavior change instead of being remembered by hand.
function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch (e) {
    return null;
  }
}

// A diagnosis is derived from the stored entry, never persisted: rules can
// change and the same run can be re-diagnosed without crawling again.
// Cached per index: renderSummary runs on every storage write, and re-diagnosing
// the whole list each time would be the O(n^2) trap the list rendering already has.
const diagnosisCache = new Map();

function diagnosisFor(idx, entry) {
  const cached = diagnosisCache.get(idx);
  if (cached) return cached;
  const diagnosis = diagnoseEntry(Object.assign({}, entry, { index: idx }), DIAG_OPTIONS);
  diagnosisCache.set(idx, diagnosis);
  return diagnosis;
}

function currentDiagnosis() {
  return summarizeDiagnosis(lastEntries.map(({ idx, entry }) => diagnosisFor(idx, entry)));
}

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

function buildCard(entry, idx) {
  const card = document.createElement('div');
  card.className = 'card';
  const diagnosis = diagnosisFor(idx, entry);

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
  if (entry.finalUrl && entry.finalUrl !== entry.url) {
    const redir = document.createElement('div');
    redir.className = 'redirect';
    redir.textContent = '→ ' + entry.finalUrl;
    card.appendChild(redir);
  }
  const chips = document.createElement('div');
  chips.className = 'chips';
  function chip(text, kind) {
    const span = document.createElement('span');
    span.className = 'chip' + (kind ? ' ' + kind : '');
    span.textContent = text;
    chips.appendChild(span);
  }
  if (entry.template === 'new') chip('Plantilla nueva', 'new');
  else if (entry.template === 'old') chip('Plantilla legacy', 'old');
  if (Array.isArray(entry.metrics_files) && entry.metrics_files.length) {
    chip(entry.metrics_files.join(', '), 'metric');
  }
  if (entry.has_fmc_context) chip('FMC.context', 'fmc');
  if (entry.has_aa_beacon) chip('Beacon AA', 'aa');
  if (entry.links_found) chip(entry.links_found + ' enlaces', 'links');
  diagnosis.problems.slice(0, 4).forEach((problem) => {
    chip(problem.code, 'sev-' + problem.severity);
  });
  if (diagnosis.problems.length > 4) {
    chip(`+${diagnosis.problems.length - 4} más`, 'sev-' + diagnosis.severity);
  }
  if (chips.childNodes.length) card.appendChild(chips);
  card.appendChild(pre);
  return card;
}

function renderSummary() {
  const meta = lastMeta;
  const done = lastEntries.length;
  const elapsed = formatElapsed(meta.startedAt, meta.running ? Date.now() : meta.finishedAt);
  const sitemapErrors = meta.site && Array.isArray(meta.site.sitemapErrors) ? meta.site.sitemapErrors.length : 0;
  const cappedNote = meta.site && meta.site.capped ? ' · tope de URLs alcanzado' : '';
  const siteNote = meta.site
    ? ` · sitio (prof. ${meta.site.maxDepth})${sitemapErrors ? ` · sitemap no leído en ${sitemapErrors}` : ''}${cappedNote}`
    : '';
  if (meta.jobError === 'cancelled') {
    summaryEl.textContent = `Corrida cancelada · ${done}/${meta.total || done} procesadas · ${elapsed}${siteNote}`;
  } else if (meta.jobError) {
    summaryEl.textContent = `Corrida detenida por ${describeJobError(meta.jobError)} · ${done}/${meta.total || done} procesadas · ${elapsed}${siteNote}`;
  } else if (meta.running) {
    summaryEl.textContent = `Procesando... ${done}/${meta.total || 0} · ${elapsed}${siteNote}`;
  } else {
    summaryEl.textContent = `${done}/${meta.total || done} URLs procesadas en ${elapsed}${siteNote}`;
  }
  renderStats(buildSummary(lastEntries, {
    startedAt: meta.startedAt,
    finishedAt: meta.running ? Date.now() : meta.finishedAt
  }, classifyEnv), currentDiagnosis(), completenessOf(meta, lastEntries.map(({ idx }) => idx)));
}

function renderList(entries) {
  listEl.innerHTML = '';
  cardEls = new Map();
  diagnosisCache.clear();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Todavía no hay resultados. Ejecuta un análisis desde el popup de la extensión.';
    listEl.appendChild(empty);
    return;
  }
  entries.forEach(({ idx, entry }) => {
    const card = buildCard(entry, idx);
    cardEls.set(idx, card);
    listEl.appendChild(card);
  });
}

function applyResults(results, meta) {
  lastMeta = meta;
  lastEntries = orderedResults(results);
  entriesByIndex = new Map(lastEntries.map(({ idx, entry }) => [idx, entry]));
  renderList(lastEntries);
  renderSummary();
}

// One new result: rebuild only its card and the (cheap) summary. Rendering the
// whole list on every storage write froze the tab on long runs.
function upsertResult(idx, entry) {
  entriesByIndex.set(idx, entry);
  lastEntries = orderedResults(Object.fromEntries(entriesByIndex));

  diagnosisCache.delete(idx);
  const card = buildCard(entry, idx);
  const existing = cardEls.get(idx);
  if (existing) {
    existing.replaceWith(card);
  } else {
    const empty = listEl.querySelector('.empty');
    if (empty) empty.remove();
    const next = lastEntries.find(({ idx: i }) => i > idx);
    const nextEl = next ? cardEls.get(next.idx) : null;
    if (nextEl) listEl.insertBefore(card, nextEl);
    else listEl.appendChild(card);
  }
  cardEls.set(idx, card);
  renderSummary();
}

async function loadResults() {
  const raw = await chrome.storage.local.get(null);
  applyResults(collectResults(raw), metaFromStorage(raw));
}

async function refreshMeta() {
  const raw = await chrome.storage.local.get([
    'ddTotal', 'ddJobRunning', 'ddStartedAt', 'ddFinishedAt', 'ddJobError', 'ddJob'
  ]);
  lastMeta = metaFromStorage(raw);
  renderSummary();
}

async function readStoredResults() {
  const raw = await chrome.storage.local.get(null);
  return collectResults(raw);
}

// One full read that also carries what the results cannot say on their own:
// which URLs were submitted, and whether the run finished them all.
async function readSnapshot() {
  const raw = await chrome.storage.local.get(null);
  const results = collectResults(raw);
  const meta = metaFromStorage(raw);
  return {
    results,
    meta,
    completeness: completenessOf(meta, Object.keys(results))
  };
}

// Renders the audit summary with textContent only (entries may carry untrusted strings).
function renderStats(summary, diagnosis, completeness) {
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
  row('Prod OK / sin DD / errores',
    `${summary.byEnv.prod.ok} / ${summary.byEnv.prod['no-data']} / ${summary.byEnv.prod.error}`);
  row('Preview OK / sin DD / errores',
    `${summary.byEnv.preview.ok} / ${summary.byEnv.preview['no-data']} / ${summary.byEnv.preview.error}`);
  row('Truncados', String(summary.truncated));
  row('Con Adobe Analytics', `${summary.adobe.with} / ${summary.total}`);
  row('Plantilla nueva / legacy',
    `${summary.byTemplate.new} / ${summary.byTemplate.old}${summary.byTemplate.unknown ? ` (+${summary.byTemplate.unknown} sin dato)` : ''}`);
  row('Con FMC.context', `${summary.fmcContext.with} / ${summary.total}`);
  row('Con beacon Adobe', `${summary.aaBeacon.with} / ${summary.total}`);
  if (completeness) {
    // Never let the report look complete when it is not: a cancelled run drops
    // the captures that were in flight and no other row would show it.
    if (completeness.complete) {
      row('Medici\u00f3n', `${completeness.captured}/${completeness.expectedTotal} URLs (completa)`);
    } else {
      row('Medici\u00f3n',
        `${completeness.captured}/${completeness.expectedTotal} URLs` +
        `${completeness.cancelled ? ' \u00b7 CORRIDA CANCELADA' : ''}` +
        ` \u00b7 sin medir: ${completeness.notCaptured}`);
    }
  }
  if (diagnosis) {
    row('Con problemas', `${diagnosis.withProblems} / ${diagnosis.total}`);
    row('Problemas de sitio (alta/media/baja)',
      `${diagnosis.bySiteSeverity.high} / ${diagnosis.bySiteSeverity.medium} / ${diagnosis.bySiteSeverity.low}`);
    const topCode = Object.keys(diagnosis.byCode)
      .map((code) => ({ code, count: diagnosis.byCode[code] }))
      .sort((a, b) => b.count - a.count)[0];
    if (topCode) row('Código más frecuente', `${topCode.code} ×${topCode.count}`);
  }
  summary.topErrors.forEach((e) => row(`Top error ×${e.count}`, e.message));
  if (summary.byStatus.error > 0) {
    const btn = document.createElement('button');
    btn.className = 'link-btn';
    btn.textContent = `Ver detalle de los ${summary.byStatus.error} errores`;
    btn.addEventListener('click', openErrorModal);
    const div = document.createElement('div');
    div.className = 'stat-row';
    div.appendChild(btn);
    statsEl.appendChild(div);
  }
}

// Modal with one row per failed URL (textContent only: URLs and errors are untrusted).
function openErrorModal() {
  const list = document.getElementById('modalList');
  list.innerHTML = '';
  const errs = lastEntries.filter(({ entry }) => entry && entry.status === 'error');
  if (!errs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Sin errores en esta corrida.';
    list.appendChild(empty);
  }
  errs.forEach(({ entry }) => {
    const item = document.createElement('div');
    item.className = 'modal-item';
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = entry.url;
    const msg = document.createElement('div');
    msg.className = 'modal-error';
    msg.textContent = entry.error || 'unknown';
    item.appendChild(url);
    item.appendChild(msg);
    list.appendChild(item);
  });
  document.getElementById('modal').classList.add('open');
}

function closeErrorModal() {
  document.getElementById('modal').classList.remove('open');
}

document.getElementById('downloadSummary').addEventListener('click', async () => {
  const snap = await readSnapshot();
  const summary = buildSummary(orderedResults(snap.results), {
    startedAt: snap.meta.startedAt,
    finishedAt: snap.meta.finishedAt
  }, classifyEnv);
  summary.generatedAt = new Date().toISOString();
  summary.expectedTotal = snap.completeness.expectedTotal;
  summary.completeness = snap.completeness;
  summary.extensionVersion = extensionVersion();
  const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `digitalData-resumen-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

function downloadFile(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('downloadJson').addEventListener('click', async () => {
  const results = await readStoredResults();
  downloadFile(`digitalData-resultados-${Date.now()}.json`, buildCombinedJson(results));
});

document.getElementById('downloadDD').addEventListener('click', async () => {
  const results = await readStoredResults();
  downloadFile(`digitalData-dd-${Date.now()}.json`, buildDDJson(results));
});

document.getElementById('downloadAA').addEventListener('click', async () => {
  const results = await readStoredResults();
  downloadFile(`digitalData-aa-${Date.now()}.json`, buildAAJson(results));
});

document.getElementById('downloadDiagnosis').addEventListener('click', async () => {
  const snap = await readSnapshot();
  const items = orderedResults(snap.results).map(({ idx, entry }) => Object.assign({}, entry, { index: idx }));
  const diagnoses = diagnoseEntries(items, DIAG_OPTIONS);
  downloadFile(`digitalData-problemas-${Date.now()}.json`, {
    generatedAt: new Date().toISOString(),
    // When the run happened, next to when the diagnosis was produced: a report
    // without its own date cannot be defended months later.
    runStartedAt: snap.meta.startedAt || null,
    runFinishedAt: snap.meta.finishedAt || null,
    extensionVersion: extensionVersion(),
    rulesVersion: RULES_VERSION,
    // What was submitted versus what produced an entry. Without this the report
    // cannot tell a finished run from one that was cancelled mid-queue.
    completeness: snap.completeness,
    summary: summarizeDiagnosis(diagnoses),
    results: diagnoses
  });
});

document.getElementById('copyJson').addEventListener('click', async () => {
  const results = await readStoredResults();
  const combined = buildCombinedJson(results);
  const btn = document.getElementById('copyJson');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(JSON.stringify(combined, null, 2));
    btn.textContent = '¡Copiado!';
  } catch (e) {
    btn.textContent = 'No se pudo copiar';
  }
  setTimeout(() => (btn.textContent = original), 1200);
});

document.getElementById('refresh').addEventListener('click', loadResults);

document.getElementById('modalClose').addEventListener('click', closeErrorModal);
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target && e.target.id === 'modal') closeErrorModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeErrorModal();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);

  // A new run removes the previous result keys; rebuild from scratch.
  const cleared = keys.some((key) =>
    changes[key].newValue === undefined && (isResultKey(key) || key === 'ddResults' || key === 'ddJob')
  );
  if (cleared) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadResults, 150);
    return;
  }

  keys.filter(isResultKey).forEach((key) => {
    const idx = parseInt(key.slice(RESULT_PREFIX.length), 10);
    const entry = changes[key].newValue;
    if (!Number.isInteger(idx) || !entry) return;
    upsertResult(idx, entry);
  });

  if (keys.some((key) => key === 'ddJobRunning' || key === 'ddJobError' ||
      key === 'ddFinishedAt' || key === 'ddStartedAt' || key === 'ddTotal' || key === 'ddJob')) {
    refreshMeta();
  }
});

loadResults();
