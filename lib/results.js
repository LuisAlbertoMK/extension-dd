// Pure results helpers shared by results.js and the test suite (no browser APIs here).
// Results are keyed as `${idx}__${url}`; sorting by the numeric index keeps the
// original submission order.
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
  return orderedResults(results).map(({ idx, entry }) => ({
    index: idx,
    url: entry.url,
    status: entry.status,
    truncated: !!entry.truncated,
    digitalData: entry.digitalData,
    adobeAnalytics: entry.adobeAnalytics || null,
    error: entry.error
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { entryIndex, orderedResults, buildCombinedJson, buildSummary };
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
    topErrors
  };
}
