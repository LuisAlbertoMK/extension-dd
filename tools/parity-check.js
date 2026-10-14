#!/usr/bin/env node
// Parity check between two DD-view exports of the same URL list.
// Usage: node tools/parity-check.js <base-dd.json> <other-dd.json>
// Exits 0 on full parity, 1 on any difference. No dependencies.
const fs = require('fs');
const path = require('path');
const { diffDDExports, parityOk } = require('../lib/parity.js');

function load(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error(`${file}: top-level JSON must be an array (use Descargar DD)`);
  return data;
}

function main() {
  const [, , baseFile, otherFile] = process.argv;
  if (!baseFile || !otherFile) {
    console.error('Usage: node tools/parity-check.js <base-dd.json> <other-dd.json>');
    process.exit(2);
  }
  const diff = diffDDExports(load(baseFile), load(otherFile));
  console.log(`Parity: ${diff.matched}/${diff.total} matched`);
  diff.changed.forEach((c) => {
    console.log(`  [${c.kind}] #${c.index} ${c.url}`);
  });
  diff.onlyInBase.forEach((c) => console.log(`  [missing-in-other] #${c.index} ${c.url}`));
  diff.onlyInOther.forEach((c) => console.log(`  [missing-in-base] #${c.index} ${c.url}`));
  if (!parityOk(diff)) {
    console.log('RESULT: DIVERGED — do not adopt the perf branch for audits');
    process.exit(1);
  }
  console.log('RESULT: PARITY — safe to adopt');
}

main();
