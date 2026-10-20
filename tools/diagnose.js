#!/usr/bin/env node
// Diagnoses a combined export (the "Descargar JSON combinado" file) without the
// browser: no new crawl, just rules over what was already captured.
//
//   node tools/diagnose.js digitalData-resultados-123.json
//   node tools/diagnose.js export.json --out problemas.json
//
// Exit codes: 0 ok, 2 invalid input.
const fs = require('fs');
const path = require('path');
const { diagnoseEntries, summarizeDiagnosis, RULES_VERSION } = require('../lib/diagnose.js');
const { validateExport } = require('../lib/schema.js');
const { isPreviewUrl } = require('../lib/urls.js');

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!args.input) {
      args.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (args.help || !args.input) {
    console.error('Usage: node tools/diagnose.js <combined-export.json> [--out problemas.json]');
    return args.help ? 0 : 2;
  }

  let parsed;
  try {
    let text = fs.readFileSync(path.resolve(args.input), 'utf8');
    // Files re-saved on Windows often carry a BOM; JSON.parse rejects it.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    parsed = JSON.parse(text);
  } catch (e) {
    console.error(`Cannot read ${args.input}: ${e.message}`);
    return 2;
  }
  if (!Array.isArray(parsed)) {
    console.error('Input must be the combined export array (not the summary).');
    return 2;
  }

  // Diagnosing the wrong view is worse than failing: the DD-only export has no
  // adobeAnalytics field, so every entry would be reported as "dd-without-aa"
  // (a site defect) when the truth is that AA was never measured.
  const violations = validateExport(parsed);
  if (violations.length) {
    console.error(`Input is not a combined export (${violations.length} violation(s)):`);
    violations.slice(0, 5).forEach((v) => console.error('  - ' + v));
    console.error('Use the combined download ("Descargar JSON combinado"), not the DD/AA split views.');
    return 2;
  }

  const results = diagnoseEntries(parsed, { isPreviewUrl });
  const report = {
    generatedAt: new Date().toISOString(),
    // Which rules produced these verdicts. Without it, comparing this file
    // against a baseline taken under older rules looks like the site changed.
    rulesVersion: RULES_VERSION,
    summary: summarizeDiagnosis(results),
    results
  };
  const payload = JSON.stringify(report, null, 2);

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), payload + '\n', 'utf8');
    console.error(`Wrote ${args.out}`);
  } else {
    process.stdout.write(payload + '\n');
  }

  const summary = report.summary;
  console.error(
    `Diagnosed ${summary.total} entries · ${summary.withProblems} with problems ` +
    `(site high/medium/low: ${summary.bySiteSeverity.high}/${summary.bySiteSeverity.medium}/${summary.bySiteSeverity.low})`
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs };
