// Optional local overrides (untracked). Copy config.example.js to config.local.js.
try { importScripts('config.local.js'); } catch (e) { /* no local config: Ford bypass stays disabled */ }
importScripts('lib/quota.js', 'lib/results.js', 'lib/status.js'); // pure helpers, also covered by node tests

// Tiempo extra tras "complete" para dejar que scripts async (analytics) definan digitalData
const POST_LOAD_WAIT_MS = 1500;
// Tiempo máximo de reintento buscando window.digitalData dentro de la página
const DIGITALDATA_MAX_WAIT_MS = 8000;
const DIGITALDATA_POLL_INTERVAL_MS = 500;
// Cuántos polls seguidos con el MISMO contenido debe mantener digitalData para
// aceptarlo. Las páginas suelen definir un digitalData inicial y enriquecerlo
// enseguida; quedarse con el primer valor truthy devolvía dato viejo como "ok".
const DIGITALDATA_STABLE_POLLS = 2;
// Si quieres que las pestañas NO se cierren automáticamente al terminar, pon esto en false
const CLOSE_TABS_AFTER_READ = true;
// Cuántas URLs se procesan en paralelo. Con listas largas (decenas/cientos),
// mantenerlo bajo evita saturar Chrome (memoria/CPU) y que el sitio te bloquee.
const CONCURRENCY = 5;
// Global per-URL timeout while waiting for a tab to report "complete".
const TAB_LOAD_TIMEOUT_MS = 25000;
// Per-entry cap so a single huge digitalData payload cannot blow the storage quota.
const MAX_ENTRY_BYTES = 256 * 1024;

// --- Throughput tuning (calibrate with real runs, e.g. 368 URLs in 12m05s) ---
// Blocking images/media/fonts while a job runs cuts load time without
// affecting data layers (scripts, XHR and documents are never blocked).
const BLOCK_HEAVY_RESOURCES = true;
const PERF_DNR_RULE_ID = 10;

// Ford AEM bypass: header + cookie required so wwwac.*.brand*.ford.com pages load instead of blocking.
const FORD_URL_REGEX = /^https:\/\/wwwac\..*\.brand.*\.ford\.com\/.*/i;
const FORD_EDGE_HEADER = 'X-AEM-Edge-Key';
const FORD_EDGE_VALUE = (globalThis.FORD_CONFIG && globalThis.FORD_CONFIG.edgeValue) || '';
const FORD_COOKIE_NAME = 'adbcld';
const FORD_COOKIE_VALUE = (globalThis.FORD_CONFIG && globalThis.FORD_CONFIG.cookieValue) || '';
const FORD_DNR_RULE_ID = 1;

const JOB_KEY = 'ddJob';
const RUNNING_KEY = 'ddJobRunning';
// Legacy single-key snapshot from older builds (read-only fallback).
const LEGACY_RESULTS_KEY = 'ddResults';
// Small, frequently written state (progress, next index, live tab ids). Kept
// apart from ddJob so finishing one URL never rewrites the whole URL list.
const PROGRESS_KEY = 'ddProgress';
// Failure marker shown by the popup/results page after an aborted run.
const JOB_ERROR_KEY = 'ddJobError';

// In-memory job for the current service worker lifetime. MV3 workers can be
// suspended at any time, so the durable state lives in chrome.storage.local and
// is rebuilt by maybeResume() when the worker wakes up again.
let activeJob = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'START_JOB') {
    startJob(msg.urls).then(
      sendResponse,
      (e) => sendResponse({ ok: false, reason: 'error', message: String(e) })
    );
    return true; // keep the channel open for the async response
  }
  if (msg.type === 'CANCEL_JOB') {
    cancelJob().then(
      sendResponse,
      (e) => sendResponse({ ok: false, reason: 'error', message: String(e) })
    );
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => {
  maybeResume();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureFordRequestRules().catch(() => {});
});

// ---- Ford AEM bypass (headers + cookie) ----

function isFordUrl(url) {
  try {
    return FORD_URL_REGEX.test(url);
  } catch (e) {
    return false;
  }
}

