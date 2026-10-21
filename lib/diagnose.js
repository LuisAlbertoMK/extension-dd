// Pure diagnostic rules over captured entries. No browser APIs here: the same
// module runs inside results.js and in node (tests + tools/diagnose.js).
//
// A diagnosis is DERIVED, never persisted. Rules change; re-diagnosing a stored
// run must not require crawling the site again. That is why nothing in this file
// writes to storage or mutates the entry.
//
// Every problem carries an attribution:
//   site -> the page is missing or misreporting data (this is what becomes AJUSTES)
//   tool -> the audit itself could not produce trustworthy evidence
//   env  -> environment/infrastructure answer, not a defect to file yet

const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3 };
const SEVERITIES = ['low', 'medium', 'high'];
const ATTRIBUTIONS = ['site', 'tool', 'env'];
const DIAGNOSIS_STATUS = ['ok', 'no-data', 'error', 'pending'];

// Bump this whenever a rule changes what a verdict means. A diagnosis export
// carries it so a comparison against an older baseline can say "the rules moved"
// instead of pretending the site changed. Determinism is only meaningful within
// the same ruleset.
const RULES_VERSION = 5;

// Fields the digitalData contract needs on every page. Override per template
// once the client fixes the real contract: it is data, not code.
//
// Calibrated against a real 155-URL run (Ford/Lincoln MX): page.pageName exists
// on 90% of the pages that carry a data layer, while page.pageInfo.pageType and
// page.category.primaryCategory (the digitalData spec paths) exist on 0%. Making
// the spec the default produced 288 findings that described our assumption, not
// the site. A default only earns its place when most pages already have it.
const DEFAULT_REQUIRED_FIELDS = ['page.pageName'];

// Slugs that identify no page in particular, so a missing match proves nothing.
const GENERIC_SLUGS = ['index', 'home', 'inicio', 'default', 'landing'];

// Denial interstitials served by an edge (Akamai and friends) return 200 with a
// body that is not the page. Without the HTTP status, the title is the only
// signal an old export has; it never overrides a real status code.
const DENIAL_TITLE = /^\s*(access denied|access forbidden|web page blocked|request rejected|forbidden|403 forbidden)\b/i;

function readPath(value, path) {
  let current = value;
  const keys = String(path).split('.');
  for (let i = 0; i < keys.length; i++) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[keys[i]];
  }
  return current;
}

function isBlank(value) {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

// Case and accent insensitive token used to compare pageName against the URL.
function normalizeToken(value) {
  return String(value === undefined || value === null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Last meaningful path segment: /camiones/lobo/2026/ -> "lobo". Numeric segments
// (years, ids) say nothing about which page the data layer describes.
function urlSlug(raw) {
  let path;
  try {
    path = new URL(String(raw || '')).pathname;
  } catch (e) {
    return '';
  }
  const segments = path.split('/').filter(Boolean).reverse();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (/^\d+$/.test(segment)) continue;
    if (segment.length < 3) continue;
    return segment;
  }
  return '';
}

// Country label of the host: www.ford.com.pr -> "pr", www.ford.mx -> "mx".
function expectedCountry(raw) {
  try {
    const labels = new URL(String(raw || '')).hostname.toLowerCase().split('.');
    const last = labels[labels.length - 1] || '';
    return /^[a-z]{2}$/.test(last) ? last : '';
  } catch (e) {
    return '';
  }
}

// The data layer belongs to the page that finally loaded. When that page is an
// identity provider, the requested URL was never reached: blaming the site for a
// missing data layer there is a false positive (measured: 2/155 real cases, both
// owner portals redirecting to login.<brand>).
// The literal string "undefined" is what a template writes when the variable it
// interpolated was never defined. It is matched exactly or as a prefix so a real
// value that merely contains the word is not flagged.
const UNDEFINED_LITERAL = /^undefined(?:[/:]|$)/;
const WALK_MAX_DEPTH = 6;
const WALK_MAX_NODES = 4000;

function findUndefinedValues(root) {
  const found = [];
  let visited = 0;
  const walk = (node, path, depth) => {
    if (found.length >= 20 || depth > WALK_MAX_DEPTH || visited >= WALK_MAX_NODES) return;
    visited += 1;
    if (typeof node === 'string') {
      if (UNDEFINED_LITERAL.test(node)) found.push({ path, value: node });
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      walk(node[key], path ? `${path}.${key}` : key, depth + 1);
      if (found.length >= 20) return;
    }
  };
  walk(root, '', 0);
  return found;
}

function looksLikeAuthWall(finalUrl, requestedUrl) {
  let finalParsed;
  try {
    finalParsed = new URL(String(finalUrl || ''));
  } catch (e) {
    return false;
  }
  let requestedHost = '';
  try {
    requestedHost = new URL(String(requestedUrl || '')).hostname.toLowerCase();
  } catch (e) { /* keep empty */ }
  const finalHost = finalParsed.hostname.toLowerCase();
  if (finalHost === requestedHost) return false;
  if (/^(login|signin|sso|auth)\./.test(finalHost)) return true;
  return /\/oauth2\//i.test(finalParsed.pathname) || /\/authorize\/?$/i.test(finalParsed.pathname);
}

function problem(code, severity, attribution, extra) {
  return Object.assign({ code, severity, attribution }, extra || {});
}

function buildVerdict(entry, items) {
  const problems = items.slice().sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return bySeverity !== 0 ? bySeverity : a.code.localeCompare(b.code);
  });
  const maxOf = (list) => list.reduce(
    (max, item) => Math.max(max, SEVERITY_RANK[item.severity] || 0),
    0
  );
  const severity = maxOf(problems);
  const siteSeverity = maxOf(problems.filter((item) => item.attribution === 'site'));
  const safeEntry = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  return {
    index: Number.isInteger(safeEntry.index) ? safeEntry.index : null,
    url: typeof safeEntry.url === 'string' ? safeEntry.url : null,
    finalUrl: typeof safeEntry.finalUrl === 'string' ? safeEntry.finalUrl : null,
    status: typeof safeEntry.status === 'string' ? safeEntry.status : null,
    severity: ['none'].concat(SEVERITIES)[severity],
    siteSeverity: ['none'].concat(SEVERITIES)[siteSeverity],
    problems
  };
}

