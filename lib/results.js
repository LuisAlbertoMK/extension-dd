// Pure results helpers shared by results.js and the test suite (no browser APIs here).
// Results are keyed as `${idx}__${url}`; sorting by the numeric index keeps the
// original submission order.

// Storage layout for finished URLs: one `ddR:<index>` key per entry so a write
// never re-serializes the whole run (that turned long jobs into O(n^2) writes
// and a single quota failure lost every result).
const RESULT_PREFIX = 'ddR:';

function resultKey(index) {
  return RESULT_PREFIX + index;
}

function isResultKey(key) {
  return typeof key === 'string' && key.indexOf(RESULT_PREFIX) === 0;
}

// Rebuilds the index -> entry map from a full storage snapshot. Falls back to
// the legacy single-key `ddResults` object so runs from older builds still show.
function collectResults(storage) {
  const out = {};
  let found = false;
  Object.keys(storage || {}).forEach((key) => {
    if (!isResultKey(key)) return;
    const idx = parseInt(key.slice(RESULT_PREFIX.length), 10);
    if (!Number.isInteger(idx) || idx < 0) return;
    const entry = storage[key];
    if (!entry || typeof entry !== 'object') return;
    out[idx] = entry;
    found = true;
  });
  if (!found && storage && storage.ddResults && typeof storage.ddResults === 'object') {
    return storage.ddResults;
  }
  return out;
}

