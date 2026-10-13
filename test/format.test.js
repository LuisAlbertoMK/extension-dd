// Unit tests for lib/format.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatElapsed } = require('../lib/format.js');

describe('formatElapsed', () => {
  it('formats sub-minute durations with one decimal', () => {
    assert.equal(formatElapsed(1000, 13400), '12.4s');
  });

  it('formats minute durations as Xm Ys', () => {
    assert.equal(formatElapsed(0, 125000), '2m 5s');
  });

  it('returns a placeholder for missing or inverted bounds', () => {
    assert.equal(formatElapsed(null, 5), '—');
    assert.equal(formatElapsed(10, 5), '—');
    assert.equal(formatElapsed(undefined, undefined), '—');
  });
});
