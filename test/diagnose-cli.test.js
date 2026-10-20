// CLI tests for tools/diagnose.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main, parseArgs } = require('../tools/diagnose.js');

function tempFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-diagnose-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return { dir, file };
}

function quiet(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const code = fn();
    return { code, lines };
  } finally {
    console.error = original;
  }
}

const sample = [
  {
    index: 0,
    url: 'https://www.ford.mx/camiones/lobo/2026/',
    finalUrl: 'https://www.ford.mx/camiones/lobo/2026/',
    status: 'ok',
    truncated: false,
    digitalData: {
      page: {
        pageName: 'mx:es_mx:camiones:lobo:2026',
        pageInfo: { pageType: 'vehicle' },
        category: { primaryCategory: 'trucks' }
      }
    },
    adobeAnalytics: { s: { pageName: 'lobo' }, satellite: null, dataLayer: null },
    error: null,
    template: 'new',
    metrics_locale: 'es_mx'
  },
  {
    index: 1,
    url: 'https://www.ford.mx/propietarios/',
    finalUrl: 'https://www.ford.mx/propietarios/',
    status: 'no-data',
    truncated: false,
    digitalData: null,
    adobeAnalytics: null,
    error: null,
    template: 'old',
    metrics_locale: null
  }
];

describe('diagnose CLI arguments', () => {
  it('parses the input and --out', () => {
    assert.deepEqual(parseArgs(['export.json', '--out', 'problemas.json']), {
      input: 'export.json',
      out: 'problemas.json'
    });
  });

  it('rejects a second positional argument', () => {
    assert.throws(() => parseArgs(['a.json', 'b.json']), /Unexpected argument/);
  });
});

describe('diagnose CLI', () => {
  it('writes a diagnosis report next to the export', () => {
    const input = tempFile('export.json', JSON.stringify(sample));
    const out = path.join(input.dir, 'problemas.json');
    try {
      const { code, lines } = quiet(() => main([input.file, '--out', out]));
      assert.equal(code, 0);
      const report = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(report.summary.total, 2);
      assert.equal(report.summary.withProblems, 1);
      assert.equal(report.results[1].problems[0].code, 'dd-missing');
      assert.ok(lines.some((line) => line.includes('site high/medium/low')));
    } finally {
      fs.rmSync(input.dir, { recursive: true, force: true });
    }
  });

  it('prints to stdout when --out is absent', () => {
    const input = tempFile('export.json', JSON.stringify(sample));
    const original = process.stdout.write;
    let captured = '';
    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      const { code } = quiet(() => main([input.file]));
      assert.equal(code, 0);
      const report = JSON.parse(captured);
      assert.equal(report.summary.total, 2);
      // Provenance: a baseline without it cannot be compared as if it were
      // produced by the same rules.
      assert.equal(typeof report.rulesVersion, 'number');
    } finally {
      process.stdout.write = original;
      fs.rmSync(input.dir, { recursive: true, force: true });
    }
  });

  it('tolerates a UTF-8 BOM', () => {
    const input = tempFile('export.json', '\ufeff' + JSON.stringify(sample));
    const out = path.join(input.dir, 'problemas.json');
    try {
      const { code } = quiet(() => main([input.file, '--out', out]));
      assert.equal(code, 0);
      assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).summary.total, 2);
    } finally {
      fs.rmSync(input.dir, { recursive: true, force: true });
    }
  });

  it('rejects the summary file instead of the export array', () => {
    const input = tempFile('resumen.json', JSON.stringify({ total: 2 }));
    try {
      const { code, lines } = quiet(() => main([input.file]));
      assert.equal(code, 2);
      assert.ok(lines.some((line) => line.includes('combined export array')));
    } finally {
      fs.rmSync(input.dir, { recursive: true, force: true });
    }
  });

  it('rejects the DD-only view instead of reporting every page as dd-without-aa', () => {
    const ddOnly = sample.map(({ adobeAnalytics, ...rest }) => rest);
    const input = tempFile('dd-only.json', JSON.stringify(ddOnly));
    try {
      const { code, lines } = quiet(() => main([input.file]));
      assert.equal(code, 2);
      assert.ok(lines.some((line) => line.includes('not a combined export')));
      assert.ok(lines.some((line) => line.includes('adobeAnalytics')));
    } finally {
      fs.rmSync(input.dir, { recursive: true, force: true });
    }
  });

  it('returns 2 when the input is missing or unreadable', () => {
    const missing = quiet(() => main(['does-not-exist.json']));
    assert.equal(missing.code, 2);
    assert.equal(quiet(() => main([])).code, 2);
  });
});