function entryIndex(key) {
  const n = parseInt(key, 10);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

function orderedResults(results) {
  return Object.keys(results)
    .map((key) => ({ idx: entryIndex(key), entry: results[key] }))
    .sort((a, b) => a.idx - b.idx);
}

function buildCombinedJson(results) {
  // Exported as an array (not an object keyed by URL) so duplicate URLs and the
  // original submission order are preserved.
  return orderedResults(results).map(({ idx, entry }) => {
    const out = {
      index: idx,
      url: entry.url,
      finalUrl: entry.finalUrl || null,
      status: entry.status,
      truncated: !!entry.truncated,
      digitalData: entry.digitalData,
      adobeAnalytics: entry.adobeAnalytics || null,
      error: entry.error
    };
    // Site-audit fields are additive and optional: they only appear when the
    // capture produced them, so importers of the original contract are unaffected.
    if (entry.template != null) out.template = entry.template;
    if (Array.isArray(entry.metrics_files) && entry.metrics_files.length) out.metrics_files = entry.metrics_files;
    if (entry.metrics_locale != null) out.metrics_locale = entry.metrics_locale;
    if (entry.title != null) out.title = entry.title;
    if (typeof entry.links_found === 'number') out.links_found = entry.links_found;
    if (typeof entry.has_fmc_context === 'boolean') out.has_fmc_context = entry.has_fmc_context;
    if (typeof entry.has_aa_beacon === 'boolean') out.has_aa_beacon = entry.has_aa_beacon;
    // Capture duration: without it, an export cannot tell "we waited and the page
    // never populated its identity" from "we read it too early".
    if (Number.isFinite(entry.capture_ms)) out.capture_ms = entry.capture_ms;
    // HTTP status of the final main-frame response: an edge block (403/429) or a
    // dead URL (404/410) is not a page defect, and only the status proves it.
    if (Number.isInteger(entry.http_status)) out.http_status = entry.http_status;
    return out;
  });
}

// Split views so independent consumers (humans or agents) can each take only
// what they need: DD validators ignore AA and vice versa. Same ordering,
// same index space, smaller payloads.
function buildDDJson(results) {
  return orderedResults(results).map(({ idx, entry }) => ({
    index: idx,
    url: entry.url,
    finalUrl: entry.finalUrl || null,
    // View-local status: honest for DD-only consumers even when the overall
    // entry is ok via Adobe data alone.
    status: entry.digitalData ? 'ok' : (entry.status === 'error' ? 'error' : 'no-data'),
    digitalData: entry.digitalData,
    error: entry.error
  }));
}

function buildAAJson(results) {
  return orderedResults(results).map(({ idx, entry }) => ({
    index: idx,
    url: entry.url,
    finalUrl: entry.finalUrl || null,
    // View-local status: honest for AA-only consumers even when the overall
    // entry is ok via digitalData alone.
    status: entry.adobeAnalytics ? 'ok' : (entry.status === 'error' ? 'error' : 'no-data'),
    adobeAnalytics: entry.adobeAnalytics || null,
    error: entry.error
  }));
}

// Which submitted URLs actually produced a result. The results alone can never
// prove a run was complete: a cancelled job returns before persisting the
// captures that were in flight, so it leaves holes in the middle of the index
// range and an export that counts only what it captured still looks whole. Only
// the queue knows how many URLs were submitted.
//
// `job` is the stored job record ({ urls: [...] }) or null. `done` is an
// iterable of captured indices (a Set, or the keys of the results map).
// Pure.
function captureCompleteness(job, done, options) {
  const opts = options || {};
  const seen = new Set();
  (done instanceof Set ? done : (done || [])).forEach((idx) => {
    const n = typeof idx === 'number' ? idx : parseInt(idx, 10);
    if (Number.isInteger(n) && n >= 0) seen.add(n);
  });

  const urls = job && Array.isArray(job.urls) ? job.urls : [];
  const missing = [];
  let expectedTotal;
  // Where the expected total comes from is part of the evidence: the queue can
  // name the URLs that never ran, index arithmetic can only spot holes.
  let basis;

  if (urls.length) {
    basis = 'queue';
    expectedTotal = urls.length;
    urls.forEach((url, index) => {
      if (!seen.has(index)) missing.push({ index, url: typeof url === 'string' ? url : null });
    });
  } else {
    basis = 'indices';
    const declared = Number.isInteger(opts.expectedTotal) ? opts.expectedTotal : 0;
    let maxIndex = -1;
    seen.forEach((idx) => { if (idx > maxIndex) maxIndex = idx; });
    expectedTotal = Math.max(declared, maxIndex + 1, seen.size);
    for (let i = 0; i < expectedTotal; i++) {
      if (!seen.has(i)) missing.push({ index: i, url: null });
    }
  }

  const cancelled = !!opts.cancelled;
  return {
    expectedTotal,
    captured: seen.size,
    notCaptured: missing.length,
    missing,
    cancelled,
    basis,
    complete: expectedTotal > 0 && missing.length === 0 && !cancelled
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RESULT_PREFIX,
    resultKey,
    isResultKey,
    collectResults,
    entryIndex,
    orderedResults,
    buildCombinedJson,
    buildDDJson,
    buildAAJson,
    buildSummary,
    captureCompleteness
  };
}

// Compact audit summary for a finished (or running) job. `ordered` is the
// output of orderedResults(); meta carries the job time bounds; classify maps
// a URL to 'preview' or 'prod' (defaults to 'prod' when lib/urls.js is absent).
// Pure.
function buildSummary(ordered, meta, classify) {
  const isPreview = typeof classify === 'function' ? classify : () => 'prod';
  const byStatus = { ok: 0, 'no-data': 0, error: 0, pending: 0 };
  const byEnv = {
    prod: { total: 0, ok: 0, 'no-data': 0, error: 0 },
    preview: { total: 0, ok: 0, 'no-data': 0, error: 0 }
  };
  const errGroups = {};
  // Site-audit buckets. Entries captured before this build have no template
  // field, so they land in `unknown` instead of being counted as legacy.
  const byTemplate = { new: 0, old: 0, unknown: 0 };
  let withFmc = 0;
  let withAaBeacon = 0;
  let truncated = 0;
  let withAA = 0;
  ordered.forEach(({ entry }) => {
    const st = entry && entry.status ? entry.status : 'pending';
    if (Object.prototype.hasOwnProperty.call(byStatus, st)) byStatus[st]++;
    else byStatus.pending++;
    const env = isPreview(entry && entry.url) === 'preview' ? 'preview' : 'prod';
    byEnv[env].total++;
    if (Object.prototype.hasOwnProperty.call(byEnv[env], st)) byEnv[env][st]++;
    if (entry && entry.truncated) truncated++;
    if (entry && entry.adobeAnalytics) withAA++;
    const tpl = entry && (entry.template === 'new' || entry.template === 'old') ? entry.template : 'unknown';
    byTemplate[tpl]++;
    if (entry && entry.has_fmc_context) withFmc++;
    if (entry && entry.has_aa_beacon) withAaBeacon++;
    if (st === 'error') {
      const m = String((entry && entry.error) || 'unknown').slice(0, 120);
      errGroups[m] = (errGroups[m] || 0) + 1;
    }
  });
  const topErrors = Object.keys(errGroups)
    .map((message) => ({ message, count: errGroups[message] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const total = ordered.length;
  const okBounds = meta && typeof meta.startedAt === 'number' && typeof meta.finishedAt === 'number' &&
    meta.finishedAt >= meta.startedAt;
  const elapsedMs = okBounds ? meta.finishedAt - meta.startedAt : null;
  return {
    total,
    elapsedMs,
    avgMsPerUrl: elapsedMs !== null && total ? Math.round(elapsedMs / total) : null,
    byStatus,
    byEnv,
    truncated,
    adobe: { with: withAA, without: total - withAA },
    byTemplate,
    fmcContext: { with: withFmc, without: total - withFmc },
    aaBeacon: { with: withAaBeacon, without: total - withAaBeacon },
    topErrors
  };
}
