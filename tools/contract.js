#!/usr/bin/env node
// Derive a contract from a captured export, then check an export against it.
//   node tools/contract.js build <export.json> [--out contract.json] [--by page.siteSection] [--min-sample 3]
//   node tools/contract.js check <export.json> --contract <contract.json> [--out report.json] [--json]
const fs = require('node:fs');
const path = require('node:path');
const { buildContract, checkExport } = require('../lib/contract.js');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[name] = true;
      else { args[name] = next; i += 1; }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function readEntries(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array of entries`);
  return list;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const input = args._[1];
  if (!command || !input) {
    process.stderr.write('usage: contract.js build <export.json> [--out file]\n       contract.js check <export.json> --contract <file>\n');
    process.exit(2);
  }

  if (command === 'build') {
    const contract = buildContract(readEntries(input), {
      by: typeof args.by === 'string' ? args.by : 'page.siteSection',
      minSample: args['min-sample'] === undefined ? 3 : Number(args['min-sample'])
    });
    const groupNames = Object.keys(contract.groups);
    if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
    process.stdout.write(`Contract built from ${groupNames.length} group(s): ${groupNames.join(', ')}\n`);
    for (const name of groupNames) {
      const fields = contract.groups[name].fields;
      const literals = Object.entries(fields).filter(([, spec]) => spec.kind === 'literal').map(([field]) => field);
      const prefixes = Object.entries(fields).filter(([, spec]) => spec.kind === 'prefix').map(([field, spec]) => `${field}~"${spec.prefix}"`);
      process.stdout.write(`  ${name} (${contract.groups[name].sample} páginas) literal: ${literals.join(', ') || '-'}\n`);
      if (prefixes.length > 0) process.stdout.write(`    prefijo: ${prefixes.join(', ')}\n`);
    }
    if (contract.dropped.length > 0) {
      process.stdout.write(`  sin contrato: ${contract.dropped.map((item) => `${item.group} (${item.sample})`).join(', ')}\n`);
    }
    if (contract.skippedEntries > 0) process.stdout.write(`  entradas sin DD omitidas: ${contract.skippedEntries}\n`);
    if (args.out) process.stdout.write(`Wrote ${path.resolve(args.out)}\n`);
    return;
  }

  if (command === 'check') {
    if (typeof args.contract !== 'string') {
      process.stderr.write('check: --contract <file> is required\n');
      process.exit(2);
    }
    const contract = JSON.parse(fs.readFileSync(args.contract, 'utf8'));
    const report = checkExport(readEntries(input), contract);
    const byCode = {};
    const byField = {};
    for (const item of report.results) {
      for (const problem of item.problems) {
        byCode[problem.code] = (byCode[problem.code] || 0) + 1;
        byField[`${problem.code} ${problem.field}`] = (byField[`${problem.code} ${problem.field}`] || 0) + 1;
      }
    }
    if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ byCode, byField, checked: report.results.length }, null, 2)}\n`);
      return;
    }
    const total = Object.values(byCode).reduce((sum, value) => sum + value, 0);
    process.stdout.write(`${report.results.length} URL(s) with ${total} contract deviation(s)\n`);
    for (const [code, count] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${code}: ${count}\n`);
    }
    if (report.ungrouped.length > 0) process.stdout.write(`  grupos sin contrato (no evaluables): ${report.ungrouped.length}\n`);
    for (const item of report.results.slice(0, 5)) {
      process.stdout.write(`  #${item.index} [${item.group}] ${item.url}\n`);
      for (const problem of item.problems.slice(0, 3)) {
        process.stdout.write(`      ${problem.code} ${problem.field}: esperaba ${JSON.stringify(problem.expected)} · encontró ${JSON.stringify(problem.actual)}\n`);
      }
    }
    if (args.out) process.stdout.write(`Wrote ${path.resolve(args.out)}\n`);
    return;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}

main();
