// Optional local overrides (untracked). Copy config.example.js to config.local.js.
try { importScripts('config.local.js'); } catch (e) { /* no local config: Ford bypass stays disabled */ }
importScripts('lib/quota.js', 'lib/results.js', 'lib/status.js', 'lib/site.js', 'lib/urls.js'); // pure helpers, also covered by node tests

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
// Ford/Akamai: una ráfaga de pestañas desde una sola IP se parece a un crawler.
// 3 en paralelo + NAV_STAGGER_MS deja ~1 navegación por segundo.
const CONCURRENCY = 3;
// Separación mínima entre el inicio de dos navegaciones (más jitter). Sin esto,
// los workers arrancan a la vez y el borde ve un burst, no una visita humana.
// La suite de integración la baja a 0 por contexto (DD_TEST_NAV_STAGGER_MS).
const NAV_STAGGER_MS = Number.isFinite(globalThis.DD_TEST_NAV_STAGGER_MS)
  ? globalThis.DD_TEST_NAV_STAGGER_MS
  : 800;
// Global per-URL timeout while waiting for a tab to report "complete".
const TAB_LOAD_TIMEOUT_MS = 25000;
// Per-entry cap so a single huge digitalData payload cannot blow the storage quota.
const MAX_ENTRY_BYTES = 256 * 1024;

// --- Site mode (sitemap + spider discovery) ---
// A site run starts from seed URLs (usually one host root per market), expands
// the queue with the host sitemap and with same-host links found while walking.
// Depth 0 = seed, 1 = sitemap URLs, 2 = links found on those pages.
const SITE_MAX_DEPTH_DEFAULT = 2;
const SITE_MAX_DEPTH_LIMIT = 3;
// Bounds the per-page link harvest so one page with a huge footer cannot flood
// the queue (and the storage record).
const SITE_MAX_LINKS_PER_PAGE = 400;
const SITE_MAX_SITEMAP_CHILDREN = 30;
// Hard ceiling for a site run: a production sitemap can list thousands of URLs,
// which would never finish inside a browser session.
const SITE_MAX_URLS = 800;
// A sitemap fetch that never answers must not freeze the run: the watchdog would
// only see "no progress" and restart into the same hang.
const SITE_FETCH_TIMEOUT_MS = 15000;

// --- Watchdog ---
// MV3 may kill the service worker mid-run. Without a periodic wake-up nothing
// brings the queue back until the popup is opened, so the run stays frozen with
// ddJobRunning=true. The alarm wakes the worker, resumes the job and restarts a
// queue that stopped producing results.
const WATCHDOG_ALARM = 'ddWatchdog';
const WATCHDOG_PERIOD_MINUTES = 1;
// No persisted result for this long means the in-memory queue is stuck (hung
// tabs, a killed injection). A single URL costs at most TAB_LOAD_TIMEOUT_MS +
// DIGITALDATA_MAX_WAIT_MS (~33s), so 2 minutes is comfortably above normal.
const WATCHDOG_STALL_MS = 120000;

// --- Retry ---
// One retry for transient infrastructure failures (throttled tab creation, a
// discarded tab), with full jitter so parallel workers do not retry in lockstep.
// Deterministic answers (network error pages, load timeouts) are never retried:
// it would double the wall time for exactly the same verdict.
const RETRY_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 400;

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
// Reentrancy latch: the top-level maybeResume(), onStartup and the watchdog
// alarm can all fire at once and would otherwise launch two queues over the
// same record (double tabs, fighting progress writes).
let resumeInFlight = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'START_JOB') {
    startJob(msg.urls, msg.site).then(
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

// The watchdog alarm is the only thing that can wake a suspended worker while a
// job is in flight, so it is registered unconditionally (guarded for the test
// harness and for browsers without the alarms API).
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === WATCHDOG_ALARM) watchdogTick().catch(() => {});
  });
}

chrome.runtime.onStartup.addListener(() => {
  maybeResume();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureFordRequestRules().catch(() => {});
});

// ---- HTTP status of the final main-frame response ----

// The status code is the only way to tell "this page has no data layer" from "the
// edge refused to serve it" (403/429) or "the URL is dead" (404/410). webRequest is
// read-only here: it never blocks anything.
const HTTP_STATUS_BY_TAB = new Map();