// Registers a dynamic declarativeNetRequest rule that injects X-AEM-Edge-Key
// on Ford URLs. Safe to call on every wakeup: rule id is stable.
async function ensureFordRequestRules() {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
    if (!FORD_EDGE_VALUE) return; // no local secret configured: skip Ford bypass
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [FORD_DNR_RULE_ID],
      addRules: [{
        id: FORD_DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: FORD_EDGE_HEADER, operation: 'set', value: FORD_EDGE_VALUE }]
        },
        condition: {
          regexFilter: '^https://wwwac\\..*\\.brand.*\\.ford\\.com/.*',
          resourceTypes: ['main_frame', 'sub_frame']
        }
      }]
    });
  } catch (e) {
    console.warn('DigitalData: failed to register Ford header rule', e);
  }
}

// Sets adbcld=true cookie for the URL origin so Ford AEM serves the page.
async function ensureFordCookie(url) {
  if (!isFordUrl(url)) return;
  if (!FORD_COOKIE_VALUE) return; // no local secret configured: skip Ford bypass
  try {
    const origin = new URL(url).origin;
    await chrome.cookies.set({ url: origin + '/', name: FORD_COOKIE_NAME, value: FORD_COOKIE_VALUE });
  } catch (e) {
    console.warn('DigitalData: failed to set Ford cookie', e);
  }
}

// ---- Job lifecycle ----

// Enables/disables the heavy-resource block while a job runs. Dynamic rules
// persist across service-worker restarts, so every enable path has a matching
// disable (finalize, cancel, worker startup).
async function ensurePerfRules(enable) {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
    if (enable && BLOCK_HEAVY_RESOURCES) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [PERF_DNR_RULE_ID],
        addRules: [{
          id: PERF_DNR_RULE_ID,
          priority: 1,
          action: { type: 'block' },
          condition: {
            urlFilter: '|http*',
            resourceTypes: ['image', 'media', 'font']
          }
        }]
      });
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [PERF_DNR_RULE_ID],
        addRules: []
      });
    }
  } catch (e) {
    console.warn('DigitalData: failed to update perf rules', e);
  }
}

async function startJob(urls) {
  if (activeJob) return { ok: false, reason: 'already-running' };
  if (!Array.isArray(urls) || !urls.length) return { ok: false, reason: 'no-urls' };

  const stored = await storageGet(RUNNING_KEY);
  // Re-check after the await: a concurrent START_JOB may have claimed the slot.
  if (activeJob) return { ok: false, reason: 'already-running' };
  if (stored[RUNNING_KEY]) return { ok: false, reason: 'already-running' };

  const record = {
    status: 'running',
    urls: urls.slice(),
    nextIndex: 0,
    startedAt: Date.now(),
    tabIds: []
  };
  // Claim the slot synchronously so a second START_JOB cannot slip in.
  activeJob = newJob(record, new Set());

  await ensureFordRequestRules().catch(() => {});
  await closeOrphanTabs(); // remove tabs left behind by a previous suspended run
  try {
    // Drop per-URL results plus the legacy snapshot so a new run cannot mix
    // with the previous one (and frees quota before the first write).
    await clearStoredResults();
    await storageSet({
      [RUNNING_KEY]: true,
      ddTotal: urls.length,
      ddStartedAt: record.startedAt,
      ddFinishedAt: null,
      [PROGRESS_KEY]: progressPayload(activeJob),
      [JOB_KEY]: snapshot(record)
    });
  } catch (e) {
    if (activeJob && activeJob.record === record) activeJob = null;
    throw e;
  }

  launchJob(activeJob);
  return { ok: true };
}

async function cancelJob() {
  if (!activeJob) return { ok: false, reason: 'no-job' };
  activeJob.handle.cancelled = true;
  await closeOrphanTabs();
  if (activeJob) activeJob.record.tabIds = [];
  return { ok: true };
}

// `done` is the set of indices already persisted. Payloads live in storage, so
// the worker never accumulates every response in memory.
function newJob(record, done) {
  return {
    record,
    done: done || new Set(),
    handle: { cancelled: false, failed: null },
    write: makeWriter()
  };
}

function progressPayload(job) {
  return {
    done: job.done.size,
    total: job.record.urls.length,
    nextIndex: job.record.nextIndex,
    tabIds: Array.isArray(job.record.tabIds) ? job.record.tabIds.slice() : []
  };
}

