#!/usr/bin/env node
// Compares two diagnosis exports produced from the SAME URL list and reports
// whether the rules reproduced the same verdicts. This is a regression check for
// lib/diagnose.js, not a site audit: when entries differ, inspect the named
// indices — either the rules changed or the page changed between runs.
// Usage: node tools/compare-diagnosis.js <base.json> <candidate.json>
// Exit codes: 0 = identical, 1 = verdicts differ, 2 = bad usage or unreadable input.
const fs = require('fs');
const { compareDiagnoses } = require('../lib/diagnose.js');

function parseArgs(argv) {
  const args = { base: null, candidate: null, json: false };
  const rest = [];
  argv.forEach((arg) => {
    if (arg === '--json') args.json = true;
    else if (!arg.startsWith('-')) rest.push(arg);
  });
  args.base = rest[0] || null;
  args.candidate = rest[1] || null;
  return args;
}

function readExport(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function rulesVersionOf(data) {
  if (!data || Array.isArray(data) || !Object.prototype.hasOwnProperty.call(data, 'rulesVersion')) return null;
  return data.rulesVersion;
}

// Determinism only holds inside one ruleset. Saying which side ran which rules
// turns "the verdicts moved" into either "expected, the rules changed" or
// "unexpected, the site or the capture did".
function describeRulesVersion(base, candidate) {
  const left = rulesVersionOf(base);
  const right = rulesVersionOf(candidate);
  if (left == null && right == null) return null;
  const label = (value) => (value == null ? 'unknown' : `v${value}`);
  if (left === right) return `Rules: ${label(left)} on both sides`;
  return `[info] different ruleset: base ${label(left)}, candidate ${label(right)} — a diff is expected, not a site change`;
}

// A comparison over a run that dropped a URL is not like-for-like: the missing
// index surfaces as "only in one side" and reads like a page that changed. Say
// which side was short before showing the diff.
function describeCompleteness(base, candidate) {
  const rows = [];
  [['base', base], ['candidate', candidate]].forEach(([label, data]) => {
    if (!data || Array.isArray(data)) return;
    const c = data.completeness;
    if (!c || c.complete) return;
    const ids = (Array.isArray(c.missing) ? c.missing : [])
      .map((m) => `#${m.index}${m.url ? ` ${m.url}` : ''}`)
      .join(', ');
    rows.push(
      `[info] ${label} capture is incomplete: ${c.captured}/${c.expectedTotal}` +
      `${c.cancelled ? ' (cancelled)' : ''}${ids ? `; missing ${ids}` : ''}`
    );
  });
  return rows;
}

function formatReport(result) {  const lines = [];
  result.findings.forEach((finding) => lines.push(`[${finding.level}] ${finding.message}`));
  if (result.deltas && Object.keys(result.deltas).length) {
    const deltas = Object.keys(result.deltas).map((code) => `${code} ${result.deltas[code] > 0 ? '+' : ''}${result.deltas[code]}`);
    lines.push(`Code deltas: ${deltas.join(', ')}`);
  }
  result.mismatches.slice(0, 20).forEach((item) => {
    const before = item.base.codes.join(',') || '-';
    const after = item.candidate.codes.join(',') || '-';
    lines.push(`#${item.index} ${item.url || ''} | ${before} → ${after}`);
  });
  return lines;
}

function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  if (!args.base || !args.candidate) {
    console.error('Usage: node tools/compare-diagnosis.js <base.json> <candidate.json> [--json]');
    return 2;
  }
  let result;
  let baseData;
  let candidateData;
  try {
    baseData = readExport(args.base);
    candidateData = readExport(args.candidate);
    result = compareDiagnoses(baseData, candidateData);
  } catch (error) {
    console.error(`Cannot read exports: ${error.message}`);
    return 2;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    formatReport(result).forEach((line) => console.log(line));
    describeCompleteness(baseData, candidateData).forEach((line) => console.log(line));
    const rulesLine = describeRulesVersion(baseData, candidateData);
    if (rulesLine) console.log(rulesLine);
    console.log(`Verdict: ${result.verdict} (${result.compared} entries compared)`);
  }

  if (result.verdict === 'identical') return 0;
  return result.verdict === 'differs' ? 1 : 2;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { compareDiagnoses, parseArgs, formatReport, rulesVersionOf, describeRulesVersion, describeCompleteness, main };
