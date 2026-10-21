const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildContract, checkExport, commonPrefix } = require('../lib/contract.js');

function page(overrides) {
  return {
    siteSection: 'help',
    client: 'lincoln mexico',
    site: 'lincoln-brand',
    radUIVersion: 'ui:rad:pc',
    userLanguage: 'esp',
    hierarchy: 'help:a',
    pageName: 'help:a',
    pageNameNoVehicle: 'help:a',
    variantName: 'global-load',
    ...(overrides || {})
  };
}

function entry(index, pageOverrides, extra) {
  return {
    index,
    url: `https://www.lincoln.mx/help/${index}/`,
    status: 'ok',
    digitalData: { page: page(pageOverrides) },
    ...(extra || {})
  };
}

const three = () => [
  entry(0),
  entry(1, { pageName: 'help:b', pageNameNoVehicle: 'help:b', hierarchy: 'help:b' }),
  entry(2, { pageName: 'help:c', pageNameNoVehicle: 'help:c', hierarchy: 'help:c' })
];

describe('buildContract', () => {
  it('turns a constant field into a literal and a varying name into a prefix', () => {
    const contract = buildContract(three());
    assert.deepEqual(Object.keys(contract.groups), ['help']);
    assert.equal(contract.groups.help.sample, 3);
    assert.deepEqual(contract.groups.help.fields.client, { kind: 'literal', value: 'lincoln mexico', coverage: 1 });
    assert.deepEqual(contract.groups.help.fields.pageName, { kind: 'prefix', prefix: 'help:', coverage: 1 });
  });

  it('leaves a field that is empty on part of the group out of the contract', () => {
    // The bug this pins: a value carried by 3 of 4 pages is template variance.
    // Turning it into a rule blames the fourth page for the template's shape.
    const entries = three().concat([entry(3, { variantName: '' })]);
    const contract = buildContract(entries);
    assert.equal(contract.groups.help.fields.variantName, undefined);
    assert.equal(contract.groups.help.fields.client.kind, 'literal');
  });

  it('drops a group with fewer pages than minSample', () => {
    const entries = three().concat([
      entry(4, { siteSection: 'vehicle', pageName: 'vehicle:x' }),
      entry(5, { siteSection: 'vehicle', pageName: 'vehicle:y' })
    ]);
    const contract = buildContract(entries, { minSample: 3 });
    assert.equal(contract.groups.vehicle, undefined);
    assert.deepEqual(contract.dropped.map((item) => item.group), ['vehicle']);
  });

  it('ignores entries without a captured data layer', () => {
    const entries = three().concat([{ index: 9, url: 'https://www.ford.mx/x/', status: 'no-data', digitalData: null }]);
    const contract = buildContract(entries);
    assert.equal(contract.skippedEntries, 1);
    assert.equal(contract.groups.help.sample, 3);
  });
});

describe('checkExport', () => {
  it('produces no findings against the export it was derived from', () => {
    const entries = three();
    const contract = buildContract(entries);
    assert.deepEqual(checkExport(entries, contract).results, []);
  });

  it('flags a wrong literal, a wrong prefix and a missing value', () => {
    const entries = three();
    const contract = buildContract(entries);
    const drifted = [
      entry(10, { client: 'ford-mexico' }),
      entry(11, { pageName: 'promotions:x' }),
      entry(12, { site: '' })
    ];
    const report = checkExport(drifted, contract);
    assert.equal(report.results.length, 3);
    const codes = report.results.map((item) => item.problems[0].code);
    assert.deepEqual(codes, ['contract-value', 'contract-prefix', 'contract-missing']);
  });

  it('does not evaluate a page whose group has no contract', () => {
    const contract = buildContract(three());
    const report = checkExport([entry(20, { siteSection: 'unknown' })], contract);
    assert.deepEqual(report.results, []);
    assert.deepEqual(report.ungrouped, [20]);
  });
});

describe('commonPrefix', () => {
  it('cuts back to a token boundary instead of a partial token', () => {
    assert.equal(commonPrefix(['help:terms and conditions', 'help:privacy']), 'help:');
    assert.equal(commonPrefix(['promotions', 'promotions:x']), 'promotions');
    assert.equal(commonPrefix(['cpo:a', 'promotions:b']), '');
  });
});
