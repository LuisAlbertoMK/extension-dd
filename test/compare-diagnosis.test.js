// Tests for the diagnosis regression comparator — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareDiagnoses } = require('../lib/diagnose.js');
const { parseArgs, main } = require('../tools/compare-diagnosis.js');

function verdict(index, codes, extra) {
  return Object.assign({
    index,
    url: `https://www.ford.mx/page-${index}/`,
    finalUrl: null,
    status: 'ok',
    severity: 'none',
    siteSeverity: 'none',
    problems: (codes || []).map((code) => ({ code, severity: 'low', attribution: 'site' }))
  }, extra || {});
}

function tempFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-compare-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function quiet(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { code: fn(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('compareDiagnoses', () => {
  it('reports identical verdicts', () => {
    const base = [verdict(0), verdict(1, ['dd-missing'], { severity: 'high', siteSeverity: 'high' })];
    const result = compareDiagnoses(base, base.map((item) => Object.assign({}, item)));
    assert.equal(result.verdict, 'identical');
    assert.deepEqual(result.deltas, {});
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.compared, 2);
  });

  it('names every entry whose codes or severity moved', () => {
    const base = [verdict(0), verdict(1, ['dd-missing'], { severity: 'high', siteSeverity: 'high' })];
    const candidate = [verdict(0), verdict(1)];
    const result = compareDiagnoses(base, candidate);
    assert.equal(result.verdict, 'differs');
    assert.deepEqual(result.mismatches.map((item) => item.index), [1]);
    assert.deepEqual(result.deltas, { 'dd-missing': -1 });
    assert.equal(result.mismatches[0].base.codes.join(','), 'dd-missing');
    assert.equal(result.mismatches[0].candidate.codes.join(','), '');
  });

  it('ignores problem order', () => {
    const base = [verdict(0, ['dd-missing', 'redirect'])];
    const candidate = [verdict(0, ['redirect', 'dd-missing'])];
    assert.equal(compareDiagnoses(base, candidate).verdict, 'identical');
  });

  it('refuses to compare different URL sets', () => {
    const result = compareDiagnoses([verdict(0), verdict(1)], [verdict(0)]);
    assert.equal(result.verdict, 'invalid');
    assert.equal(result.reason, 'different-scope');
    assert.match(result.findings[0].message, /only in base \[https:\/\/www\.ford\.mx\/page-1\/\]/);
  });

  it('matches by URL when a trimmed list shifted the indices', () => {
    // Re-pasting a list without the 6 removed URLs moves everything after them.
    const url = 'https://www.ford.mx/propietarios/';
    const base = [verdict(0), Object.assign(verdict(9, ['dd-missing'], { severity: 'high', siteSeverity: 'high' }), { url })];
    const candidate = [verdict(0), Object.assign(verdict(3, ['dd-missing'], { severity: 'high', siteSeverity: 'high' }), { url })];
    const result = compareDiagnoses(base, candidate);
    assert.equal(result.verdict, 'identical');
    assert.equal(result.compared, 2);
    assert.equal(result.remapped, 1);
  });

  it('reports the candidate index for a URL whose verdict changed after a shift', () => {
    const url = 'https://www.ford.mx/propietarios/';
    const base = [Object.assign(verdict(9, ['dd-missing']), { url })];
    const candidate = [Object.assign(verdict(3), { url })];
    const result = compareDiagnoses(base, candidate);
    assert.equal(result.verdict, 'differs');
    assert.equal(result.mismatches[0].index, 3);
    assert.equal(result.mismatches[0].baseIndex, 9);
  });

  it('accepts the exported envelope', () => {
    const base = { generatedAt: 'x', summary: {}, results: [verdict(0)] };
    assert.equal(compareDiagnoses(base, base).verdict, 'identical');
  });

  it('rejects anything that is not an export', () => {
    const result = compareDiagnoses({ nope: true }, []);
    assert.equal(result.verdict, 'invalid');
    assert.equal(result.reason, 'not-an-export');
  });
});

describe('compare-diagnosis CLI', () => {
  it('parses two paths and --json', () => {
    assert.deepEqual(parseArgs(['a.json', 'b.json', '--json']), {
      base: 'a.json',
      candidate: 'b.json',
      json: true
    });
  });

  it('exits 0 when the rules reproduce the same verdicts', () => {
    const base = tempFile('base.json', JSON.stringify({ results: [verdict(0), verdict(1, ['dd-missing'])] }));
    const candidate = tempFile('candidate.json', JSON.stringify({ results: [verdict(0), verdict(1, ['dd-missing'])] }));
    const run = quiet(() => main([base, candidate]));
    assert.equal(run.code, 0);
    assert.ok(run.lines.some((line) => line.includes('Verdict: identical')));
  });

  it('exits 1 and prints the deltas when a verdict moved', () => {
    const base = tempFile('base.json', JSON.stringify([verdict(0, ['dd-missing']) ]));
    const candidate = tempFile('candidate.json', JSON.stringify([verdict(0)]));
    const run = quiet(() => main([base, candidate]));
    assert.equal(run.code, 1);
    assert.ok(run.lines.some((line) => line.includes('dd-missing -1')));
    assert.ok(run.lines.some((line) => line.includes('#0')));
  });

  it('exits 2 on bad usage or unreadable input', () => {
    assert.equal(quiet(() => main([])).code, 2);
    const broken = tempFile('broken.json', '{not json');
    assert.equal(quiet(() => main([broken, broken])).code, 2);
  });

  it('tolerates a UTF-8 BOM', () => {
    const base = tempFile('base.json', '\uFEFF' + JSON.stringify([verdict(0)]));
    const candidate = tempFile('candidate.json', JSON.stringify([verdict(0)]));
    assert.equal(quiet(() => main([base, candidate])).code, 0);
  });
});
