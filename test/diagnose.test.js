// Unit tests for lib/diagnose.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REQUIRED_FIELDS,
  diagnoseEntry,
  diagnoseEntries,
  summarizeDiagnosis,
  validateDiagnosisExport,
  urlSlug,
  expectedCountry
} = require('../lib/diagnose.js');

function entry(overrides) {
  return Object.assign({
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
    metrics_files: ['/etc.clientlibs/metrics.ford.es_mx.js'],
    metrics_locale: 'es_mx',
    has_fmc_context: true,
    has_aa_beacon: true
  }, overrides || {});
}

const codes = (diagnosis) => diagnosis.problems.map((item) => item.code);
const find = (diagnosis, code) => diagnosis.problems.find((item) => item.code === code);

describe('diagnoseEntry — clean page', () => {
  it('reports nothing for a page with DD, AA and the required fields', () => {
    const diagnosis = diagnoseEntry(entry());
    assert.deepEqual(diagnosis.problems, []);
    assert.equal(diagnosis.severity, 'none');
    assert.equal(diagnosis.siteSeverity, 'none');
  });
});

describe('diagnoseEntry — evidence quality (no false site blame)', () => {
  const noData = (overrides) => entry(Object.assign({
    status: 'no-data', digitalData: null, adobeAnalytics: null, has_aa_beacon: false
  }, overrides || {}));

  it('never blames the site for an entry that hit the storage cap', () => {
    const diagnosis = diagnoseEntry(noData({ truncated: true }));
    assert.equal(diagnosis.siteSeverity, 'none');
    assert.deepEqual(codes(diagnosis), ['dd-truncated']);
  });

  it('never blames the site for a URL that was queued but never processed', () => {
    const diagnosis = diagnoseEntry(noData({ status: 'pending' }));
    assert.equal(diagnosis.siteSeverity, 'none');
    assert.deepEqual(codes(diagnosis), ['pending']);
  });

  it('never blames the site when the entry status is not a known one', () => {
    const diagnosis = diagnoseEntry(noData({ status: 'weird' }));
    assert.equal(diagnosis.siteSeverity, 'none');
    assert.deepEqual(codes(diagnosis), ['invalid-status']);
  });

  it('treats an edge block as environment, not as missing data', () => {
    [403, 429].forEach((status) => {
      const diagnosis = diagnoseEntry(noData({ http_status: status }));
      assert.equal(diagnosis.siteSeverity, 'none');
      assert.equal(find(diagnosis, 'edge-blocked').attribution, 'env');
      assert.equal(diagnosis.severity, 'high');
    });
  });

  it('recognises a denial page without a status, so old exports can be re-read', () => {
    const diagnosis = diagnoseEntry(noData({ title: 'Access Denied' }));
    assert.equal(diagnosis.siteSeverity, 'none');
    assert.equal(find(diagnosis, 'edge-blocked').attribution, 'env');
  });

  it('does not blame the site for a server error or a dead URL', () => {
    const broken = diagnoseEntry(noData({ http_status: 503 }));
    assert.equal(broken.siteSeverity, 'none');
    assert.deepEqual(codes(broken), ['server-error']);

    const gone = diagnoseEntry(noData({ http_status: 404 }));
    assert.equal(gone.siteSeverity, 'none');
    assert.deepEqual(codes(gone), ['not-found']);
  });

  it('still reports a real absence when the page answered 200', () => {
    const diagnosis = diagnoseEntry(noData({ http_status: 200 }));
    assert.equal(diagnosis.siteSeverity, 'high');
    assert.deepEqual(codes(diagnosis), ['dd-missing']);
  });

  it('does not infer AA absence from an export that never measured it', () => {
    const withoutAA = entry();
    delete withoutAA.adobeAnalytics;
    const diagnosis = diagnoseEntry(withoutAA);
    assert.equal(diagnosis.siteSeverity, 'none');
    assert.deepEqual(codes(diagnosis), ['incomplete-entry']);
    assert.equal(find(diagnosis, 'incomplete-entry').attribution, 'tool');
  });

  it('treats a capped digitalData string as unreadable, not as a site defect', () => {
    const diagnosis = diagnoseEntry(entry({ digitalData: '{"page":' }));
    assert.equal(diagnosis.siteSeverity, 'none');
    assert.deepEqual(codes(diagnosis), ['dd-unreadable']);
  });

  it('keeps a healthy page clean when the status is 200', () => {
    assert.deepEqual(diagnoseEntry(entry({ http_status: 200 })).problems, []);
  });
});