function launchJob(job) {
  runQueue(job).then(
    () => finalizeJob(job, true),
    () => finalizeJob(job, false)
  );
}

async function finalizeJob(job, openResults) {
  if (activeJob === job) activeJob = null;
  const failed = job.handle.failed;
  const userCancelled = job.handle.cancelled && !failed;
  await ensurePerfRules(false).catch(() => {});

  // Persist the final progress/status before opening results so a suspend right
  // after the last URL cannot leave a zombie "running" job behind.
  await persistProgress(job);
  job.record.status = failed ? 'aborted' : 'idle';
  job.record.tabIds = [];
  try {
    await storageSet({
      [RUNNING_KEY]: false,
      ddFinishedAt: Date.now(),
      [JOB_KEY]: snapshot(job.record)
    });
  } catch (e) {
    console.warn('DigitalData: failed to persist final job state', e);
  }

  // On a storage failure we still open results so the partial run is readable.
  if (openResults && !userCancelled) {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  }
}

// Rebuild an in-flight job after the service worker was suspended. Safe to call
// on every wakeup: it is a no-op unless a persisted job is still "running".
async function maybeResume() {
  if (activeJob) return;
  // Read the small job record first: waking the worker must not pull a whole
  // result set into memory when there is nothing to resume.
  const stored = await storageGet(JOB_KEY);
  const record = stored[JOB_KEY];
  if (!record || record.status !== 'running') return;
  if (activeJob) return; // a START_JOB may have claimed the slot while we awaited
  if (!Array.isArray(record.urls) || !record.urls.length) return;

  await closeOrphanTabs();

  // One full read only when a job is actually in flight.
  const all = await storageGet(null);
  const results = collectResults(all);
  const done = new Set(
    Object.keys(results)
      .map((key) => parseInt(key, 10))
      .filter((idx) => Number.isInteger(idx) && idx >= 0)
  );

  record.tabIds = [];
  record.nextIndex = firstIncompleteIndex(record.urls, done);

  const job = newJob(record, done);
  activeJob = job;
  await storageSet({
    [RUNNING_KEY]: true,
    ddTotal: record.urls.length,
    [PROGRESS_KEY]: progressPayload(job)
  }).catch(() => {});
  launchJob(job);
}

// Smallest index whose result is not stored yet; used to resume without
// re-processing already-completed URLs.
function firstIncompleteIndex(urls, done) {
  let i = 0;
  while (i < urls.length) {
    if (!done.has(i)) return i;
    i++;
  }
  return urls.length;
}

// ---- Queue ----