function diagnoseEntry(entry, options) {
  const opts = options || {};
  const requiredFields = Array.isArray(opts.requiredFields) ? opts.requiredFields : DEFAULT_REQUIRED_FIELDS;
  const isPreview = typeof opts.isPreviewUrl === 'function' ? opts.isPreviewUrl : () => false;
  const maxAdlEvents = Number.isFinite(opts.maxAdlEvents) ? opts.maxAdlEvents : 50;
  // Both are off by default because the measured false-positive rate is too high
  // to survive contact with a real client: see the calibration notes below.
  const checkPageName = opts.checkPageName === true;
  const checkTemplate = opts.checkTemplate === true;

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return buildVerdict({}, [problem('invalid-entry', 'high', 'tool', { detail: 'Entry is not an object' })]);
  }

  const items = [];
  const status = entry.status;
  const dd = entry.digitalData;
  const aa = entry.adobeAnalytics;

  if (!DIAGNOSIS_STATUS.includes(status)) {
    items.push(problem('invalid-status', 'medium', 'tool', {
      field: 'status',
      actual: status === undefined ? null : String(status)
    }));
  }

  if (status === 'pending') {
    items.push(problem('pending', 'low', 'tool', { detail: 'URL was queued but never processed' }));
  }

  const authWall = status !== 'error' && looksLikeAuthWall(entry.finalUrl, entry.url);
  const preview = isPreview(entry.url);
  // A preview host without a data layer usually means the capture never had
  // access (VPN), not that the page is broken. Same discipline as the auth wall:
  // do not blame the site for evidence we could not collect.
  const unverifiedPreview = preview && status !== 'error' && !dd && !aa;

  // --- Evidence quality -----------------------------------------------------
  // These flags decide whether "there is no data layer" is a fact about the site
  // or a fact about our measurement. Every one of them was a measured false
  // positive: a queued URL, a capped entry and an export that never had an
  // adobeAnalytics field all used to become a high-severity site defect.
  const truncated = entry.truncated === true;
  const unreadableDd = !truncated && dd !== undefined && dd !== null &&
    (typeof dd !== 'object' || Array.isArray(dd));
  const aaMeasured = Object.prototype.hasOwnProperty.call(entry, 'adobeAnalytics');
  const noEvidence = status === 'pending' || !DIAGNOSIS_STATUS.includes(status) ||
    truncated || unreadableDd;

  // HTTP status of the final main-frame response (captured by the worker). A 403
  // or 429 is an edge block, a 5xx is a broken server and a 404 an URL that no
  // longer exists: none of them is evidence about the data layer. Without a
  // status, a denial title is the fallback so old exports can be re-read.
  const httpStatus = Number.isInteger(entry.http_status) ? entry.http_status : null;
  const edgeBlocked = httpStatus === 403 || httpStatus === 429 ||
    (httpStatus === null && DENIAL_TITLE.test(String(entry.title || '')));
  const serverError = httpStatus !== null && httpStatus >= 500;
  const pageGone = httpStatus === 404 || httpStatus === 410;
  // 431/414 reject the REQUEST, not the page: the response never carried a
  // document, so nothing about the data layer is observable. Measured on
  // ford.com.pr (5 sitemap siblings answered 431 in one run and 404 in the
  // previous one): calling that "no digitalData" blamed the site for an
  // oversized-header refusal that is ours to fix.
  const requestRejected = httpStatus === 431 || httpStatus === 414;
  const unavailable = noEvidence || edgeBlocked || serverError || pageGone || requestRejected;

  if (unreadableDd) {
    items.push(problem('dd-unreadable', 'high', 'tool', {
      detail: 'digitalData was stored as raw text (capped); its fields cannot be read'
    }));
  }
  if (!aaMeasured) {
    items.push(problem('incomplete-entry', 'medium', 'tool', {
      detail: 'Entry has no adobeAnalytics field: AA was never measured'
    }));
  }

  if (status === 'error') {
    // A load failure is not evidence that the site lacks a data layer.
    items.push(problem('load-error', 'high', 'env', { detail: String(entry.error || 'unknown') }));
  } else if (authWall) {
    // Never reached the requested page, so its data layer was never observable.
    items.push(problem('auth-wall', 'medium', 'env', {
      detail: 'Redirected to an identity provider; the requested page was never reached'
    }));
  } else if (edgeBlocked) {
    items.push(problem('edge-blocked', 'high', 'env', {
      field: 'http_status',
      detail: httpStatus === null
        ? 'Denial page served instead of the requested one (edge block)'
        : `HTTP ${httpStatus}: the edge refused to serve the page (rate limit or bot rule)`
    }));
  } else if (serverError) {
    items.push(problem('server-error', 'high', 'env', {
      field: 'http_status',
      detail: `HTTP ${httpStatus}: the server failed before any data layer could run`
    }));
  } else if (pageGone) {
    items.push(problem('not-found', 'medium', 'env', {
      field: 'http_status',
      detail: `HTTP ${httpStatus}: the URL no longer exists in this environment`
    }));
  } else if (requestRejected) {
    items.push(problem('request-rejected', 'high', 'env', {
      field: 'http_status',
      detail: `HTTP ${httpStatus}: the server rejected the request headers, so the page never ran`
    }));
  } else if (unverifiedPreview) {
    items.push(problem('preview-env', 'medium', 'env', {
      detail: 'Preview host without a data layer; verification requires VPN access'
    }));
  } else if (!unavailable) {
    if (!dd && !aa) {
      // A beacon proves Adobe Analytics is reporting even when the `s` snapshot
      // could not be read. Calling that "no data at all" overstated the finding
      // and hid the real shape: DD missing, tracking alive.
      if (entry.has_aa_beacon === true) {
        items.push(problem('aa-without-dd', 'medium', 'site', {
          detail: 'AA beacon observed, digitalData missing (the s snapshot was not readable)'
        }));
      } else {
        items.push(problem('dd-missing', 'high', 'site', {
          detail: aaMeasured
            ? 'No window.digitalData and no Adobe Analytics snapshot'
            : 'No window.digitalData'
        }));
      }
    } else if (!dd) {
      items.push(problem('aa-without-dd', 'medium', 'site', {
        detail: 'Adobe Analytics present, digitalData missing'
      }));
    } else if (!aa && aaMeasured) {
      items.push(problem('dd-without-aa', 'medium', 'site', {
        detail: 'digitalData present, Adobe Analytics missing'
      }));
    }
  }

  // A dead URL still renders the RadUI error template on this client: the DD
  // shell is present with every page value empty, and AA receives a page view
  // with no pageName. Measured on three Lincoln /promociones URLs whose
  // payloads were identical except for the URL, so this is one template defect
  // rather than three page defects — reported alongside not-found, not instead
  // of it, and only when the beacon actually fired.
  const errorPageInstrumented = pageGone && entry.has_aa_beacon === true &&
    !!dd && typeof dd === 'object' && !Array.isArray(dd) &&
    !!readPath(dd, 'page') && isBlank(readPath(dd, 'page.pageName'));
  if (errorPageInstrumented) {
    items.push(problem('error-page-no-pagename', 'medium', 'site', {
      field: 'page.pageName',
      detail: `HTTP ${httpStatus}: the error template beacons an AA page view with an empty pageName`
    }));
  }

  // The literal string "undefined" is never a legitimate data-layer value: it is
  // what a template writes when the variable it interpolated was never defined.
  // Measured on the 149-URL run: adobeAnalytics.s.eVar119 ships
  // "undefined/<section>/..." on 30 pages (24 ford.mx, 6 ford.com.pr), and
  // digitalData.onclick.contentType is the string "undefined" on 117 of 138 ok
  // pages. The AA case is data already sent, so it is a defect; the DD case is a
  // placeholder that only reaches AA if the tag reads it at click time, hence the
  // lower severity. Neither needs a contract to be proven.
  if (!unavailable && !truncated) {
    const aaUndefined = findUndefinedValues(aa);
    if (aaUndefined.length > 0) {
      items.push(problem('undefined-in-analytics', 'high', 'site', {
        field: aaUndefined[0].path,
        detail: `Adobe Analytics carries the literal "undefined" in ${aaUndefined.length} field(s)`
      }));
    }
    const ddUndefined = findUndefinedValues(dd);
    if (ddUndefined.length > 0) {
      items.push(problem('undefined-placeholder', 'medium', 'site', {
        field: ddUndefined[0].path,
        detail: `digitalData carries the literal "undefined" in ${ddUndefined.length} field(s)`
      }));
    }
  }

  if (truncated) {
    items.push(problem('dd-truncated', 'high', 'tool', {
      detail: 'Entry hit the per-URL storage cap; required fields cannot be trusted'
    }));
  }

  if (dd && typeof dd === 'object' && !Array.isArray(dd) && !truncated && !authWall &&
      !edgeBlocked && !serverError && !pageGone && !requestRejected) {
    requiredFields.forEach((field) => {
      if (isBlank(readPath(dd, field))) {
        items.push(problem('missing-required', 'high', 'site', { field }));
      }
    });

    // Opt-in: this client names pages semantically ("service:home",
    // "ford owners:benefits"), so comparing pageName against the URL slug fires
    // on 75% of healthy pages. Enable it only where pageName mirrors the path.
    if (checkPageName) {
      const pageName = readPath(dd, 'page.pageName');
      const slug = urlSlug(entry.url);
      const normalizedSlug = normalizeToken(slug);
      if (!isBlank(pageName) && normalizedSlug.length >= 4 &&
          GENERIC_SLUGS.indexOf(normalizedSlug) === -1 &&
          normalizeToken(pageName).indexOf(normalizedSlug) === -1) {
        items.push(problem('pageName-mismatch', 'medium', 'site', {
          field: 'page.pageName',
          expected: slug,
          actual: String(pageName)
        }));
      }
    }
  }

  if (!authWall && entry.finalUrl && String(entry.finalUrl) !== String(entry.url)) {
    // The data layer belongs to the final URL; a redirect is not a defect, but
    // the report must not attribute it to the requested URL.
    items.push(problem('redirect', 'low', 'env', {
      expected: String(entry.url),
      actual: String(entry.finalUrl)
    }));
  }

  // Opt-in: measured 154/155 pages "old" while 134/155 still fired AA beacons,
  // which proves a tag manager injects the loader. At 99% the flag is the
  // baseline, not a finding; the card already shows the template chip.
  if (checkTemplate && entry.template === 'old') {
    items.push(problem('template-old', 'low', 'site', {
      detail: 'metrics.<brand>.<locale>.js not found in <script src>; a tag manager may inject it'
    }));
  }

  const locale = entry.metrics_locale;
  const country = expectedCountry(entry.url);
  if (locale && country) {
    const localeTokens = String(locale).toLowerCase().split(/[-_]/);
    if (localeTokens.indexOf(country) === -1) {
      items.push(problem('locale-mismatch', 'medium', 'site', {
        field: 'metrics_locale',
        expected: country,
        actual: String(locale)
      }));
    }
  }

  const dataLayer = aa && aa.dataLayer;
  if (dataLayer && dataLayer.truncatedEvents) {
    items.push(problem('adl-truncated', 'low', 'tool', {
      field: 'adobeAnalytics.dataLayer',
      detail: `Only the first ${maxAdlEvents} events are stored`
    }));
  }

  if (preview && !unverifiedPreview) {
    items.push(problem('preview-env', 'low', 'env', {
      detail: 'Preview host: not comparable with production'
    }));
  }

  return buildVerdict(entry, items);
}