if (chrome.webRequest && chrome.webRequest.onCompleted) {
  try {
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (details && details.tabId >= 0 && details.type === 'main_frame') {
          HTTP_STATUS_BY_TAB.set(details.tabId, details.statusCode);
        }
      },
      { urls: ['<all_urls>'], types: ['main_frame'] }
    );
  } catch (e) {
    // The status is optional evidence: a registration failure must never stop
    // the worker from capturing the data layer.
  }
}

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

// Normalizes the optional site-audit request. `null` means a plain URL-list run,
// which keeps the previous behavior byte for byte.
function siteMode(site) {
  if (!site || typeof site !== 'object') return null;
  const raw = Number(site.maxDepth);
  const maxDepth = Number.isFinite(raw) ? Math.round(raw) : SITE_MAX_DEPTH_DEFAULT;
  return {
    maxDepth: Math.max(0, Math.min(SITE_MAX_DEPTH_LIMIT, maxDepth)),
    discovered: 0,
    sitemapErrors: [],
    discoveredDone: false,
    // Set when the sitemap/spider hit SITE_MAX_URLS: the run is complete but the
    // site is not, and the report must say so instead of looking exhaustive.
    capped: false
  };
}

async function startJob(urls, site) {
  // A cancelled job is not a running job: it is only draining its in-flight
  // URLs, so a new run is allowed to take over.
  if (activeJob && !activeJob.handle.cancelled) return { ok: false, reason: 'already-running' };
  if (!Array.isArray(urls) || !urls.length) return { ok: false, reason: 'no-urls' };

  const stored = await storageGet(RUNNING_KEY);
  // Re-check after the await: a concurrent START_JOB may have claimed the slot.
  if (activeJob && !activeJob.handle.cancelled) return { ok: false, reason: 'already-running' };
  if (stored[RUNNING_KEY]) return { ok: false, reason: 'already-running' };

  // Supersede the draining job only once this run is cleared to start, so its
  // finalize cannot overwrite the state we are about to write.
  if (activeJob) {
    activeJob.handle.superseded = true;
    activeJob = null;
  }

  const record = {
    status: 'running',
    urls: urls.slice(),
    // Parallel to urls: crawl depth per entry (0 for a plain URL list).
    depths: urls.map(() => 0),
    // Seed count is frozen so a resume can rebuild the host allow-list even
    // after discovery appended hundreds of URLs.
    seedCount: urls.length,
    nextIndex: 0,
    startedAt: Date.now(),
    tabIds: [],
    site: siteMode(site)
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

// Cancelling must work even when the worker was suspended and the in-memory job
// is gone: the persisted record is the source of truth then. The terminal state
// is written here and not only in finalizeJob, so the popup flips immediately
// and a worker killed while draining cannot leave a zombie "running" job.
async function cancelJob() {
  const job = activeJob;
  if (job) job.handle.cancelled = true;

  await closeOrphanTabs();
  if (job) job.record.tabIds = [];

  let record = job ? job.record : null;
  let existingError = job ? job.handle.failed : null;
  if (!record) {
    try {
      const stored = await storageGet([JOB_KEY, JOB_ERROR_KEY]);
      record = stored[JOB_KEY] || null;
      existingError = stored[JOB_ERROR_KEY] || null;
    } catch (e) {
      record = null;
    }
  }
  // Nothing to cancel, or the run already ended. A storage failure is not a
  // cancellation: it keeps its own marker.
  if (!record || record.status !== 'running' || existingError) {
    return job ? { ok: true } : { ok: false, reason: 'no-job' };
  }

  record.status = 'cancelled';
  record.tabIds = [];
  try {
    await storageSet({
      [RUNNING_KEY]: false,
      ddFinishedAt: Date.now(),
      [JOB_ERROR_KEY]: 'cancelled',
      [JOB_KEY]: snapshot(record)
    });
  } catch (e) {
    console.warn('DigitalData: failed to persist the cancelled job state', e);
  }
  // Disarm after the terminal state is stored, so a worker killed in between is
  // still woken up (and then finds a job that is no longer running).
  await ensureWatchdog(false);
  return { ok: true };
}

// `done` is the set of indices already persisted. Payloads live in storage, so
// the worker never accumulates every response in memory.
function newJob(record, done) {
  // Dedupe key set for the crawl queue. Rebuilt from the persisted list so a
  // resumed run never re-enqueues a URL it already discovered.
  const seen = new Set();
  (Array.isArray(record.urls) ? record.urls : []).forEach((url) => {
    const key = normalizeQueueUrl(url);
    if (key) seen.add(key);
  });
  // Hosts a discovered URL must belong to: the seed hosts only, so a footer link
  // to another market never widens the run.
  const seeds = Array.isArray(record.urls)
    ? record.urls.slice(0, record.seedCount || (record.site ? record.urls.length : 0))
    : [];
  const hostSet = new Set(seeds.map(hostOf).filter(Boolean));
  return {
    record,
    done: done || new Set(),
    seen,
    hostSet,
    handle: { cancelled: false, failed: null, superseded: false },
    // In-memory heartbeat for the watchdog; `at` in the progress payload is its
    // persisted twin, so a worker that dies mid-run can still be judged stalled.
    lastProgressAt: Date.now(),
    write: makeWriter()
  };
}

// Building a payload is the heartbeat: every write carries the moment it was
// assembled, which is what watchdogTick() uses to tell "busy" from "stuck".
function progressPayload(job) {
  job.lastProgressAt = Date.now();
  return {
    done: job.done.size,
    total: job.record.urls.length,
    nextIndex: job.record.nextIndex,
    tabIds: Array.isArray(job.record.tabIds) ? job.record.tabIds.slice() : [],
    at: job.lastProgressAt
  };
}

function launchJob(job) {
  // Arm the watchdog before the queue's first await: if the worker is killed
  // moments later, the alarm is what wakes it up again.
  ensureWatchdog(true).catch(() => {});
  runQueue(job).then(
    () => finalizeJob(job, true),
    () => finalizeJob(job, false)
  );
}

async function finalizeJob(job, openResults) {
  if (activeJob === job) activeJob = null;
  // A superseded job (watchdog restart, or a new run taking over a cancelled
  // one) must not touch state a newer queue now owns: no perf/watchdog toggle,
  // no RUNNING_KEY, no results tab.
  if (job.handle.superseded) return;

  const failed = job.handle.failed;
  const userCancelled = job.handle.cancelled && !failed;
  await ensurePerfRules(false).catch(() => {});

  // Persist the final progress/status before opening results so a suspend right
  // after the last URL cannot leave a zombie "running" job behind.
  await persistProgress(job);
  job.record.status = failed ? 'aborted' : userCancelled ? 'cancelled' : 'idle';
  job.record.tabIds = [];
  try {
    const finalState = {
      [RUNNING_KEY]: false,
      ddFinishedAt: Date.now(),
      [JOB_KEY]: snapshot(job.record)
    };
    // Leave a marker so the popup reports a deliberate cancel instead of a run
    // that simply stopped early.
    if (userCancelled) finalState[JOB_ERROR_KEY] = 'cancelled';
    await storageSet(finalState);
  } catch (e) {
    console.warn('DigitalData: failed to persist final job state', e);
  }
  // Disarm only once the terminal state is stored: if the worker is killed
  // before that write lands, the alarm still wakes it to finish the job.
  await ensureWatchdog(false);

  // On a storage failure we still open results so the partial run is readable.
  if (openResults && !userCancelled) {
    chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
  }
}

// Rebuild an in-flight job after the service worker was suspended. Safe to call
// on every wakeup: it is a no-op unless a persisted job is still "running".
async function maybeResume() {
  // resumeInFlight also blocks the top-level call, onStartup and the watchdog
  // from launching two queues over the same record.
  if (activeJob || resumeInFlight) return;
  resumeInFlight = true;
  try {
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
  } finally {
    resumeInFlight = false;
  }
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

// ---- Watchdog ----

// The alarm exists only while a queue runs: an idle extension never wakes up.
// It is re-created on every start/resume, so it does not rely on alarms
// surviving a browser restart.
async function ensureWatchdog(enable) {
  if (!chrome.alarms || !chrome.alarms.create || !chrome.alarms.clear) return;
  try {
    if (enable) {
      await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });
    } else {
      await chrome.alarms.clear(WATCHDOG_ALARM);
    }
  } catch (e) {
    console.warn('DigitalData: failed to update the watchdog alarm', e);
  }
}

// Fires once a minute while a job is in flight and covers the two ways a run
// dies silently: the worker was suspended and nothing woke it up again, and the
// worker is alive but its queue stopped producing results.
async function watchdogTick() {
  let record = null;
  try {
    const stored = await storageGet(JOB_KEY);
    record = stored[JOB_KEY] || null;
  } catch (e) {
    return; // storage unreachable: nothing trustworthy to decide on
  }
  if (!record || record.status !== 'running') {
    await ensureWatchdog(false);
    return;
  }

  // No queue in memory: the worker was killed mid-run. Rebuild it from storage.
  if (!activeJob) {
    await maybeResume();
    return;
  }

  const silentFor = Date.now() - activeJob.lastProgressAt;
  if (silentFor < WATCHDOG_STALL_MS) return;

  // Alive but mute: the queue is stuck on hung tabs. Drop it and let
  // maybeResume() rebuild from the results already in storage, so nothing that
  // finished gets processed twice.
  console.warn(`DigitalData: watchdog restarting a stalled job (${Math.round(silentFor / 1000)}s without progress)`);
  const stalled = activeJob;
  stalled.handle.cancelled = true;
  stalled.handle.superseded = true; // its finalize must not touch the new state
  activeJob = null;
  await closeOrphanTabs();
  await maybeResume();
}

// ---- Queue ----

// Start gate: every navigation waits its turn plus a random gap, so N workers
// never fire together. Serialized through a promise chain on purpose: a burst of
// tabs from one IP is exactly what a bot rule scores.
let navGate = Promise.resolve();

function paceNavigation() {
  const jitter = NAV_STAGGER_MS ? Math.floor(Math.random() * 400) : 0;
  navGate = navGate.then(() => sleep(NAV_STAGGER_MS + jitter));
  return navGate;
}

async function runQueue(job) {
  const { record, handle } = job;
  await ensurePerfRules(true).catch(() => {});

  // In site mode the sitemap expands the queue before the first tab opens. It is
  // idempotent and re-runs on resume only when it never completed.
  if (record.site && !record.site.discoveredDone) {
    await discoverFromSitemaps(job);
    if (handle.cancelled) return;
  }

  // Discovery can append URLs while other workers are still running, so a worker
  // may only exit when the queue is empty AND nothing is in flight (otherwise it
  // would quit before a sibling's links land).
  let inflight = 0;

  function claim() {
    while (record.nextIndex < record.urls.length) {
      const idx = record.nextIndex++;
      if (!job.done.has(idx)) return idx;
    }
    return -1;
  }

  async function worker() {
    for (;;) {
      if (handle.cancelled) return;
      const idx = claim();
      if (idx < 0) {
        if (inflight === 0) return;
        await sleep(50);
        continue;
      }

      inflight++;
      try {
        await paceNavigation();
        if (handle.cancelled) return;
        const outcome = await processUrl(record.urls[idx], idx, job);
        // A cancelled job must never write again: its progress payload is stale,
        // and a watchdog restart would let it overwrite the newer queue's counters.
        if (handle.cancelled) return;
        await maybeEnqueueLinks(job, idx, outcome.links);
        if (!(await persistEntry(job, idx, outcome.entry))) return;
      } finally {
        inflight--;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, Math.max(record.urls.length, 1)) },
    worker
  );
  await Promise.all(workers);
}

// ---- Site discovery ----

function depthOf(job, idx) {
  const depths = job.record.depths;
  const depth = Array.isArray(depths) ? depths[idx] : 0;
  return Number.isInteger(depth) ? depth : 0;
}

// Appends a URL discovered by the sitemap or the spider. Returns true when it was
// actually added (dedupe + host allow-list live here, not at the call sites).
function enqueueDiscovered(job, raw, depth) {
  const key = normalizeQueueUrl(raw);
  if (!key) return false;
  if (job.hostSet.size && !job.hostSet.has(hostOf(key))) return false;
  if (job.seen.has(key)) return false;
  if (job.record.site && job.record.urls.length >= SITE_MAX_URLS) {
    job.record.site.capped = true;
    return false;
  }
  job.seen.add(key);
  job.record.urls.push(key);
  if (!Array.isArray(job.record.depths)) job.record.depths = [];
  job.record.depths.push(depth);
  return true;
}

async function discoverFromSitemaps(job) {
  const record = job.record;
  const seedCount = record.seedCount || record.urls.length;
  const hosts = [...new Set(record.urls.slice(0, seedCount).map(hostOf).filter(Boolean))];
  let added = 0;
  // Discovery may re-run after an interrupted job: replace, don't append, or the
  // report would show the same failure twice.
  record.site.sitemapErrors = [];
  for (const host of hosts) {
    if (job.handle.cancelled) return;
    const { urls, error } = await sitemapUrls(host);
    if (error) record.site.sitemapErrors.push({ host, error });
    urls.forEach((url) => {
      if (enqueueDiscovered(job, url, 1)) added++;
    });
  }
  record.site.discovered += added;
  record.site.discoveredDone = true;
  await persistJobRecord(job, true);
}

// Fetches /sitemap.xml from the worker. host_permissions is <all_urls>, so the
// request carries the browser session that already passes Akamai.
async function sitemapUrls(host) {
  const root = `https://${host}/sitemap.xml`;
  const text = await fetchText(root);
  if (!text) return { urls: [], error: `${root} unreachable` };
  const locs = parseSitemapLocs(text);
  if (!isSitemapIndex(text)) return { urls: locs, error: null };
  const out = [];
  for (const child of locs.slice(0, SITE_MAX_SITEMAP_CHILDREN)) {
    if (!/\.xml(\?|$)/i.test(child)) continue;
    const childText = await fetchText(child);
    if (childText) out.push(...parseSitemapLocs(childText));
  }
  return { urls: out, error: null };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!response || !response.ok) return '';
    return await response.text();
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// Harvests same-host links from a processed page up to the run's max depth.
// The full link list stays in memory; the entry only keeps the count, so the
// per-URL storage cost does not grow with the page footer size.
async function maybeEnqueueLinks(job, idx, links) {
  const site = job.record.site;
  if (!site || !Array.isArray(links) || !links.length) return;
  const depth = depthOf(job, idx);
  if (depth >= site.maxDepth) return;

  let added = 0;
  links.slice(0, SITE_MAX_LINKS_PER_PAGE).forEach((raw) => {
    if (enqueueDiscovered(job, raw, depth + 1)) added++;
  });
  if (!added) return;

  site.discovered += added;
  await persistJobRecord(job);
}

// The URL list grows during a site run, so it has to be rewritten when discovery
// adds entries. `ddTotal` follows it (the popup and the summary read it).
async function persistJobRecord(job, force) {
  if (job.handle.cancelled) return;
  const now = Date.now();
  if (!force && job.lastQueuePersistAt && now - job.lastQueuePersistAt < 1000) return;
  job.lastQueuePersistAt = now;
  try {
    await job.write({
      [JOB_KEY]: snapshot(job.record),
      ddTotal: job.record.urls.length
    });
  } catch (e) {
    await handleStorageFailure(job, e);
  }
}

// Retries transient failures only: a throttled tab creation or a discarded tab
// is the extension hiccuping, while a network error page or a load timeout is
// the site's answer — retrying those would double the wall time for the same
// verdict. The retry is invisible in the entry contract on purpose, so the
// error messages stay comparable between runs.
async function processUrl(url, idx, job) {
  for (let attempt = 1; ; attempt++) {
    const outcome = await attemptUrl(url, idx, job);
    if (!outcome.retryable || attempt >= RETRY_MAX_ATTEMPTS || job.handle.cancelled) {
      outcome.entry = capEntry(outcome.entry, MAX_ENTRY_BYTES);
      return outcome;
    }
    await sleep(jitter(RETRY_BASE_DELAY_MS));
  }
}

// Full jitter so parallel workers do not retry in lockstep.
function jitter(baseMs) {
  return Math.round(baseMs * (1 + Math.random()));
}

// A single attempt: one tab, one read of the data layer.
async function attemptUrl(url, idx, job) {
  const entry = {
    url,
    finalUrl: null,
    status: 'pending',
    digitalData: null,
    adobeAnalytics: null,
    error: null,
    truncated: false,
    // Additive site-audit fields (the export contract only requires the fields
    // above, so importers that ignore these keep working).
    template: null,
    metrics_files: [],
    metrics_locale: null,
    title: null,
    links_found: 0,
    has_fmc_context: null,
    has_aa_beacon: null,
    // HTTP status of the final main-frame response (403/429 = edge block).
    http_status: null
  };
  let tab;
  let retryable = false;
  let links = [];

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

    // Status of the response the tab actually rendered (not of a redirect hop).
    // Absent when webRequest missed it: an old status is better than a guess.
    if (HTTP_STATUS_BY_TAB.has(tab.id)) entry.http_status = HTTP_STATUS_BY_TAB.get(tab.id);

    // A closed tab or a network error page carries no data layer: say so
    // instead of reporting "sin digitalData" for a page that never loaded.
    if (loadOutcome === 'gone' || isErrorPageUrl(pageUrl)) {
      entry.status = 'error';
      // A vanished tab may just have been discarded under memory pressure (worth
      // a retry); an error page is the site's answer (not worth a retry).
      retryable = loadOutcome === 'gone';
      entry.error = loadOutcome === 'gone'
        ? TAB_CLOSED_MESSAGE
        : 'Page failed to load: ' + pageUrl;
      return { entry, retryable, links };
    }

    await sleep(POST_LOAD_WAIT_MS);

    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN', // MAIN world shares the page real window where digitalData and Adobe objects live
      func: extractPageAnalytics,
      args: [DIGITALDATA_MAX_WAIT_MS, DIGITALDATA_POLL_INTERVAL_MS, DIGITALDATA_STABLE_POLLS]
    });

    const payload = injection && injection[0] ? injection[0].result : null;
    // Site-audit metadata is captured even when the page has no data layer: a
    // template-new page without digitalData is exactly what the report flags.
    links = applyPageInfo(entry, payload && payload.page);
    if (!payload || typeof payload !== 'object') {
      const result = noDataResult(loadOutcome);
      entry.status = result.status;
      entry.error = result.error;
    } else {
      const dd = payload.dd !== undefined ? payload.dd : null;
      const aa = payload.aa !== undefined ? payload.aa : null;
      // Observability for a capture that has to wait: a shell that resolves at
      // ~8s is a page that never populated its identity, not a lucky early read.
      if (Number.isFinite(payload.captureMs)) entry.capture_ms = Math.round(payload.captureMs);
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
    // A throw here means the extension failed (tab creation throttled, injection
    // rejected), not that the site answered: worth one retry.
    retryable = true;
  } finally {
    if (tab) {
      untrackTab(job, tab.id);
      HTTP_STATUS_BY_TAB.delete(tab.id);
      if (CLOSE_TABS_AFTER_READ) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { /* ignore */ }
      }
    }
  }

  return { entry, retryable, links };
}

