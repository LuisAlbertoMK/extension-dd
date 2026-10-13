// Optional local overrides (untracked). Copy config.example.js to config.local.js.
try { importScripts('config.local.js'); } catch (e) { /* no local config: Ford bypass stays disabled */ }

// Tiempo extra tras "complete" para dejar que scripts async (analytics) definan digitalData
const POST_LOAD_WAIT_MS = 1500;
// Tiempo máximo de reintento buscando window.digitalData dentro de la página
const DIGITALDATA_MAX_WAIT_MS = 8000;
const DIGITALDATA_POLL_INTERVAL_MS = 500;
// Si quieres que las pestañas NO se cierren automáticamente al terminar, pon esto en false
const CLOSE_TABS_AFTER_READ = true;
// Cuántas URLs se procesan en paralelo. Con listas largas (decenas/cientos),
// mantenerlo bajo evita saturar Chrome (memoria/CPU) y que el sitio te bloquee.
const CONCURRENCY = 5;
// Global per-URL timeout while waiting for a tab to report "complete".
const TAB_LOAD_TIMEOUT_MS = 25000;
// Per-entry cap so a single huge digitalData payload cannot blow the storage quota.
const MAX_ENTRY_BYTES = 256 * 1024;

// Ford AEM bypass: header + cookie required so wwwac.*.brand*.ford.com pages load instead of blocking.
const FORD_URL_REGEX = /^https:\/\/wwwac\..*\.brand.*\.ford\.com\/.*/i;
const FORD_EDGE_HEADER = 'X-AEM-Edge-Key';
const FORD_EDGE_VALUE = (globalThis.FORD_CONFIG && globalThis.FORD_CONFIG.edgeValue) || '';
const FORD_COOKIE_NAME = 'adbcld';
const FORD_COOKIE_VALUE = (globalThis.FORD_CONFIG && globalThis.FORD_CONFIG.cookieValue) || '';
const FORD_DNR_RULE_ID = 1;

const JOB_KEY = 'ddJob';
const RESULTS_KEY = 'ddResults';
const RUNNING_KEY = 'ddJobRunning';
// Minimum gap between results snapshots flushed while a job runs. Parallel
// workers accumulate into memory; throttling avoids re-serializing the whole
// result set on every single URL, while finalizeJob() still guarantees a final
// write so no completed result is lost.
const RESULTS_FLUSH_INTERVAL_MS = 1000;

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
  activeJob = newJob(record, {});

  await ensureFordRequestRules().catch(() => {});
  await closeOrphanTabs(); // remove tabs left behind by a previous suspended run
  await storageSet({
    [RUNNING_KEY]: true,
    ddTotal: urls.length,
    [RESULTS_KEY]: {},
    ddStartedAt: record.startedAt,
    [JOB_KEY]: snapshot(record)
  });

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

