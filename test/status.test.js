// Unit tests for lib/status.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  LOAD_TIMEOUT_MESSAGE,
  TAB_CLOSED_MESSAGE,
  isErrorPageUrl,
  noDataResult
} = require('../lib/status.js');

describe('isErrorPageUrl', () => {
  it('flags Chrome network error pages', () => {
    assert.equal(isErrorPageUrl('chrome-error://chromewebdata/'), true);
    assert.equal(isErrorPageUrl('edge-error://chromewebdata/'), true);
    assert.equal(isErrorPageUrl('about:neterror?e=dnsNotFound'), true);
  });

  it('does not flag real pages or missing values', () => {
    assert.equal(isErrorPageUrl('https://shop.example/a'), false);
    assert.equal(isErrorPageUrl(null), false);
    assert.equal(isErrorPageUrl(undefined), false);
    assert.equal(isErrorPageUrl('chrome-extension://abc/results.html'), false);
  });
});

describe('noDataResult', () => {
  it('turns a load timeout into an error, not a missing data layer', () => {
    assert.deepEqual(noDataResult('timeout'), { status: 'error', error: LOAD_TIMEOUT_MESSAGE });
  });

  it('turns a closed tab into an error', () => {
    assert.deepEqual(noDataResult('gone'), { status: 'error', error: TAB_CLOSED_MESSAGE });
  });

  it('keeps a genuinely loaded page without data as no-data', () => {
    assert.deepEqual(noDataResult('complete'), { status: 'no-data', error: null });
    assert.deepEqual(noDataResult(undefined), { status: 'no-data', error: null });
  });
});