describe('diagnoseEntry — missing data', () => {
  it('flags a page with neither DD nor AA as a site problem', () => {
    const diagnosis = diagnoseEntry(entry({ status: 'no-data', digitalData: null, adobeAnalytics: null, has_aa_beacon: false }));
    assert.deepEqual(codes(diagnosis), ['dd-missing']);
    assert.equal(find(diagnosis, 'dd-missing').attribution, 'site');
    assert.equal(diagnosis.severity, 'high');
    assert.equal(diagnosis.siteSeverity, 'high');
  });

  it('reports AA alive without DD when a beacon fired but s was unreadable', () => {
    const diagnosis = diagnoseEntry(entry({
      status: 'no-data', digitalData: null, adobeAnalytics: null, has_aa_beacon: true
    }));
    assert.deepEqual(codes(diagnosis), ['aa-without-dd']);
    assert.equal(diagnosis.severity, 'medium');
    assert.equal(diagnosis.siteSeverity, 'medium');
  });

  it('does not blame the site when the page never loaded', () => {
    const diagnosis = diagnoseEntry(entry({
      status: 'error',
      digitalData: null,
      adobeAnalytics: null,
      error: 'Timeout waiting for page load'
    }));
    assert.deepEqual(codes(diagnosis), ['load-error']);
    assert.equal(find(diagnosis, 'load-error').attribution, 'env');
    assert.equal(diagnosis.severity, 'high');
    assert.equal(diagnosis.siteSeverity, 'none');
  });

  it('detects AA without DD and DD without AA', () => {
    const aaOnly = diagnoseEntry(entry({ digitalData: null }));
    assert.ok(codes(aaOnly).includes('aa-without-dd'));
    assert.equal(find(aaOnly, 'aa-without-dd').severity, 'medium');

    const ddOnly = diagnoseEntry(entry({ adobeAnalytics: null }));
    assert.ok(codes(ddOnly).includes('dd-without-aa'));
    assert.equal(find(ddOnly, 'dd-without-aa').severity, 'medium');
  });
});

describe('diagnoseEntry — structural rules', () => {
  it('flags the fields the contract requires', () => {
    const diagnosis = diagnoseEntry(entry({
      digitalData: { page: {} }
    }));
    const fields = diagnosis.problems
      .filter((item) => item.code === 'missing-required')
      .map((item) => item.field);
    assert.deepEqual(fields, ['page.pageName']);
    assert.equal(diagnosis.severity, 'high');
  });

  it('treats blank strings as missing values', () => {
    const diagnosis = diagnoseEntry(entry({
      digitalData: { page: { pageName: '   ' } }
    }));
    assert.equal(diagnosis.problems.filter((item) => item.code === 'missing-required').length, 1);
  });

  it('accepts the default required-field contract as data', () => {
    assert.deepEqual(DEFAULT_REQUIRED_FIELDS, ['page.pageName']);
  });

  it('lets the required-field list be overridden per template', () => {
    const diagnosis = diagnoseEntry(entry(), { requiredFields: ['page.pageInfo.pageType', 'page.vehicle.model'] });
    assert.deepEqual(
      diagnosis.problems.filter((item) => item.code === 'missing-required').map((item) => item.field),
      ['page.vehicle.model']
    );
  });

  it('flags a truncated payload and skips field checks it cannot trust', () => {
    const diagnosis = diagnoseEntry(entry({ truncated: true, digitalData: '{"page":{"pageNa' }));
    assert.deepEqual(codes(diagnosis), ['dd-truncated']);
    assert.equal(find(diagnosis, 'dd-truncated').attribution, 'tool');
  });
});