async function runQueue(job) {
  const { record, handle } = job;
  const urls = record.urls;
  await ensurePerfRules(true).catch(() => {});

  function claim() {
    while (record.nextIndex < urls.length) {
      const idx = record.nextIndex++;
      if (!job.done.has(idx)) return idx;
    }
    return -1;
  }

  async function worker() {
    for (;;) {
      if (handle.cancelled) return;
      const idx = claim();
      if (idx < 0) return;

      const entry = await processUrl(urls[idx], idx, job);
      if (!(await persistEntry(job, idx, entry))) return;
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker);
  await Promise.all(workers);
}

async function processUrl(url, idx, job) {
  const entry = { url, finalUrl: null, status: 'pending', digitalData: null, adobeAnalytics: null, error: null, truncated: false };
  let tab;

  try {
    await ensureFordCookie(url);
    tab = await chrome.tabs.create({ url, active: false });
    trackTab(job, tab.id);
    const loadOutcome = await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);

    // Capture the post-redirect URL: the data layer belongs to THIS page,
    // which may differ from the requested URL (locale/preview redirects,
    // error pages). Best effort; stays null if the tab is gone.
    let pageUrl = null;
    try {
      const current = await chrome.tabs.get(tab.id);
      if (current && current.url) {
        entry.finalUrl = current.url;
        pageUrl = current.url;
      }
    } catch (e) { /* tab already gone */ }

    // A closed tab or a network error page carries no data layer: say so
    // instead of reporting "sin digitalData" for a page that never loaded.
    if (loadOutcome === 'gone' || isErrorPageUrl(pageUrl)) {
      entry.status = 'error';
      entry.error = loadOutcome === 'gone'
        ? TAB_CLOSED_MESSAGE
        : 'Page failed to load: ' + pageUrl;
      return capEntry(entry, MAX_ENTRY_BYTES);
    }

    await sleep(POST_LOAD_WAIT_MS);

    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN', // MAIN world shares the page real window where digitalData and Adobe objects live
      func: extractPageAnalytics,
      args: [DIGITALDATA_MAX_WAIT_MS, DIGITALDATA_POLL_INTERVAL_MS, DIGITALDATA_STABLE_POLLS]
    });

    const payload = injection && injection[0] ? injection[0].result : null;
    if (!payload || typeof payload !== 'object') {
      const result = noDataResult(loadOutcome);
      entry.status = result.status;
      entry.error = result.error;
    } else {
      const dd = payload.dd !== undefined ? payload.dd : null;
      const aa = payload.aa !== undefined ? payload.aa : null;
      const hasAA = !!(aa && (aa.s || aa.satellite || aa.dataLayer));
      if (!dd && !hasAA) {
        const result = noDataResult(loadOutcome);
        entry.status = result.status;
        entry.error = result.error;
      } else {
        entry.digitalData = dd;
        entry.adobeAnalytics = hasAA ? aa : null;
        entry.status = 'ok';
      }
    }
  } catch (e) {
    entry.status = 'error';
    entry.error = e && e.message ? e.message : String(e);
  } finally {
    if (tab) {
      untrackTab(job, tab.id);
      if (CLOSE_TABS_AFTER_READ) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { /* ignore */ }
      }
    }
  }

  return capEntry(entry, MAX_ENTRY_BYTES);
}

// ---- Wait for tab load ----

// Resolves with 'complete', 'timeout' or 'gone' so the caller can report an
// honest status instead of treating every outcome as a loaded page.
function waitForTabComplete(tabId, timeoutMs) {
  return (async () => {
    // Check the current status before listening: if the tab already finished we
    // would otherwise wait forever for an event that will never fire again.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') return 'complete';
    } catch (e) {
      return 'gone'; // tab disappeared before we could attach
    }

    return await new Promise((resolve) => {
      let settled = false;
      function finish(outcome) {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve(outcome);
      }
      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo && changeInfo.status === 'complete') finish('complete');
      }
      chrome.tabs.onUpdated.addListener(listener);
      // Re-check: the tab may have completed between the get() above and the listener.
      chrome.tabs.get(tabId).then((tab) => {
        if (tab && tab.status === 'complete') finish('complete');
      }).catch(() => finish('gone'));
      // Global per-URL safety timeout if "complete" never arrives.
      const timer = setTimeout(() => finish('timeout'), timeoutMs || TAB_LOAD_TIMEOUT_MS);
    });
  })();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Tab tracking / orphan cleanup ----

function trackTab(job, tabId) {
  if (typeof tabId !== 'number') return;
  if (job.record.tabIds.indexOf(tabId) === -1) job.record.tabIds.push(tabId);
  persistProgress(job);
}

function untrackTab(job, tabId) {
  const i = job.record.tabIds.indexOf(tabId);
  if (i !== -1) job.record.tabIds.splice(i, 1);
  persistProgress(job);
}

// Close tabs recorded by a previous (suspended or aborted) run.
async function closeOrphanTabs() {
  let record;
  try {
    const stored = await storageGet(JOB_KEY);
    record = stored[JOB_KEY];
  } catch (e) {
    return;
  }
  const ids = record && Array.isArray(record.tabIds) ? record.tabIds : [];
  await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
  if (record) {
    record.tabIds = [];
    await storageSet({ [JOB_KEY]: snapshot(record) }).catch(() => {});
  }
}

// ---- Persistence helpers ----

function snapshot(record) {
  return {
    status: record.status,
    urls: record.urls,
    nextIndex: record.nextIndex,
    startedAt: record.startedAt,
    tabIds: Array.isArray(record.tabIds) ? record.tabIds.slice() : []
  };
}

