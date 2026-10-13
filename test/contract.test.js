// Contract test: the JSON this extension exports must satisfy the schema that
// downstream importers (e.g. MYCO pipeline step 5) rely on. Run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCombinedJson } = require('../lib/results.js');
const { validateExport, EXPORT_STATUS } = require('../lib/schema.js');

function sampleResults() {
  return {
    '0__https://shop.example/mustang': {
      url: 'https://shop.example/mustang', status: 'ok',
      digitalData: { page: { pageName: 'mustang' } },
      adobeAnalytics: { s: { pageName: 'mustang' }, satellite: { environment: 'production' }, dataLayer: null },
      error: null, truncated: false
    },
    '1__https://shop.example/mustang': {
      url: 'https://shop.example/mustang', status: 'ok',
      digitalData: { page: { pageName: 'mustang' } },
      adobeAnalytics: null, error: null, truncated: false
    },
    '2__https://preview.example/draft': {
      url: 'https://preview.example/draft', status: 'no-data',
      digitalData: null, adobeAnalytics: null, error: null, truncated: false
    },
    '3__https://broken.example/': {
      url: 'https://broken.example/', status: 'error',
      digitalData: null, adobeAnalytics: null, error: 'Timed out waiting for page load', truncated: false
    }
  };
}

describe('export contract', () => {
  it('a realistic export validates clean', () => {
    assert.deepEqual(validateExport(buildCombinedJson(sampleResults())), []);
  });

  it('documents the agreed status enum', () => {
    assert.deepEqual(EXPORT_STATUS, ['ok', 'no-data', 'error', 'pending']);
  });

  it('rejects missing fields, bad enums and out-of-order items', () => {
    const [okEntry, ...rest] = buildCombinedJson(sampleResults());
    const { index, ...withoutIndex } = okEntry;
    assert.ok(validateExport([withoutIndex]).some((v) => v.includes('missing required field "index"')));
    assert.ok(validateExport([{ ...okEntry, status: 'weird' }]).some((v) => v.includes('.status')));
    assert.ok(validateExport([{ ...okEntry, truncated: 'yes' }]).some((v) => v.includes('.truncated')));
    assert.ok(validateExport([...rest, okEntry]).some((v) => v.includes('out of order')));
    assert.ok(validateExport([{ ...okEntry, adobeAnalytics: 'nope' }]).some((v) => v.includes('.adobeAnalytics')));
  });

  it('rejects non-object items and mistyped payload fields', () => {
    const [okEntry] = buildCombinedJson(sampleResults());
    assert.ok(validateExport([null]).some((v) => v.includes('must be an object')));
    assert.ok(validateExport([{ ...okEntry, digitalData: 42 }]).some((v) => v.includes('.digitalData')));
    assert.ok(validateExport([{ ...okEntry, error: 5 }]).some((v) => v.includes('.error')));
    assert.ok(validateExport([{ ...okEntry, url: '' }]).some((v) => v.includes('.url')));
  });
});