describe('diagnoseEntry — coherence rules', () => {
  it('does not slug-match pageName by default (semantic naming)', () => {
    // Measured on a real run: 103/137 healthy pages use semantic names such as
    // "service:home" or "ford owners:benefits", so slug matching is opt-in.
    const diagnosis = diagnoseEntry(entry({
      digitalData: { page: { pageName: 'service:home' } }
    }));
    assert.equal(find(diagnosis, 'pageName-mismatch'), undefined);
    assert.deepEqual(diagnosis.problems, []);
  });

  it('accepts a pageName that contains the URL slug in another format', () => {
    const variants = [
      'mx:es_mx:camiones:lobo:2026',
      'Lobo',
      'mx/es_mx/camiones/lobo'
    ];
    variants.forEach((pageName) => {
      const diagnosis = diagnoseEntry(entry({
        digitalData: { page: { pageName, pageInfo: { pageType: 'vehicle' }, category: { primaryCategory: 'trucks' } } }
      }), { checkPageName: true });
      assert.deepEqual(diagnosis.problems, [], pageName);
    });
  });

  it('flags a pageName that describes another page when the check is enabled', () => {
    const diagnosis = diagnoseEntry(entry({
      digitalData: {
        page: { pageName: 'mx:es_mx:home', pageInfo: { pageType: 'home' }, category: { primaryCategory: 'trucks' } }
      }
    }), { checkPageName: true });
    const mismatch = find(diagnosis, 'pageName-mismatch');
    assert.ok(mismatch);
    assert.equal(mismatch.severity, 'medium');
    assert.equal(mismatch.expected, 'lobo');
    assert.equal(mismatch.actual, 'mx:es_mx:home');
  });

  it('ignores numeric segments and pages without a meaningful slug', () => {
    assert.equal(urlSlug('https://www.ford.mx/'), '');
    assert.equal(urlSlug('https://www.ford.mx/camiones/lobo/2026/'), 'lobo');
    assert.equal(urlSlug('https://www.ford.mx/2026/'), '');
    assert.equal(urlSlug('not a url'), '');

    const home = diagnoseEntry(entry({
      url: 'https://www.ford.mx/',
      finalUrl: 'https://www.ford.mx/',
      digitalData: {
        page: { pageName: 'mx:es_mx:home', pageInfo: { pageType: 'home' }, category: { primaryCategory: 'home' } }
      }
    }), { checkPageName: true });
    assert.equal(find(home, 'pageName-mismatch'), undefined);
  });

  it('reports a redirect without treating it as a site defect', () => {
    const diagnosis = diagnoseEntry(entry({ finalUrl: 'https://www.ford.mx/camiones/lobo/' }));
    const redirect = find(diagnosis, 'redirect');
    assert.ok(redirect);
    assert.equal(redirect.severity, 'low');
    assert.equal(redirect.attribution, 'env');
    assert.equal(diagnosis.siteSeverity, 'none');
  });

  it('explains an auth wall instead of blaming the site', () => {
    const diagnosis = diagnoseEntry(entry({
      url: 'https://www.ford.mx/propietarios/historial-servicio/',
      finalUrl: 'https://login.ford.mx/4566605f/B2C_1A_SignInSignUp_es-MX/oauth2/v2.0/authorize?redirect_uri=x',
      status: 'no-data',
      digitalData: null,
      adobeAnalytics: null
    }));
    assert.deepEqual(codes(diagnosis), ['auth-wall']);
    assert.equal(find(diagnosis, 'auth-wall').attribution, 'env');
    assert.equal(diagnosis.siteSeverity, 'none');
    assert.equal(diagnosis.severity, 'medium');
  });

  it('still flags missing data on a same-host redirect', () => {
    const diagnosis = diagnoseEntry(entry({
      finalUrl: 'https://www.ford.mx/camiones/lobo/2027/',
      status: 'no-data',
      digitalData: null,
      adobeAnalytics: null,
      has_aa_beacon: false
    }));
    assert.deepEqual(codes(diagnosis), ['dd-missing', 'redirect']);
    assert.equal(diagnosis.siteSeverity, 'high');
  });

  it('reports a legacy template only when the check is enabled', () => {
    const off = diagnoseEntry(entry({ template: 'old', metrics_locale: null }));
    assert.equal(find(off, 'template-old'), undefined);

    const on = diagnoseEntry(entry({ template: 'old', metrics_locale: null }), { checkTemplate: true });
    const legacy = find(on, 'template-old');
    assert.ok(legacy);
    assert.equal(legacy.severity, 'low');
    assert.equal(on.severity, 'low');
  });

  it('compares the metrics locale with the host country', () => {
    assert.equal(expectedCountry('https://www.ford.com.pr/esp/'), 'pr');
    assert.equal(expectedCountry('https://www.ford.mx/'), 'mx');
    assert.equal(expectedCountry('nope'), '');

    const mismatch = diagnoseEntry(entry({ metrics_locale: 'es_pr' }));
    assert.ok(codes(mismatch).includes('locale-mismatch'));

    const match = diagnoseEntry(entry({ metrics_locale: 'es_mx' }));
    assert.deepEqual(match.problems, []);
  });

  it('flags a truncated adobeDataLayer and a preview host', () => {
    const diagnosis = diagnoseEntry(entry({
      adobeAnalytics: {
        s: { pageName: 'lobo' },
        satellite: null,
        dataLayer: { totalEvents: 80, events: [], truncatedEvents: true }
      }
    }), { isPreviewUrl: () => true });
    assert.ok(codes(diagnosis).includes('adl-truncated'));
    assert.ok(codes(diagnosis).includes('preview-env'));
    assert.equal(find(diagnosis, 'adl-truncated').attribution, 'tool');
    assert.equal(find(diagnosis, 'preview-env').attribution, 'env');
  });

  it('does not blame a preview host it could not reach', () => {
    const diagnosis = diagnoseEntry(entry({
      status: 'no-data',
      digitalData: null,
      adobeAnalytics: null
    }), { isPreviewUrl: () => true });
    assert.deepEqual(codes(diagnosis), ['preview-env']);
    assert.equal(find(diagnosis, 'preview-env').severity, 'medium');
    assert.equal(find(diagnosis, 'preview-env').attribution, 'env');
    assert.equal(diagnosis.siteSeverity, 'none');
  });
});

