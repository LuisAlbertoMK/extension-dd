// Unit tests for lib/quota.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { capEntry } = require('../lib/quota.js');

const MAX = 200000;

describe('capEntry', () => {
  it('leaves small entries untouched', () => {
    const entry = { digitalData: { page: 'x' }, adobeAnalytics: null, truncated: false };
    const out = capEntry(entry, MAX);
    assert.deepEqual(out.digitalData, { page: 'x' });
    assert.equal(out.truncated, false);
  });

  it('trims Adobe dataLayer events before touching digitalData', () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ event: `e${i}`, data: 'x'.repeat(5000) }));
    const entry = {
      digitalData: { page: 'x' },
      adobeAnalytics: { s: { pageName: 'p' }, satellite: null, dataLayer: { totalEvents: 50, events, truncatedEvents: false } },
      truncated: false
    };
    const out = capEntry(entry, MAX);
    assert.equal(out.truncated, true);
    assert.equal(out.adobeAnalytics.dataLayer.events.length, 10);
    assert.equal(out.adobeAnalytics.dataLayer.truncatedEvents, true);
    assert.deepEqual(out.digitalData, { page: 'x' }); // digitalData preserved
  });

  it('drops Adobe data entirely when still over quota', () => {
    const entry = {
      digitalData: { page: 'x' },
      adobeAnalytics: { s: { blob: 'y'.repeat(MAX + 1) }, satellite: null, dataLayer: null },
      truncated: false
    };
    const out = capEntry(entry, MAX);
    assert.equal(out.truncated, true);
    assert.equal(out.adobeAnalytics.truncated, true);
    assert.deepEqual(out.digitalData, { page: 'x' });
  });

  it('truncates digitalData only as a last resort', () => {
    const entry = { digitalData: { blob: 'z'.repeat(MAX + 100) }, adobeAnalytics: null, truncated: false };
    const out = capEntry(entry, MAX);
    assert.equal(out.truncated, true);
    assert.equal(typeof out.digitalData, 'string');
  });

  it('passes through entries that cannot be serialized', () => {
    const dd = {};
    dd.self = dd; // circular: JSON.stringify throws inside size()
    const entry = { digitalData: dd, adobeAnalytics: null, truncated: false };
    const out = capEntry(entry, MAX);
    assert.equal(out.truncated, false);
  });
});
