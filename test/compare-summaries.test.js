const test = require('node:test');
const assert = require('node:assert');
const { compareSummaries, statusSum } = require('../tools/compare-summaries.js');

// Mirrors the shape produced by buildSummary() in lib/results.js.
function summary({ ok = 0, noData = 0, error = 0, pending = 0, total, avgMsPerUrl = 10000, truncated = 0, vendor = { with: 0 }, topErrors = [] }) {
  return {
    total: total === undefined ? ok + noData + error + pending : total,
    elapsedMs: null,
    avgMsPerUrl,
    byStatus: { ok, 'no-data': noData, error, pending },
    byEnv: {
      prod: { total: ok + noData + error, ok, 'no-data': noData, error },
      preview: { total: 0, ok: 0, 'no-data': 0, error: 0 }
    },
    truncated,
    adobe: { with: vendor.with, without: total - vendor.with },
    topErrors
  };
}

const LEVELS = (result) => result.findings.map((f) => f.level);

test('statusSum counts every bucket', () => {
  assert.strictEqual(statusSum(summary({ ok: 2, noData: 3, error: 4, pending: 5 })), 14);
});

test('honest classification with new error message and stable time is adoptable', () => {
  const base = summary({
    ok: 110, noData: 229, error: 29, avgMsPerUrl: 10000,
    topErrors: [{ message: 'unknown', count: 29 }]
  });
  const cand = summary({
    ok: 110, noData: 219, error: 39, avgMsPerUrl: 10300,
    topErrors: [{ message: 'Timeout waiting for page load', count: 10 }, { message: 'unknown', count: 29 }]
  });
  const result = compareSummaries(base, cand);
  assert.strictEqual(result.verdict, 'adopt');
  assert.deepStrictEqual(result.deltas, { ok: 0, noData: -10, error: 10, truncated: 0, timeRatio: 1.03 });
  assert.ok(result.findings.some((f) => f.message.includes('Honest classification')));
  assert.ok(result.findings.some((f) => f.message.includes('Timeout waiting for page load')));
});

test('losing OK entries is a blocker regardless of the rest', () => {
  const base = summary({ ok: 110, noData: 229, error: 29 });
  const cand = summary({ ok: 100, noData: 229, error: 39, topErrors: [{ message: 'Timeout waiting for page load', count: 10 }] });
  const result = compareSummaries(base, cand);
  assert.strictEqual(result.verdict, 'reject');
  assert.strictEqual(result.deltas.ok, -10);
  assert.ok(result.findings.some((f) => f.level === 'blocker' && f.message.includes('lost 10 OK')));
});

test('gaining OK entries is reported but not a blocker', () => {
  const base = summary({ ok: 110, noData: 229, error: 29 });
  const cand = summary({ ok: 118, noData: 221, error: 29, avgMsPerUrl: 11000 });
  const result = compareSummaries(base, cand);
  assert.strictEqual(result.verdict, 'adopt');
  assert.ok(result.findings.some((f) => f.message.includes('gained 8 OK')));
});

test('different URL lists make the comparison invalid', () => {
  const result = compareSummaries(summary({ ok: 10, total: 368 }), summary({ ok: 10, total: 1106 }));
  assert.strictEqual(result.verdict, 'invalid');
  assert.strictEqual(result.deltas, null);
  assert.ok(result.findings.some((f) => f.level === 'blocker' && f.message.includes('Different URL lists')));
});

test('a summary whose statuses do not add up is a blocker', () => {
  const base = summary({ ok: 10, noData: 5, total: 368 });
  const cand = summary({ ok: 10, noData: 5, total: 368 });
  const result = compareSummaries(base, cand);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.findings.some((f) => f.level === 'blocker' && f.message.includes('does not add up')));
});

test('frozen status counts are flagged as suspicious', () => {
  const result = compareSummaries(summary({ ok: 110, noData: 229, error: 29 }), summary({ ok: 110, noData: 229, error: 29 }));
  assert.strictEqual(result.verdict, 'adjust');
  assert.ok(result.findings.some((f) => f.message.includes('did not move')));
});

test('more errors with an identical top message list warns that classification may not have triggered', () => {
  const errs = [{ message: 'unknown', count: 29 }];
  const base = summary({ ok: 110, noData: 229, error: 29, topErrors: errs });
  const cand = summary({ ok: 110, noData: 219, error: 39, topErrors: errs });
  const result = compareSummaries(base, cand);
  assert.strictEqual(result.verdict, 'adjust');
  assert.ok(result.findings.some((f) => f.message.includes('may not have triggered')));
});

test('time regressions are graded: 20% warns, 30% blocks', () => {
  const base = summary({ ok: 110, noData: 229, error: 29, avgMsPerUrl: 10000 });
  const warn = compareSummaries(base, summary({ ok: 110, noData: 219, error: 39, avgMsPerUrl: 12000, topErrors: [{ message: 'Timeout waiting for page load', count: 10 }] }));
  assert.strictEqual(warn.verdict, 'adjust');
  assert.ok(warn.findings.some((f) => f.level === 'warn' && f.message.includes('time up 20%')));

  const block = compareSummaries(base, summary({ ok: 110, noData: 219, error: 39, avgMsPerUrl: 13000, topErrors: [{ message: 'Timeout waiting for page load', count: 10 }] }));
  assert.strictEqual(block.verdict, 'reject');
  assert.ok(block.findings.some((f) => f.level === 'blocker' && f.message.includes('time up 30%')));
});

test('more truncated entries is a warning, not a blocker', () => {
  const base = summary({ ok: 110, noData: 229, error: 29, truncated: 0 });
  const cand = summary({ ok: 110, noData: 219, error: 39, truncated: 2, topErrors: [{ message: 'Timeout waiting for page load', count: 10 }] });
  const result = compareSummaries(base, cand);
  assert.strictEqual(result.verdict, 'adjust');
  assert.ok(result.findings.some((f) => f.message.includes('2 more truncated')));
});

test('missing timing data degrades to a warning instead of crashing', () => {
  const base = summary({ ok: 110, noData: 229, error: 29, avgMsPerUrl: null });
  const cand = summary({ ok: 110, noData: 219, error: 39, avgMsPerUrl: null, topErrors: [{ message: 'Timeout waiting for page load', count: 10 }] });
  const result = compareSummaries(base, cand);
  assert.strictEqual(result.verdict, 'adjust');
  assert.ok(result.findings.some((f) => f.message.includes('avgMsPerUrl missing')));
});

test('every finding carries a known level', () => {
  const result = compareSummaries(
    summary({ ok: 110, noData: 229, error: 29 }),
    summary({ ok: 110, noData: 219, error: 39, topErrors: [{ message: 'Timeout waiting for page load', count: 10 }] })
  );
  assert.ok(LEVELS(result).every((l) => ['info', 'warn', 'blocker'].includes(l)));
});
