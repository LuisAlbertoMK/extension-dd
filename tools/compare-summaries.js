#!/usr/bin/env node
// Compares two audit summaries ("Descargar resumen") produced from the SAME URL
// list, e.g. baseline branch vs candidate branch, and prints a verdict.
// Usage: node tools/compare-summaries.js <base-summary.json> <candidate-summary.json>
// Exit codes: 0 = adopt, 1 = adjust/reject, 2 = bad usage or unreadable input.
// No dependencies; the rules live in compareSummaries() so they are unit tested.
const fs = require('fs');
const { formatElapsed } = require('../lib/format.js');

const TIME_WARN = 1.15;
const TIME_REJECT = 1.25;

function statusSum(summary) {
  const s = summary.byStatus || {};
  return (s.ok || 0) + (s['no-data'] || 0) + (s.error || 0) + (s.pending || 0);
}

function ratio(candidate, base) {
  if (typeof candidate !== 'number' || typeof base !== 'number' || base <= 0) return null;
  return candidate / base;
}

// The extension exports expectedTotal (the list size when the job started) next
// to total (the URLs that actually produced a result), so total < expectedTotal
// means the run stopped early. Older exports lack the field: fall back to total
// and keep the previous behaviour.
function expectedTotal(summary) {
  const declared = summary.expectedTotal;
  return typeof declared === 'number' && declared > 0 ? declared : summary.total;
}

function compareSummaries(base, candidate) {
  const findings = [];
  const add = (level, message) => findings.push({ level, message });

  // Before anything else: a run that stopped early was not measured over the
  // whole list, so no delta from it means anything. Two partial runs would
  // otherwise agree on total and pass every check below.
  const stopped = [];
  if (base.total < expectedTotal(base)) stopped.push(`base stopped at ${base.total}/${expectedTotal(base)}`);
  if (candidate.total < expectedTotal(candidate)) {
    stopped.push(`candidate stopped at ${candidate.total}/${expectedTotal(candidate)}`);
  }
  if (stopped.length) {
    add('blocker', `Incomplete run (${stopped.join('; ')}): a partial list cannot be compared. Rerun the incomplete side over the whole list.`);
    return { verdict: 'invalid', findings, deltas: null };
  }

  if (base.total !== candidate.total) {
    add('blocker', `Different URL lists: base ${base.total} vs candidate ${candidate.total}. Rerun both with the same input.`);
    return { verdict: 'invalid', findings, deltas: null };
  }

  if (statusSum(base) !== base.total) {
    add('blocker', `base: byStatus does not add up to total (${statusSum(base)} vs ${base.total}).`);
  }
  if (statusSum(candidate) !== candidate.total) {
    add('blocker', `candidate: byStatus does not add up to total (${statusSum(candidate)} vs ${candidate.total}).`);
  }

  const ok = candidate.byStatus.ok - base.byStatus.ok;
  const noData = candidate.byStatus['no-data'] - base.byStatus['no-data'];
  const error = candidate.byStatus.error - base.byStatus.error;
  const truncated = candidate.truncated - base.truncated;

  if (ok < 0) {
    add('blocker', `Candidate lost ${-ok} OK entries: do not adopt. Check whether they became "Timeout waiting for page load" (raise TAB_LOAD_TIMEOUT_MS) or no-data holding a different payload (lower DIGITALDATA_STABLE_POLLS to 1).`);
  } else if (ok > 0) {
    add('info', `Candidate gained ${ok} OK entries (captures digitalData the old build dropped).`);
  } else {
    add('info', 'OK count unchanged: coverage is stable.');
  }

  if (error > 0 && noData < 0) {
    add('info', `Honest classification: ${error} more errors, ${-noData} fewer no-data.`);
  } else if (error === 0 && noData === 0) {
    add('warn', 'Status counts did not move: confirm the extension was reloaded with the candidate build.');
  }

  const newErrors = (candidate.topErrors || []).filter(
    (e) => !(base.topErrors || []).some((b) => b.message === e.message)
  );
  newErrors.forEach((e) => add('info', `New error message in candidate: "${e.message}" x${e.count}`));
  if (!newErrors.length && error > 0) {
    add('warn', 'More errors but the top error messages are identical: the new classification may not have triggered.');
  }

  if (truncated > 0) add('warn', `${truncated} more truncated entries than the base.`);

  const timeRatio = ratio(candidate.avgMsPerUrl, base.avgMsPerUrl);
  if (timeRatio === null) {
    add('warn', 'avgMsPerUrl missing on one side: per-URL time could not be compared.');
  } else if (timeRatio > TIME_REJECT) {
    add('blocker', `Per-URL time up ${Math.round((timeRatio - 1) * 100)}% (over ${Math.round((TIME_REJECT - 1) * 100)}%): adjust before adopting.`);
  } else if (timeRatio > TIME_WARN) {
    add('warn', `Per-URL time up ${Math.round((timeRatio - 1) * 100)}% (over ${Math.round((TIME_WARN - 1) * 100)}%). Expected: +0.5s per OK page and +8s per page with an empty digitalData.`);
  } else {
    add('info', `Per-URL time within margin (${Math.round((timeRatio - 1) * 100)}%).`);
  }

  const verdict = findings.some((f) => f.level === 'blocker')
    ? 'reject'
    : (findings.some((f) => f.level === 'warn') ? 'adjust' : 'adopt');

  return {
    verdict,
    findings,
    deltas: { ok, noData, error, truncated, timeRatio }
  };
}

