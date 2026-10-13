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
  module.exports = { entryIndex, orderedResults, buildCombinedJson };
}