// Persist only the tiny progress object. The URL list lives in ddJob and is
// written at start/finalize, so finishing one URL is O(1), not O(n).
async function persistProgress(job) {
  try {
    await job.write({ [PROGRESS_KEY]: progressPayload(job) });
    return true;
  } catch (e) {
    await handleStorageFailure(job, e);
    return false;
  }
}

// Persist one finished URL and its progress in the same queued write. One key
// per URL keeps storage cost linear and never re-serializes the whole run.
async function persistEntry(job, idx, entry) {
  // Mark first so concurrent workers never write a stale `done` count; a failed
  // write aborts the whole job anyway.
  job.done.add(idx);
  try {
    await job.write({
      [resultKey(idx)]: entry,
      [PROGRESS_KEY]: progressPayload(job)
    });
    return true;
  } catch (e) {
    job.done.delete(idx);
    await handleStorageFailure(job, e);
    return false;
  }
}

// A quota/full-disk failure used to be swallowed, so every later write failed
// too and the whole run was lost silently. Stop the queue, free the legacy
// snapshot and leave a small marker the UI can show.
async function handleStorageFailure(job, error) {
  if (job.handle.failed) return;
  const message = error && error.message ? error.message : String(error);
  job.handle.failed = /quota/i.test(message) ? 'storage-quota' : 'storage-write';
  job.handle.cancelled = true;
  console.warn('DigitalData: storage write failed, aborting job:', message);
  try { await removeKeys([LEGACY_RESULTS_KEY]); } catch (e) { /* ignore */ }
  try {
    await storageSet({
      [RUNNING_KEY]: false,
      [JOB_ERROR_KEY]: job.handle.failed,
      ddFinishedAt: Date.now()
    });
  } catch (e) {
    // Storage is still full: the in-memory flag already stops the queue and
    // the finalize path retries the marker.
  }
}

// Removes every per-URL result plus the legacy snapshot from older builds.
async function clearStoredResults() {
  const all = await storageGet(null);
  const keys = Object.keys(all || {}).filter((key) =>
    isResultKey(key) || key === LEGACY_RESULTS_KEY || key === JOB_ERROR_KEY
  );
  if (keys.length) await removeKeys(keys);
}

