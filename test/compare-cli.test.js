// Smoke tests for the compare CLI itself: the rules are unit tested in
// compare-summaries.test.js, this checks the wiring a human actually runs
// (argument handling, report, exit codes). Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'compare-summaries.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-compare-'));

function summary({ ok, noData, error, avgMsPerUrl = 10000, topErrors = [] }) {
  const total = ok + noData + error;
  return {
    total,
    elapsedMs: null,
    avgMsPerUrl,
    byStatus: { ok, 'no-data': noData, error, pending: 0 },
    byEnv: { prod: { total, ok, 'no-data': noData, error }, preview: { total: 0, ok: 0, 'no-data': 0, error: 0 } },
    truncated: 0,
    adobe: { with: ok, without: total - ok },
    topErrors
  };
}

function write(name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

function run(...args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('a clean improvement exits 0 with an ADOPT verdict and the delta table', () => {
  const base = write('base.json', summary({ ok: 110, noData: 229, error: 29 }));
  const cand = write('cand.json', summary({
    ok: 111,
    noData: 218,
    error: 39,
    avgMsPerUrl: 10300,
    topErrors: [{ message: 'Timeout waiting for page load', count: 10 }]
  }));

  const result = run(base, cand);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /VERDICT: ADOPT/);
  assert.match(result.stdout, /no-data\s+229\s+218\s+-11/);
  assert.match(result.stdout, /Honest classification: 10 more errors, 11 fewer no-data/);
});

test('losing OK entries exits 1 so a script cannot adopt it by accident', () => {
  const base = write('base2.json', summary({ ok: 110, noData: 229, error: 29 }));
  const cand = write('cand2.json', summary({ ok: 109, noData: 229, error: 30 }));

  const result = run(base, cand);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERDICT: DO NOT ADOPT/);
  assert.match(result.stdout, /lost 1 OK/);
});

test('mismatched URL lists exit 1 and are reported as invalid input', () => {
  const base = write('base3.json', summary({ ok: 10, noData: 5, error: 1 }));
  const cand = write('cand3.json', summary({ ok: 20, noData: 10, error: 2 }));

  const result = run(base, cand);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERDICT: INVALID INPUT/);
});

test('missing arguments and unreadable input exit 2', () => {
  assert.equal(run().status, 2);
  const base = write('base4.json', summary({ ok: 1, noData: 1, error: 1 }));
  const notASummary = write('not-a-summary.json', [1, 2, 3]);
  const missing = path.join(dir, 'does-not-exist.json');

  assert.equal(run(base, notASummary).status, 2);
  assert.equal(run(base, missing).status, 2);
  assert.match(run(base, notASummary).stdout, /not an audit summary/);

  // A summary missing byEnv/adobe used to crash while printing the table.
  const noEnv = write('no-env.json', { ...summary({ ok: 1, noData: 1, error: 1 }), byEnv: undefined });
  assert.equal(run(base, noEnv).status, 2);
  assert.match(run(base, noEnv).stdout, /missing byEnv\/adobe/);
});

test('an unfinished run exits 1 and the verdict names that reason, not the list', () => {
  const full = summary({ ok: 110, noData: 229, error: 29 });
  const base = write('base5.json', { ...full, expectedTotal: 1106 });
  const cand = write('cand5.json', { ...summary({ ok: 110, noData: 220, error: 30 }), expectedTotal: 1106 });

  const result = run(base, cand);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VERDICT: INVALID INPUT - a run did not finish the list/);
  assert.doesNotMatch(result.stdout, /did not cover the same URL list/);
  assert.match(result.stdout, /candidate stopped at 360\/1106/);
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
