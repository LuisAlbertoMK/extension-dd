// Unit tests for lib/parity.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonical, diffDDExports, parityOk } = require('../lib/parity.js');

describe('canonical', () => {
  it('orders object keys so key order does not fake a diff', () => {
    assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  });

  it('keeps array order significant', () => {
    assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  });
});

describe('diffDDExports', () => {
  const base = [
    { index: 0, url: 'https://x.example/a', status: 'ok', digitalData: { p: 1 }, error: null },
    { index: 1, url: 'https://x.example/b', status: 'no-data', digitalData: null, error: null }
  ];

  it('reports full parity for identical exports', () => {
    const diff = diffDDExports(base, JSON.parse(JSON.stringify(base)));
    assert.equal(diff.total, 2);
    assert.equal(diff.matched, 2);
    assert.equal(parityOk(diff), true);
  });

  it('flags payload and status changes with kinds', () => {
    const other = [
      { index: 0, url: 'https://x.example/a', status: 'ok', digitalData: { p: 2 }, error: null },
      { index: 1, url: 'https://x.example/b', status: 'error', digitalData: null, error: 'boom' }
    ];
    const diff = diffDDExports(base, other);
    assert.equal(parityOk(diff), false);
    assert.deepEqual(diff.changed.map((c) => [c.index, c.kind]), [[0, 'payload'], [1, 'status']]);
  });

  it('flags missing indexes on either side', () => {
    const onlyBase = diffDDExports(base, [base[0]]);
    assert.deepEqual(onlyBase.onlyInBase.map((c) => c.index), [1]);
    const onlyOther = diffDDExports([base[0]], base);
    assert.deepEqual(onlyOther.onlyInOther.map((c) => c.index), [1]);
  });

  it('compares truncated string payloads without crashing', () => {
    const a = [{ index: 0, url: 'u', status: 'ok', digitalData: 'ab', error: null }];
    const b = [{ index: 0, url: 'u', status: 'ok', digitalData: 'ab', error: null }];
    assert.equal(parityOk(diffDDExports(a, b)), true);
  });
});