// Classifies the page-level metadata captured inside the visited page. Kept in
// the worker (not injected) so the pure helpers stay unit-testable in lib/.
function applyPageInfo(entry, page) {
  if (!page || typeof page !== 'object') return [];
  const classified = classifyTemplate(page.scripts || [], page.fmc_blocks || 0);
  entry.template = classified.template;
  entry.metrics_files = classified.metrics_files;
  entry.metrics_locale = classified.metrics_locale;
  entry.has_fmc_context = classified.has_fmc_context;
  entry.has_aa_beacon = !!page.has_aa_beacon;
  entry.title = page.title ? String(page.title) : null;
  entry.links_found = Array.isArray(page.links) ? page.links.length : 0;
  return Array.isArray(page.links) ? page.links : [];
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

// Close tabs recorded by a previous (suspended or aborted) run. Mid-run the
// live list lives in ddProgress — ddJob only carries a tabIds snapshot from
// start/finalize — so both are read, or a killed worker leaves its tabs open.
async function closeOrphanTabs() {
  let record;
  let progress;
  try {
    const stored = await storageGet([JOB_KEY, PROGRESS_KEY]);
    record = stored[JOB_KEY];
    progress = stored[PROGRESS_KEY];
  } catch (e) {
    return;
  }
  const ids = [];
  if (record && Array.isArray(record.tabIds)) ids.push(...record.tabIds);
  if (progress && Array.isArray(progress.tabIds)) ids.push(...progress.tabIds);
  await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
  if (record) {
    record.tabIds = [];
    await storageSet({ [JOB_KEY]: snapshot(record) }).catch(() => {});
  }
  if (progress) {
    progress.tabIds = [];
    await storageSet({ [PROGRESS_KEY]: progress }).catch(() => {});
  }
}

// ---- Persistence helpers ----

function snapshot(record) {
  return {
    status: record.status,
    urls: record.urls,
    depths: Array.isArray(record.depths) ? record.depths.slice() : [],
    seedCount: record.seedCount || 0,
    site: record.site || null,
    nextIndex: record.nextIndex,
    startedAt: record.startedAt,
    tabIds: Array.isArray(record.tabIds) ? record.tabIds.slice() : []
  };
}

// Persist only the tiny progress object. The URL list lives in ddJob and is
// written at start/finalize, so finishing one URL is O(1), not O(n).
async function persistProgress(job) {
  // A cancelled job must never write again: its payload is stale and could
  // overwrite the counters of the queue that superseded it.
  if (job.handle.cancelled) return false;
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
    // Write the terminal marker and the status in the same set: a reader that
    // sees "not running" must never observe the previous "running" record.
    await storageSet({
      [RUNNING_KEY]: false,
      [JOB_ERROR_KEY]: job.handle.failed,
      ddFinishedAt: Date.now(),
      [JOB_KEY]: snapshot({ ...job.record, status: 'aborted', tabIds: [] })
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

    // NO se espera la identidad de página (pageName/hierarchy/siteSection).
    // La hipótesis de que el cascarón se completa después resultó falsa en
    // producción: en 28 cargas medidas (dos corridas de 14 URLs con la espera
    // activa) la identidad no apareció ni una vez, y en cuatro corridas de esas
    // URLs apareció una sola vez — ya presente antes del primer poll, que es
    // justo lo que atrapa el camino rápido. Esperar costaba ~7s por página sin
    // capturar nada, así que se acepta el payload poblado y estable. capture_ms
    // documenta cuánto se esperó y el diagnóstico reporta el cascarón como lo
    // que es: un dato del sitio, no una medición nuestra.

    let lastSignature = null;
    let stableCount = 0;
    let best = null;
    let bestAA = null;
    let bestAAScore = -1;

    // Adobe's `s` is richest around the beacon and can be cleared afterwards, so
    // a late read can see LESS than an early one. Keep the richest snapshot
    // instead of the last one.
    function noteAdobe() {
      const snapshot = collectAdobe();
      if (!snapshot) return;
      const score = snapshot.s ? safeKeys(snapshot.s).length : 0;
      if (score > bestAAScore) {
        bestAA = snapshot;
        bestAAScore = score;
      }
    }

    function check() {
      noteAdobe();
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
        resolve({ dd: dd, aa: bestAA || collectAdobe(), page: collectPage(), captureMs: safeNow() - start });
      } else if (safeNow() - start > maxWaitMs) {
        // Nunca se estabilizó: devolvemos lo último visto (o null) en vez de
        // inventar un OK con el primer valor parcial.
        resolve({ dd: best, aa: bestAA || collectAdobe(), page: collectPage(), captureMs: safeNow() - start });
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

    // Page-level snapshot used by site mode: the template marker lives in the
    // script tags, the crawl frontier in the anchors. Bounded on purpose; the
    // full HTML is never serialized (it is megabytes on these pages).
    function collectPage() {
      const page = { title: '', scripts: [], links: [], fmc_blocks: 0, has_aa_beacon: false };
      try { page.title = String(document.title || ''); } catch (e) { /* ignore */ }
      try {
        const nodes = document.querySelectorAll('script[src]');
        for (let i = 0; i < nodes.length && page.scripts.length < 80; i++) {
          const src = nodes[i].src;
          if (src) page.scripts.push(String(src));
        }
      } catch (e) { /* ignore */ }
      try {
        const anchors = document.querySelectorAll('a[href]');
        for (let i = 0; i < anchors.length && page.links.length < 400; i++) {
          const href = anchors[i].href;
          if (href) page.links.push(String(href));
        }
      } catch (e) { /* ignore */ }
      try {
        const inline = document.querySelectorAll('script:not([src])');
        let fmc = 0;
        for (let i = 0; i < inline.length; i++) {
          const text = inline[i].textContent || '';
          const found = text.match(/FMC\.context\.\w+/g);
          if (found) fmc += found.length;
        }
        page.fmc_blocks = fmc;
      } catch (e) { /* ignore */ }
      try {
        const entries = performance.getEntriesByType('resource');
        page.has_aa_beacon = entries.some((entry) => /smetrics\.ford\.com/i.test(entry.name));
      } catch (e) { /* ignore */ }
      return page;
    }

    check();
  });
}

// Attempt to resume an interrupted job when the worker (re)starts.
maybeResume().catch(() => {});
ensureFordRequestRules().catch(() => {});
ensurePerfRules(false).catch(() => {}); // drop stale blocks from a killed run