function load(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object' || !data.byStatus) {
    throw new Error(`${file}: not an audit summary (use "Descargar resumen")`);
  }
  // The report reads these directly: fail with a clear message instead of a
  // TypeError halfway through printing the table.
  if (!data.byEnv || !data.byEnv.prod || !data.byEnv.preview || !data.adobe) {
    throw new Error(`${file}: summary is missing byEnv/adobe (re-export it with the current build)`);
  }
  return data;
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const perUrl = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : 'n/a');

function printReport(base, candidate, comparison) {
  const row = (label, a, b, delta) =>
    console.log(`${label.padEnd(12)} ${String(a).padStart(9)} ${String(b).padStart(9)} ${String(delta).padStart(9)}`);
  const d = comparison.deltas;

  console.log(`base      ${String(base.total).padStart(5)} URLs  ${formatElapsed(0, base.elapsedMs)} total`);
  console.log(`candidate ${String(candidate.total).padStart(5)} URLs  ${formatElapsed(0, candidate.elapsedMs)} total`);
  console.log('');
  row('metric', 'base', 'candidate', 'delta');
  row('ok', base.byStatus.ok, candidate.byStatus.ok, d ? signed(d.ok) : '-');
  row('no-data', base.byStatus['no-data'], candidate.byStatus['no-data'], d ? signed(d.noData) : '-');
  row('error', base.byStatus.error, candidate.byStatus.error, d ? signed(d.error) : '-');
  row('prod ok', base.byEnv.prod.ok, candidate.byEnv.prod.ok, d ? signed(candidate.byEnv.prod.ok - base.byEnv.prod.ok) : '-');
  row('preview ok', base.byEnv.preview.ok, candidate.byEnv.preview.ok, d ? signed(candidate.byEnv.preview.ok - base.byEnv.preview.ok) : '-');
  row('adobe.with', base.adobe.with, candidate.adobe.with, d ? signed(candidate.adobe.with - base.adobe.with) : '-');
  row('truncated', base.truncated, candidate.truncated, d ? signed(d.truncated) : '-');
  row('s/URL', perUrl(base.avgMsPerUrl), perUrl(candidate.avgMsPerUrl),
    d && d.timeRatio !== null ? `${Math.round((d.timeRatio - 1) * 100)}%` : '-');
  console.log('');

  comparison.findings.forEach((f) => console.log(`  [${f.level}] ${f.message}`));
  console.log('');

  if (comparison.verdict === 'invalid') {
    console.log('VERDICT: INVALID INPUT - the two runs did not cover the same URL list.');
  } else if (comparison.verdict === 'reject') {
    console.log('VERDICT: DO NOT ADOPT - a blocker above must be resolved first.');
  } else if (comparison.verdict === 'adjust') {
    console.log('VERDICT: ADOPT ONLY AFTER ADJUSTING - warnings above need a decision.');
  } else {
    console.log('VERDICT: ADOPT - coverage held and the status movement is explained.');
  }
}

function main() {
  const [, , baseFile, candidateFile] = process.argv;
  if (!baseFile || !candidateFile) {
    console.error('Usage: node tools/compare-summaries.js <base-summary.json> <candidate-summary.json>');
    process.exit(2);
  }
  let base;
  let candidate;
  try {
    base = load(baseFile);
    candidate = load(candidateFile);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(2);
  }
  const comparison = compareSummaries(base, candidate);
  printReport(base, candidate, comparison);
  process.exit(comparison.verdict === 'adopt' ? 0 : 1);
}

if (require.main === module) main();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compareSummaries, statusSum, TIME_WARN, TIME_REJECT };
}