function newJob(record, results) {
  return {
    record,
    results,
    handle: { cancelled: false },
    write: makeWriter(),
    resultsFlushTimer: null,
    lastResultsFlushAt: 0
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
  const cancelled = job.handle.cancelled;

  // Drop any pending throttled flush and persist the final accumulated snapshot
  // so a late suspend cannot lose the last batch of results.
  if (job.resultsFlushTimer) {
    clearTimeout(job.resultsFlushTimer);
    job.resultsFlushTimer = null;
  }
  await commitResults(job);

  storageSet({ [RUNNING_KEY]: false, ddFinishedAt: Date.now() }).catch(() => {});
  job.record.status = 'idle';
  job.record.tabIds = [];
  job.write({ [JOB_KEY]: snapshot(job.record) }).catch(() => {});

  if (openResults && !cancelled) {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  }
}

// Rebuild an in-flight job after the service worker was suspended. Safe to call
// on every wakeup: it is a no-op unless a persisted job is still "running".
async function maybeResume() {
  if (activeJob) return;
  const stored = await storageGet(JOB_KEY);
  const record = stored[JOB_KEY];
  if (!record || record.status !== 'running') return;
  if (activeJob) return; // a START_JOB may have claimed the slot while we awaited
  if (!Array.isArray(record.urls) || !record.urls.length) return;

  await closeOrphanTabs();

  const res = await storageGet(RESULTS_KEY);
  const results = res[RESULTS_KEY] || {};

  record.tabIds = [];
  record.nextIndex = firstIncompleteIndex(record.urls, results);

  const job = newJob(record, results);
  activeJob = job;
  await storageSet({ [RUNNING_KEY]: true, ddTotal: record.urls.length }).catch(() => {});
  launchJob(job);
}

// Smallest index whose result is not stored yet; used to resume without
// re-processing already-completed URLs.
function firstIncompleteIndex(urls, results) {
  let i = 0;
  while (i < urls.length) {
    if (!Object.prototype.hasOwnProperty.call(results, `${i}__${urls[i]}`)) return i;
    i++;
  }
  return urls.length;
}

// ---- Queue ----

async function runQueue(job) {
  const { record, handle } = job;
  const urls = record.urls;

  function claim() {
    while (record.nextIndex < urls.length) {
      const idx = record.nextIndex++;
      if (!Object.prototype.hasOwnProperty.call(job.results, `${idx}__${urls[idx]}`)) {
        return idx;
      }
    }
    return -1;
  }

  async function worker() {
    for (;;) {
      if (handle.cancelled) return;
      const idx = claim();
      if (idx < 0) return;

      await persistProgress(job);
      const key = `${idx}__${urls[idx]}`;
      const entry = await processUrl(urls[idx], idx, job);
      job.results[key] = entry;
      await commitResults(job);
      persistProgress(job);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker);
  await Promise.all(workers);
}

async function processUrl(url, idx, job) {
  const entry = { url, status: 'pending', digitalData: null, error: null, truncated: false };
  let tab;

  try {
    await ensureFordCookie(url);
    tab = await chrome.tabs.create({ url, active: false });
    trackTab(job, tab.id);
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    await sleep(POST_LOAD_WAIT_MS);

    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN', // el mundo "MAIN" comparte el window real de la página, donde vive digitalData
      func: extractDigitalData,
      args: [DIGITALDATA_MAX_WAIT_MS, DIGITALDATA_POLL_INTERVAL_MS]
    });

    const result = injection && injection[0] ? injection[0].result : null;
    entry.digitalData = result;
    entry.status = result ? 'ok' : 'no-data';
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

function waitForTabComplete(tabId, timeoutMs) {
  return (async () => {
    // Check the current status before listening: if the tab already finished we
    // would otherwise wait forever for an event that will never fire again.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') return;
    } catch (e) {
      return; // tab disappeared before we could attach
    }

    await new Promise((resolve) => {
      let settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo && changeInfo.status === 'complete') finish();
      }
      chrome.tabs.onUpdated.addListener(listener);
      // Re-check: the tab may have completed between the get() above and the listener.
      chrome.tabs.get(tabId).then((tab) => {
        if (tab && tab.status === 'complete') finish();
      }).catch(() => finish());
      // Global per-URL safety timeout if "complete" never arrives.
      const timer = setTimeout(finish, timeoutMs || TAB_LOAD_TIMEOUT_MS);
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

async function persistProgress(job) {
  try {
    await job.write({ [JOB_KEY]: snapshot(job.record) });
  } catch (e) {
    console.warn('DigitalData: failed to persist job progress', e);
  }
}

async function commitResults(job) {
  // Full-snapshot write from the in-memory accumulator: no concurrent
  // read-modify-write of chrome.storage, so parallel workers cannot clobber
  // each other's results.
  const data = {};
  Object.keys(job.results).forEach((k) => { data[k] = job.results[k]; });
  try {
    await job.write({ [RESULTS_KEY]: data });
  } catch (e) {
    console.warn('DigitalData: failed to persist results', e);
  }
}

// Serialize storage writes so whole-snapshot writes never land out of order and
// overwrite a newer one.
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

// Cap a single result entry so one huge payload cannot exhaust the storage quota.
function capEntry(entry, maxBytes) {
  let serialized = '';
  try {
    serialized = JSON.stringify(entry.digitalData);
  } catch (e) {
    serialized = '';
  }
  if (serialized && serialized.length > maxBytes) {
    entry.digitalData = serialized.slice(0, maxBytes);
    entry.truncated = true;
  }
  return entry;
}

// Esta función se inyecta y se ejecuta DENTRO de la página, no en la extensión.
// Debe ser autocontenida (sin referencias externas).
function extractDigitalData(maxWaitMs, intervalMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    // Algunos sitios exponen la variable como "digitalData" (estándar GTM/Adobe)
    // y otros como "digitaldata" (todo minúsculas); se revisan ambas.
    const candidateNames = ['digitalData', 'digitaldata'];

    // In the MAIN world the page can tamper with globals, so capture the
    // references we depend on up front instead of trusting them at use time.
    const safeStringify = JSON.stringify;
    const safeIsArray = Array.isArray;

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

    function check() {
      const foundName = candidateNames.find((name) => typeof window[name] !== 'undefined');
      if (foundName) {
        try {
          const raw = window[foundName];
          if (raw === null || typeof raw !== 'object') {
            resolve(null); // not a digitalData object: keep the typed contract
            return;
          }
          const clone = sanitize(raw, 0, []);
          if (clone === null || typeof clone !== 'object') {
            resolve(null);
            return;
          }
          // Validate that the captured serializer can represent the clone.
          safeStringify(clone);
          resolve(clone);
        } catch (e) {
          resolve(null); // never leak an __error object into the results contract
        }
      } else if (Date.now() - start > maxWaitMs) {
        resolve(null);
      } else {
        setTimeout(check, intervalMs);
      }
    }

    check();
  });
}

// Attempt to resume an interrupted job when the worker (re)starts.
maybeResume().catch(() => {});
ensureFordRequestRules().catch(() => {});
