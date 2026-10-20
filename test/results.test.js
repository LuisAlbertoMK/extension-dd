// Unit tests for lib/results.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  RESULT_PREFIX,
  resultKey,
  collectResults,
  entryIndex,
  orderedResults,
  buildCombinedJson,
  buildDDJson,
  buildAAJson,
  buildSummary,
  captureCompleteness
} = require('../lib/results.js');
describe('resultKey / collectResults', () => {
  it('builds one prefixed storage key per index', () => {
    assert.equal(RESULT_PREFIX, 'ddR:');
    assert.equal(resultKey(0), 'ddR:0');
    assert.equal(resultKey(42), 'ddR:42');
  });

  it('collects only result keys and restores numeric order', () => {
    const storage = {
      'ddR:2': { url: 'https://x.example/c', status: 'ok' },
      'ddR:0': { url: 'https://x.example/a', status: 'ok' },
      'ddR:1': { url: 'https://x.example/b', status: 'no-data' },
      ddTotal: 3,
      ddJobRunning: false,
      ddJob: { status: 'idle' }
    };
    const results = collectResults(storage);
    assert.deepEqual(Object.keys(results), ['0', '1', '2']);
    assert.deepEqual(
      orderedResults(results).map((r) => r.entry.url),
      ['https://x.example/a', 'https://x.example/b', 'https://x.example/c']
    );
  });

  it('ignores malformed keys and non-object entries', () => {
    const storage = {
      'ddR:abc': { url: 'https://x.example/bad' },
      'ddR:1': 'not-an-entry',
      'ddSomething:2': { url: 'https://x.example/other' }
    };
    assert.deepEqual(collectResults(storage), {});
  });

  it('falls back to the legacy ddResults snapshot', () => {
    const legacy = { '0__https://x.example/a': { url: 'https://x.example/a' } };
    assert.deepEqual(collectResults({ ddResults: legacy }), legacy);
  });

  it('prefers per-URL keys when both layouts exist', () => {
    const results = collectResults({
      'ddR:0': { url: 'https://x.example/new' },
      ddResults: { '0__https://x.example/old': { url: 'https://x.example/old' } }
    });
    assert.deepEqual(Object.keys(results), ['0']);
    assert.equal(results['0'].url, 'https://x.example/new');
  });
});

describe('entryIndex', () => {
  it('parses the numeric prefix of storage keys', () => {
    assert.equal(entryIndex('12__https://x.example/'), 12);
  });

  it('sorts unknown keys last', () => {
    assert.equal(entryIndex('weird-key'), Number.MAX_SAFE_INTEGER);
  });
});

describe('orderedResults', () => {
  it('restores submission order regardless of insertion order', () => {
    const results = {
      '2__https://x.example/c': { url: 'https://x.example/c' },
      '0__https://x.example/a': { url: 'https://x.example/a' },
      '1__https://x.example/b': { url: 'https://x.example/b' }
    };
    assert.deepEqual(
      orderedResults(results).map((r) => r.entry.url),
      ['https://x.example/a', 'https://x.example/b', 'https://x.example/c']
    );
  });
});

