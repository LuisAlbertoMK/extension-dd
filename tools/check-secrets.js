#!/usr/bin/env node
// Refuses to stage the local config or any content carrying its values.
// The secret itself is never stored here: the guard reads config.local.js at
// check time, so rotating the key needs no change to this file.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_CONFIG = 'config.local.js';
const MIN_SECRET_LENGTH = 8;
// A real edge key in a tracked file: `X-AEM-Edge-Key: <long opaquel value>`.
const EDGE_KEY_INLINE = /X-AEM-Edge-Key[\s'"\]]*[:=]\s*['"]([A-Za-z0-9+/=_-]{12,})['"]/;
const PLACEHOLDER = /^(|REPLACE_ME|xxx+|your[-_]?key.*|placeholder.*)$/i;

function extractSecrets(source) {
  const secrets = [];
  const pattern = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*'([^']*)'/gm;
  let match = pattern.exec(source);
  while (match !== null) {
    const value = match[1];
    if (value.length >= MIN_SECRET_LENGTH && !PLACEHOLDER.test(value)) secrets.push(value);
    match = pattern.exec(source);
  }
  return secrets;
}

function scanContent(content, secrets) {
  const findings = [];
  for (const secret of secrets) {
    if (content.includes(secret)) findings.push('contains a value from config.local.js');
  }
  const inline = EDGE_KEY_INLINE.exec(content);
  if (inline && !PLACEHOLDER.test(inline[1])) findings.push('contains an inline X-AEM-Edge-Key value');
  return findings;
}

function stagedFiles() {
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    encoding: 'utf8'
  }).split('\n').map((line) => line.trim()).filter(Boolean);
}

function stagedContent(file) {
  return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const configPath = path.join(root, LOCAL_CONFIG);
  const secrets = fs.existsSync(configPath) ? extractSecrets(fs.readFileSync(configPath, 'utf8')) : [];

  const failures = [];
  for (const file of stagedFiles()) {
    if (path.basename(file) === LOCAL_CONFIG || /(^|\/)\.env(\..*)?$/.test(file)) {
      failures.push(`${file}: local secrets file must never be committed`);
      continue;
    }
    let content;
    try {
      content = stagedContent(file);
    } catch (error) {
      continue; // binary or unreadable from the index
    }
    for (const finding of scanContent(content, secrets)) failures.push(`${file}: ${finding}`);
  }

  if (failures.length > 0) {
    process.stderr.write('Refusing to commit:\n');
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.stderr.write('Fix the staged content, or rotate and keep the value in config.local.js only.\n');
    process.exit(1);
  }
  process.stdout.write(`No secrets staged (${secrets.length} local value(s) checked).\n`);
}

if (require.main === module) main();

module.exports = { extractSecrets, scanContent };