// Items must be entries (or exports) carrying their own `index`. Sorting is the
// caller job: results.js already orders by index, the CLI reads an ordered export.
function diagnoseEntries(items, options) {
  return (items || []).map((entry) => diagnoseEntry(entry, options));
}

function summarizeDiagnosis(diagnoses) {
  const summary = {
    total: 0,
    withProblems: 0,
    bySeverity: { high: 0, medium: 0, low: 0 },
    bySiteSeverity: { high: 0, medium: 0, low: 0 },
    byAttribution: { site: 0, tool: 0, env: 0 },
    byCode: {}
  };
  (diagnoses || []).forEach((diagnosis) => {
    summary.total++;
    if (!diagnosis || !Array.isArray(diagnosis.problems) || !diagnosis.problems.length) return;
    summary.withProblems++;
    if (summary.bySeverity[diagnosis.severity] !== undefined) summary.bySeverity[diagnosis.severity]++;
    if (summary.bySiteSeverity[diagnosis.siteSeverity] !== undefined) summary.bySiteSeverity[diagnosis.siteSeverity]++;
    const seenAttribution = {};
    diagnosis.problems.forEach((item) => {
      summary.byCode[item.code] = (summary.byCode[item.code] || 0) + 1;
      if (!seenAttribution[item.attribution]) {
        seenAttribution[item.attribution] = true;
        if (summary.byAttribution[item.attribution] !== undefined) summary.byAttribution[item.attribution]++;
      }
    });
  });
  return summary;
}