describe('buildCombinedJson', () => {
  it('exports an array preserving order and duplicate URLs', () => {
    const results = {
      '1__https://dup.example/p': { url: 'https://dup.example/p', status: 'ok', digitalData: { a: 1 }, error: null },
      '0__https://dup.example/p': { url: 'https://dup.example/p', status: 'no-data', digitalData: null, error: null }
    };
    const out = buildCombinedJson(results);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((r) => r.index), [0, 1]);
    assert.deepEqual(out.map((r) => r.url), ['https://dup.example/p', 'https://dup.example/p']);
  });

  it('always includes adobeAnalytics (null when absent)', () => {
    const out = buildCombinedJson({
      '0__https://x.example/': { url: 'https://x.example/', status: 'ok', digitalData: {}, error: null }
    });
    assert.equal(out[0].adobeAnalytics, null);
    assert.equal(out[0].truncated, false);
  });

  it('adds site-audit fields only when the capture produced them', () => {
    const out = buildCombinedJson({
      '0__https://x.example/': { url: 'https://x.example/', status: 'ok', digitalData: {}, error: null },
      '1__https://x.example/a': {
        url: 'https://x.example/a',
        status: 'ok',
        digitalData: {},
        error: null,
        template: 'new',
        metrics_files: ['/acservices/metrics.ford.es_mx.js'],
        metrics_locale: 'es_mx',
        title: 'Autos',
        links_found: 12,
        has_fmc_context: true,
        has_aa_beacon: false
      }
    });
    assert.ok(!('template' in out[0]), 'legacy entries keep the original shape');
    assert.equal(out[1].template, 'new');
    assert.deepEqual(out[1].metrics_files, ['/acservices/metrics.ford.es_mx.js']);
    assert.equal(out[1].metrics_locale, 'es_mx');
    assert.equal(out[1].links_found, 12);
    assert.equal(out[1].has_fmc_context, true);
    assert.equal(out[1].has_aa_beacon, false);
  });

  it('exports capture_ms and http_status so a shell can be told apart from a block', () => {
    const out = buildCombinedJson({
      '0__https://x.example/': {
        url: 'https://x.example/',
        status: 'ok',
        digitalData: { page: { tool: 'none' } },
        error: null,
        capture_ms: 8001,
        http_status: 403
      },
      '1__https://x.example/a': { url: 'https://x.example/a', status: 'ok', digitalData: {}, error: null }
    });
    assert.equal(out[0].capture_ms, 8001);
    assert.equal(out[0].http_status, 403);
    assert.ok(!('capture_ms' in out[1]), 'older entries keep the original shape');
    assert.ok(!('http_status' in out[1]));
  });
});

describe('buildDDJson / buildAAJson', () => {
  const results = {
    '0__https://x.example/a': { url: 'https://x.example/a', status: 'ok', digitalData: { p: 1 }, adobeAnalytics: { s: {} }, error: null },
    '1__https://x.example/b': { url: 'https://x.example/b', status: 'ok', digitalData: null, adobeAnalytics: { s: {} }, error: null },
    '2__https://x.example/c': { url: 'https://x.example/c', status: 'error', digitalData: null, adobeAnalytics: null, error: 'boom' }
  };

  it('DD view keeps DD payload with view-local status', () => {
    const out = buildDDJson(results);
    assert.deepEqual(out.map((r) => r.status), ['ok', 'no-data', 'error']);
    assert.ok(!('adobeAnalytics' in out[0]));
    assert.deepEqual(out[0].digitalData, { p: 1 });
  });

  it('AA view keeps AA payload with view-local status', () => {
    const out = buildAAJson(results);
    assert.deepEqual(out.map((r) => r.status), ['ok', 'ok', 'error']);
    assert.ok(!('digitalData' in out[0]));
    assert.deepEqual(out[0].adobeAnalytics, { s: {} });
  });

  it('both views share index space and order with the combined export', () => {
    const { buildCombinedJson } = require('../lib/results.js');
    const idx = (arr) => arr.map((r) => r.index);
    assert.deepEqual(idx(buildDDJson(results)), idx(buildCombinedJson(results)));
    assert.deepEqual(idx(buildAAJson(results)), idx(buildCombinedJson(results)));
  });
});