// Serialize storage writes so a slower write can never land after a newer one
// and overwrite it (progress counts in particular).
function makeWriter() {
  let chain = Promise.resolve();
  return function write(items) {
    chain = chain.then(() => storageSet(items), () => storageSet(items));
    return chain;
  };
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(items || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function removeKeys(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

// capEntry is provided by lib/quota.js (imported at the top of this worker).

// Esta función se inyecta y se ejecuta DENTRO de la página, no en la extensión.
// Debe ser autocontenida (sin referencias externas).
function extractPageAnalytics(maxWaitMs, intervalMs, stablePolls) {
  return new Promise((resolve) => {
    // In the MAIN world the page can tamper with globals, so capture the
    // references we depend on up front instead of trusting them at use time.
    const safeStringify = JSON.stringify;
    const safeIsArray = Array.isArray;
    const safeKeys = Object.keys;
    const safeNow = Date.now;
    const requiredPolls = stablePolls > 0 ? stablePolls : 1;
    const start = safeNow();

    // Algunos sitios exponen la variable como "digitalData" (estándar GTM/Adobe)
    // y otros como "digitaldata" (todo minúsculas); se revisan ambas.
    const candidateNames = ['digitalData', 'digitaldata'];
    // Scalar AppMeasurement fields worth keeping; functions and huge internals are dropped.
    const sFieldPattern = /^(account|pageName|channel|server|pageType|campaign|products|events|purchaseID|transactionID|state|zip|hier\d+|eVar\d+|prop\d+|list\d+|pev\d*|pe)$/;

    function sanitize(value, depth, stack) {
      if (depth > 20) throw new Error('digitalData is nested too deeply');
      if (value === null) return null;
      const t = typeof value;
      if (t === 'string' || t === 'number' || t === 'boolean') return value;
      if (t !== 'object') return undefined; // drop functions, symbols, bigint, undefined
      for (let i = 0; i < stack.length; i++) {
        if (stack[i] === value) throw new Error('digitalData contains a circular reference');
      }
      stack.push(value);
      let out;
      if (safeIsArray(value)) {
        out = [];
        for (let i = 0; i < value.length; i++) {
          const v = sanitize(value[i], depth + 1, stack);
          if (v !== undefined) out.push(v);
        }
      } else {
        out = {};
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const v = sanitize(value[k], depth + 1, stack);
          if (v !== undefined) out[k] = v;
        }
      }
      stack.pop();
      return out;
    }

    // Un digitalData definido pero vacío es muy común antes de que la página lo
    // llene: un objeto sin claves no es dato, y devolverlo cortaba la espera.
    function isPopulated(value) {
      if (!value || typeof value !== 'object') return false;
      if (safeIsArray(value)) return value.length > 0;
      return safeKeys(value).length > 0;
    }

    let lastSignature = null;
    let stableCount = 0;
    let best = null;

    function check() {
      const foundName = candidateNames.find((name) => typeof window[name] !== 'undefined');
      let dd = null;
      if (foundName) {
        try {
          const raw = window[foundName];
          if (raw !== null && typeof raw === 'object') {
            const clone = sanitize(raw, 0, []);
            if (clone !== null && typeof clone === 'object' && isPopulated(clone)) {
              // Valida que el serializador capturado pueda representar el clon y
              // sirve de firma para exigir que el payload se mantenga estable.
              const signature = safeStringify(clone);
              dd = clone;
              best = clone;
              if (signature === lastSignature) {
                stableCount++;
              } else {
                lastSignature = signature;
                stableCount = 1;
              }
            }
          }
        } catch (e) {
          dd = null; // never leak an __error object into the results contract
        }
      }
      if (dd && stableCount >= requiredPolls) {
        resolve({ dd: dd, aa: collectAdobe() });
      } else if (safeNow() - start > maxWaitMs) {
        // Nunca se estabilizó: devolvemos lo último visto (o null) en vez de
        // inventar un OK con el primer valor parcial.
        resolve({ dd: best, aa: collectAdobe() });
      } else {
        setTimeout(check, intervalMs);
      }
    }

    // Snapshot of Adobe Analytics state: AppMeasurement summary, Launch metadata
    // and adobeDataLayer events. Best effort; returns null when nothing is found.
    function collectAdobe() {
      let s = null;
      let satellite = null;
      let dataLayer = null;
      try {
        const sRaw = window.s;
        if (sRaw && typeof sRaw === 'object') {
          const out = {};
          const keys = Object.keys(sRaw);
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (!sFieldPattern.test(k)) continue;
            const v = sanitize(sRaw[k], 1, []);
            if (v !== undefined && v !== '') out[k] = v;
          }
          if (Object.keys(out).length) s = out;
        }
      } catch (e) { /* ignore */ }
      try {
        const sat = window._satellite;
        if (sat && typeof sat === 'object') {
          const info = {};
          try {
            if (sat.property && sat.property.name) info.property = String(sat.property.name);
          } catch (e) { /* ignore */ }
          try {
            if (sat.environment && sat.environment.stage) info.environment = String(sat.environment.stage);
          } catch (e) { /* ignore */ }
          try {
            if (sat.buildInfo && typeof sat.buildInfo === 'object') {
              const b = sanitize(sat.buildInfo, 0, []);
              if (b && typeof b === 'object') info.buildInfo = b;
            }
          } catch (e) { /* ignore */ }
          if (Object.keys(info).length) satellite = info;
        }
      } catch (e) { /* ignore */ }
      try {
        const adl = window.adobeDataLayer;
        if (adl && typeof adl.length === 'number') {
          const clean = sanitize(Array.prototype.slice.call(adl), 0, []);
          if (safeIsArray(clean) && clean.length) {
            dataLayer = {
              totalEvents: clean.length,
              events: clean.length > 50 ? clean.slice(0, 50) : clean,
              truncatedEvents: clean.length > 50
            };
          }
        }
      } catch (e) { /* ignore */ }
      if (!s && !satellite && !dataLayer) return null;
      return { s: s, satellite: satellite, dataLayer: dataLayer };
    }

    check();
  });
}

// Attempt to resume an interrupted job when the worker (re)starts.
maybeResume().catch(() => {});
ensureFordRequestRules().catch(() => {});
ensurePerfRules(false).catch(() => {}); // drop stale blocks from a killed run