// Determinism check for the rules, not a site check: compares two diagnosis
// exports produced from the same URL list and names every entry whose verdict
// moved. A diff means either the rules changed or the site did, and the index
// tells you which entry to inspect.
function compareDiagnoses(base, candidate) {
  const unwrap = (data) => (data && Array.isArray(data.results) ? data.results : data);
  const left = unwrap(base);
  const right = unwrap(candidate);
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return {
      verdict: 'invalid',
      reason: 'not-an-export',
      compared: 0,
      deltas: null,
      mismatches: [],
      findings: [{ level: 'blocker', message: 'Both sides must be diagnosis exports or arrays of verdicts' }]
    };
  }

  // Identity is the URL, not the index: re-pasting a trimmed list shifts every
  // index after the removed block, and the same page must still compare equal
  // to itself. Index is only used as a fallback for entries without a URL.
  const keyOf = (item) => {
    if (!item) return null;
    if (typeof item.url === 'string' && item.url) return item.url;
    return Number.isInteger(item.index) ? '#' + item.index : null;
  };
  const byKey = (items) => {
    const map = new Map();
    items.forEach((item) => {
      const key = keyOf(item);
      if (key) map.set(key, item);
    });
    return map;
  };
  const before = byKey(left);
  const after = byKey(right);
  const onlyBase = [...before.keys()].filter((key) => !after.has(key));
  const onlyCandidate = [...after.keys()].filter((key) => !before.has(key));
  if (onlyBase.length || onlyCandidate.length) {
    const sample = (list) => list.slice(0, 5).map((key) => key).join(', ') + (list.length > 5 ? ', …' : '');
    return {
      verdict: 'invalid',
      reason: 'different-scope',
      compared: 0,
      deltas: null,
      mismatches: [],
      findings: [{
        level: 'blocker',
        message: `Different URLs: only in base [${sample(onlyBase)}] | only in candidate [${sample(onlyCandidate)}]`
      }]
    };
  }

  const codesOf = (item) => (Array.isArray(item.problems) ? item.problems.map((p) => p.code) : []).sort();
  const mismatches = [];
  let remapped = 0;
  [...before.keys()].forEach((key) => {
    const previous = before.get(key);
    const current = after.get(key);
    if (previous.index !== current.index) remapped++;
    const previousCodes = codesOf(previous);
    const currentCodes = codesOf(current);
    if (previousCodes.join(',') !== currentCodes.join(',') ||
        previous.severity !== current.severity ||
        previous.siteSeverity !== current.siteSeverity) {
      mismatches.push({
        index: current.index,
        baseIndex: previous.index,
        url: current.url || previous.url,
        base: { severity: previous.severity, siteSeverity: previous.siteSeverity, codes: previousCodes },
        candidate: { severity: current.severity, siteSeverity: current.siteSeverity, codes: currentCodes }
      });
    }
  });

  const countCodes = (items) => {
    const counts = {};
    items.forEach((item) => (item.problems || []).forEach((problem) => {
      counts[problem.code] = (counts[problem.code] || 0) + 1;
    }));
    return counts;
  };
  const baseCodes = countCodes(left);
  const candidateCodes = countCodes(right);
  const deltas = {};
  Array.from(new Set(Object.keys(baseCodes).concat(Object.keys(candidateCodes)))).sort().forEach((code) => {
    const delta = (candidateCodes[code] || 0) - (baseCodes[code] || 0);
    if (delta !== 0) deltas[code] = delta;
  });

  const findings = [];
  if (remapped > 0) {
    findings.push({
      level: 'info',
      message: `${remapped} entries matched by URL at a different index (the list layout changed, the pages did not)`
    });
  }
  if (mismatches.length) {
    const sample = mismatches.slice(0, 10).map((item) => '#' + item.index).join(', ');
    findings.push({
      level: 'blocker',
      message: `${mismatches.length} of ${before.size} entries differ: ${sample}${mismatches.length > 10 ? ', …' : ''}`
    });
  }

  return {
    verdict: mismatches.length ? 'differs' : 'identical',
    reason: mismatches.length ? 'verdict-changed' : 'same-verdicts',
    compared: before.size,
    remapped,
    deltas,
    mismatches,
    findings
  };
}