describe('diagnoseEntry — defensive input', () => {
  it('rejects a non-object entry', () => {
    const diagnosis = diagnoseEntry(null);
    assert.deepEqual(codes(diagnosis), ['invalid-entry']);
    assert.equal(diagnosis.index, null);
    assert.equal(diagnosis.url, null);
  });

  it('flags an unknown status but keeps diagnosing', () => {
    const diagnosis = diagnoseEntry(entry({ status: 'weird' }));
    assert.ok(codes(diagnosis).includes('invalid-status'));
    assert.equal(find(diagnosis, 'invalid-status').attribution, 'tool');
  });

  it('flags an unprocessed entry', () => {
    const diagnosis = diagnoseEntry(entry({ status: 'pending' }));
    assert.ok(codes(diagnosis).includes('pending'));
  });

  it('aggregates the worst severity and sorts problems high first', () => {
    const diagnosis = diagnoseEntry(entry({
      template: 'old',
      digitalData: { page: {} }
    }), { checkTemplate: true });
    assert.equal(diagnosis.severity, 'high');
    assert.equal(diagnosis.problems[0].code, 'missing-required');
    assert.equal(diagnosis.problems[diagnosis.problems.length - 1].severity, 'low');
  });
});

describe('diagnoseEntries + summarizeDiagnosis', () => {
  const items = [
    entry({ index: 0 }),
    entry({ index: 1, status: 'no-data', digitalData: null, adobeAnalytics: null, has_aa_beacon: false }),
    entry({ index: 2, status: 'error', digitalData: null, adobeAnalytics: null, error: 'boom' }),
    entry({ index: 3, template: 'old' })
  ];

  it('keeps export order and index identity', () => {
    const diagnoses = diagnoseEntries(items, { checkTemplate: true });
    assert.deepEqual(diagnoses.map((item) => item.index), [0, 1, 2, 3]);
    assert.deepEqual(diagnoses.map((item) => item.severity), ['none', 'high', 'high', 'low']);
  });

  it('summarizes entries by severity, site severity and code', () => {
    const summary = summarizeDiagnosis(diagnoseEntries(items, { checkTemplate: true }));
    assert.equal(summary.total, 4);
    assert.equal(summary.withProblems, 3);
    assert.equal(summary.bySeverity.high, 2);
    assert.equal(summary.bySeverity.low, 1);
    assert.equal(summary.bySiteSeverity.high, 1);
    assert.equal(summary.byAttribution.site, 2);
    assert.equal(summary.byAttribution.env, 1);
    assert.equal(summary.byAttribution.tool, 0);
    assert.equal(summary.byCode['dd-missing'], 1);
    assert.equal(summary.byCode['load-error'], 1);
    assert.equal(summary.byCode['template-old'], 1);
  });

  it('handles an empty run', () => {
    assert.deepEqual(summarizeDiagnosis([]).total, 0);
    assert.deepEqual(summarizeDiagnosis(undefined).byCode, {});
  });
});

describe('validateDiagnosisExport', () => {
  const clean = () => diagnoseEntries([entry({ index: 0 }), entry({ index: 1, status: 'no-data', digitalData: null, adobeAnalytics: null })]);

  it('accepts a clean export', () => {
    assert.deepEqual(validateDiagnosisExport(clean()), []);
  });

  it('rejects non-arrays and non-object items', () => {
    assert.deepEqual(validateDiagnosisExport({}), ['export must be an array']);
    assert.ok(validateDiagnosisExport([null]).some((v) => v.includes('must be an object')));
  });

  it('rejects a missing field, a bad severity and out-of-order items', () => {
    const [first, second] = clean();
    const { siteSeverity, ...withoutSiteSeverity } = first;
    assert.ok(validateDiagnosisExport([withoutSiteSeverity]).some((v) => v.includes('missing required field "siteSeverity"')));
    assert.ok(validateDiagnosisExport([{ ...first, severity: 'fatal' }]).some((v) => v.includes('.severity')));
    assert.ok(validateDiagnosisExport([second, first]).some((v) => v.includes('out of order')));
  });

  it('rejects a malformed problem entry', () => {
    const [first] = clean();
    const withBadProblem = {
      ...first,
      problems: [{ code: '', severity: 'nope', attribution: 'blame' }]
    };
    const violations = validateDiagnosisExport([withBadProblem]);
    assert.ok(violations.some((v) => v.includes('problems[0].code')));
    assert.ok(violations.some((v) => v.includes('problems[0].severity')));
    assert.ok(violations.some((v) => v.includes('problems[0].attribution')));
  });
});
