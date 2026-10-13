// Unit tests for lib/results.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { entryIndex, orderedResults, buildCombinedJson } = require('../lib/results.js');

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