// Contract for the diagnosis export, same envelope discipline as lib/schema.js:
// an importer must fail loudly instead of reading a half-shaped report.
function validateDiagnosisExport(data) {
  const violations = [];
  if (!Array.isArray(data)) return ['export must be an array'];
  let previousIndex = -1;
  data.forEach((item, position) => {
    const at = `item[${position}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      violations.push(`${at}: must be an object`);
      return;
    }
    ['index', 'url', 'finalUrl', 'status', 'severity', 'siteSeverity', 'problems'].forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(item, field)) {
        violations.push(`${at}: missing required field "${field}"`);
      }
    });
    if (!Number.isInteger(item.index) || item.index < 0) {
      violations.push(`${at}.index: must be a non-negative integer`);
    } else if (item.index < previousIndex) {
      violations.push(`${at}.index: out of order`);
    } else {
      previousIndex = item.index;
    }
    if (typeof item.url !== 'string' || !item.url) {
      violations.push(`${at}.url: must be a non-empty string`);
    }
    if (item.finalUrl !== null && typeof item.finalUrl !== 'string') {
      violations.push(`${at}.finalUrl: must be string or null`);
    }
    const severityEnum = ['none'].concat(SEVERITIES);
    if (severityEnum.indexOf(item.severity) === -1) {
      violations.push(`${at}.severity: must be one of ${severityEnum.join(', ')}`);
    }
    if (severityEnum.indexOf(item.siteSeverity) === -1) {
      violations.push(`${at}.siteSeverity: must be one of ${severityEnum.join(', ')}`);
    }
    if (!Array.isArray(item.problems)) {
      violations.push(`${at}.problems: must be an array`);
      return;
    }
    item.problems.forEach((entry, problemPosition) => {
      const where = `${at}.problems[${problemPosition}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        violations.push(`${where}: must be an object`);
        return;
      }
      if (typeof entry.code !== 'string' || !entry.code) {
        violations.push(`${where}.code: must be a non-empty string`);
      }
      if (SEVERITIES.indexOf(entry.severity) === -1) {
        violations.push(`${where}.severity: must be one of ${SEVERITIES.join(', ')}`);
      }
      if (ATTRIBUTIONS.indexOf(entry.attribution) === -1) {
        violations.push(`${where}.attribution: must be one of ${ATTRIBUTIONS.join(', ')}`);
      }
    });
  });
  return violations;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_REQUIRED_FIELDS,
    RULES_VERSION,
    SEVERITIES,
    ATTRIBUTIONS,
    DIAGNOSIS_STATUS,
    readPath,
    urlSlug,
    expectedCountry,
    looksLikeAuthWall,
    diagnoseEntry,
    diagnoseEntries,
    summarizeDiagnosis,
    compareDiagnoses,
    validateDiagnosisExport
  };
}
