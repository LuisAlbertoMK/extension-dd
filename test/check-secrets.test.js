const { describe, it } = require('node:test');
const assert = require('node:assert');
const { extractSecrets, scanContent } = require('../tools/check-secrets.js');

describe('check-secrets', () => {
  it('extracts only values long enough to be credentials', () => {
    const secrets = extractSecrets([
      "globalThis.FORD_CONFIG = {",
      "  edgeValue: 'abcdefghijklmnopqrst',",
      "  cookieValue: 'true',",
      "  note: 'short'",
      "};"
    ].join('\n'));
    assert.deepEqual(secrets, ['abcdefghijklmnopqrst']);
  });

  it('ignores placeholder values so config.example.js stays committable', () => {
    const secrets = extractSecrets([
      "globalThis.FORD_CONFIG = {",
      "  edgeValue: 'REPLACE_ME',",
      "  cookieValue: 'placeholder-value'",
      "};"
    ].join('\n'));
    assert.deepEqual(secrets, []);
  });

  it('flags a leaked value even when it is not the whole line', () => {
    const findings = scanContent('const key = "abcdefghijklmnopqrst";', ['abcdefghijklmnopqrst']);
    assert.equal(findings.length, 1);
  });

  it('flags an inline edge key that was hardcoded', () => {
    // Assembled so this fixture cannot trip the guard on its own source.
    const header = ['X-AEM-Edge', 'Key'].join('-');
    const findings = scanContent(`headers['${header}'] = 'ABCDEF0123456789abcd';`, []);
    assert.deepEqual(findings, ['contains an inline X-AEM-Edge-Key value']);
  });

  it('stays quiet on clean content and on the empty-key fallback', () => {
    assert.deepEqual(scanContent("const FORD_EDGE_VALUE = '';", []), []);
    assert.deepEqual(scanContent("const FORD_EDGE_HEADER = 'X-AEM-Edge-Key';", []), []);
  });
});
