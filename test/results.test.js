// Unit tests for lib/results.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { entryIndex, orderedResults, buildCombinedJson, buildSummary } = require('../lib/results.js');

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
  });
});