describe('buildSummary', () => {
  const ordered = [
    { idx: 0, entry: { url: 'https://shop.example/m', status: 'ok', truncated: false, adobeAnalytics: { s: {} }, error: null } },
    { idx: 1, entry: { url: 'https://shop.example/n', status: 'no-data', truncated: false, adobeAnalytics: null, error: null } },
    { idx: 2, entry: { url: 'https://preview.example/d', status: 'error', truncated: false, adobeAnalytics: null, error: 'Timed out waiting for page load' } },
    { idx: 3, entry: { url: 'https://preview.example/e', status: 'error', truncated: true, adobeAnalytics: null, error: 'Timed out waiting for page load' } }
  ];
  const classify = (url) => String(url).includes('preview') ? 'preview' : 'prod';

  it('counts statuses, truncated, AA and groups top errors', () => {
    const s = buildSummary(ordered, { startedAt: 0, finishedAt: 4000 }, classify);
    assert.equal(s.total, 4);
    assert.deepEqual(s.byStatus, { ok: 1, 'no-data': 1, error: 2, pending: 0 });
    assert.equal(s.truncated, 1);
    assert.deepEqual(s.adobe, { with: 1, without: 3 });
    assert.equal(s.elapsedMs, 4000);
    assert.equal(s.avgMsPerUrl, 1000);
    assert.deepEqual(s.topErrors, [{ message: 'Timed out waiting for page load', count: 2 }]);
  });

  it('splits counts by prod vs preview', () => {
    const s = buildSummary(ordered, { startedAt: 0, finishedAt: 4000 }, classify);
    assert.deepEqual(s.byEnv.prod, { total: 2, ok: 1, 'no-data': 1, error: 0 });
    assert.deepEqual(s.byEnv.preview, { total: 2, ok: 0, 'no-data': 0, error: 2 });
  });

  it('defaults every URL to prod without a classifier', () => {
    const s = buildSummary(ordered, { startedAt: 0, finishedAt: 4000 });
    assert.equal(s.byEnv.prod.total, 4);
    assert.equal(s.byEnv.preview.total, 0);
  });

  it('handles empty results and missing time bounds', () => {
    const s = buildSummary([], {});
    assert.equal(s.total, 0);
    assert.equal(s.elapsedMs, null);
    assert.equal(s.avgMsPerUrl, null);
    assert.deepEqual(s.topErrors, []);
    assert.deepEqual(s.byTemplate, { new: 0, old: 0, unknown: 0 });
  });

  it('buckets the template marker and the FMC/beacon corroborators', () => {
    const s = buildSummary([
      { idx: 0, entry: { url: 'https://x.example/a', status: 'ok', template: 'new', has_fmc_context: true, has_aa_beacon: true, error: null } },
      { idx: 1, entry: { url: 'https://x.example/b', status: 'ok', template: 'old', has_fmc_context: false, has_aa_beacon: false, error: null } },
      { idx: 2, entry: { url: 'https://x.example/c', status: 'error', error: 'boom' } }
    ], {});
    assert.deepEqual(s.byTemplate, { new: 1, old: 1, unknown: 1 });
    assert.deepEqual(s.fmcContext, { with: 1, without: 2 });
    assert.deepEqual(s.aaBeacon, { with: 1, without: 2 });
  });
});

describe('captureCompleteness', () => {
  const job = { urls: ['https://x.example/a', 'https://x.example/b', 'https://x.example/c'] };

  it('reports a finished run against the submitted queue', () => {
    const c = captureCompleteness(job, new Set([0, 1, 2]));
    assert.equal(c.expectedTotal, 3);
    assert.equal(c.captured, 3);
    assert.equal(c.notCaptured, 0);
    assert.deepEqual(c.missing, []);
    assert.equal(c.basis, 'queue');
    assert.equal(c.complete, true);
  });

  it('names the URL of a hole in the middle of the queue', () => {
    // A cancelled job abandons the captures that were in flight: index 1 is gone
    // while the tail kept running, so the results alone look plausible.
    const c = captureCompleteness(job, ['0', '2']);
    assert.equal(c.captured, 2);
    assert.equal(c.notCaptured, 1);
    assert.deepEqual(c.missing, [{ index: 1, url: 'https://x.example/b' }]);
    assert.equal(c.complete, false);
  });

  it('refuses to call a cancelled run complete even with every index present', () => {
    const c = captureCompleteness(job, [0, 1, 2], { cancelled: true });
    assert.equal(c.notCaptured, 0);
    assert.equal(c.cancelled, true);
    assert.equal(c.complete, false);
  });

  it('falls back to index arithmetic when the queue is gone, and says so', () => {
    const c = captureCompleteness(null, [0, 2], { expectedTotal: 3 });
    assert.equal(c.basis, 'indices');
    assert.equal(c.expectedTotal, 3);
    assert.deepEqual(c.missing.map((m) => m.index), [1]);
    assert.equal(c.missing[0].url, null);
    assert.equal(c.complete, false);
  });

  it('cannot see a tail that never ran without the queue', () => {
    // Only the queue can name the URLs that were never claimed; index arithmetic
    // proves the captured range is hole-free, not that the run finished.
    const c = captureCompleteness(null, [0, 1]);
    assert.equal(c.expectedTotal, 2);
    assert.equal(c.notCaptured, 0);
    assert.equal(c.complete, true);
    assert.equal(c.basis, 'indices');
  });

  it('treats an empty run as incomplete instead of vacuously complete', () => {
    const c = captureCompleteness(null, []);
    assert.equal(c.expectedTotal, 0);
    assert.equal(c.complete, false);
  });
});
