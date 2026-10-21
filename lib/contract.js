// Contract derived from observed captures, not written by hand.
//
// A per-URL contract does not scale: the sibling project kept one CSV per URL
// (12 rows for a single page, 13 files for 13 pages) and it could not be applied
// to a 149-URL run because only one of its URLs was in the sample. What does
// scale is the opposite: group the pages that share a `page.siteSection`, and
// derive per group what is invariant, what follows a prefix, and what is simply
// template variance that must never be reported as a defect.
const PATTERN_FIELDS = new Set(['pageName', 'pageNameNoVehicle', 'hierarchy']);
const UNGROUPED = '(sin grupo)';

function pageOf(entry) {
  const page = entry && entry.digitalData && entry.digitalData.page;
  return page && typeof page === 'object' && !Array.isArray(page) ? page : null;
}

function groupValue(page, by) {
  const raw = page[by.replace(/^page\./, '')];
  const value = raw == null ? '' : String(raw).trim();
  return value === '' ? UNGROUPED : value;
}

// Longest common prefix, cut back to a token boundary so `promotions:x` and
// `promotions:y` yield `promotions:` and not `promotions:` minus a character.
function commonPrefix(values) {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === '') return '';
  }
  const boundary = Math.max(prefix.lastIndexOf(':'), prefix.lastIndexOf('/'));
  if (boundary >= 0 && boundary < prefix.length - 1) return prefix.slice(0, boundary + 1);
  return prefix;
}

function classifyField(values, groupSize, minCoverage) {
  const nonEmpty = values.filter((item) => item.present && item.text !== '').map((item) => item.text);
  // Coverage counts values actually carried, not keys merely present: a field
  // that is an empty string on a third of the group is not a contract, it is a
  // template variant, and turning it into a literal would blame those pages.
  const coverage = groupSize === 0 ? 0 : nonEmpty.length / groupSize;
  const distinct = [...new Set(nonEmpty)];
  if (coverage < minCoverage || distinct.length === 0) {
    return { kind: 'variance', coverage: round(coverage), distinct: distinct.length };
  }
  if (distinct.length === 1) {
    return { kind: 'literal', value: distinct[0], coverage: round(coverage) };
  }
  return { kind: 'variance', coverage: round(coverage), distinct: distinct.length };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function buildContract(entries, options) {
  const opts = Object.assign({ by: 'page.siteSection', minSample: 3, minCoverage: 0.95 }, options || {});
  const by = opts.by.replace(/^page\./, '');
  const skipped = [];
  const buckets = new Map();

  for (const entry of entries || []) {
    const page = entry && entry.status === 'ok' ? pageOf(entry) : null;
    if (!page) {
      skipped.push(entry && entry.index);
      continue;
    }
    const key = groupValue(page, by);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(page);
  }

  const groups = {};
  const dropped = [];
  for (const [key, pages] of buckets) {
    if (pages.length < opts.minSample) {
      dropped.push({ group: key, sample: pages.length, reason: `menos de ${opts.minSample} páginas` });
      continue;
    }
    const fields = {};
    const names = new Set();
    for (const page of pages) for (const name of Object.keys(page)) names.add(name);
    for (const name of names) {
      const values = pages.map((page) => {
        const present = Object.prototype.hasOwnProperty.call(page, name);
        const raw = present ? page[name] : null;
        return { present, text: raw == null ? '' : String(raw).trim() };
      });
      const spec = classifyField(values, pages.length, opts.minCoverage);
      // A pattern rule is still a contract: it must obey the same coverage floor,
      // otherwise the 20% of pages that omit the field get blamed for not
      // following a rule derived from the 80% that carry it.
      if (spec.kind === 'variance' && PATTERN_FIELDS.has(name) && spec.coverage >= opts.minCoverage) {
        const distinct = values.filter((item) => item.present && item.text !== '').map((item) => item.text);
        const prefix = commonPrefix([...new Set(distinct)]);
        if (prefix !== '') {
          fields[name] = { kind: 'prefix', prefix, coverage: spec.coverage };
          continue;
        }
      }
      if (spec.kind !== 'variance') fields[name] = spec;
    }
    groups[key] = { sample: pages.length, fields };
  }

  return {
    kind: 'digitaldata-contract',
    version: 1,
    generatedAt: new Date().toISOString(),
    basis: { by: `page.${by}`, minSample: opts.minSample, minCoverage: opts.minCoverage },
    groups,
    dropped,
    skippedEntries: skipped.length
  };
}

function checkEntry(entry, contract, group) {
  const page = pageOf(entry);
  if (!page || !contract || !contract.groups) return [];
  const key = group || groupValue(page, contract.basis.by.replace(/^page\./, ''));
  const spec = contract.groups[key];
  if (!spec) return [];
  const findings = [];
  for (const [field, rule] of Object.entries(spec.fields)) {
    const present = Object.prototype.hasOwnProperty.call(page, field);
    const raw = present ? page[field] : null;
    const text = raw == null ? '' : String(raw).trim();
    if (!present || text === '') {
      findings.push({ code: 'contract-missing', field, expected: rule.value || rule.prefix || null, actual: present ? text : null });
      continue;
    }
    if (rule.kind === 'literal' && text !== rule.value) {
      findings.push({ code: 'contract-value', field, expected: rule.value, actual: text });
    } else if (rule.kind === 'prefix' && text.indexOf(rule.prefix) !== 0) {
      findings.push({ code: 'contract-prefix', field, expected: rule.prefix, actual: text });
    }
  }
  return findings;
}

function checkExport(entries, contract) {
  const results = [];
  const ungrouped = [];
  for (const entry of entries || []) {
    const page = pageOf(entry);
    if (!page) continue;
    const key = groupValue(page, contract.basis.by.replace(/^page\./, ''));
    if (!contract.groups[key]) {
      ungrouped.push(entry.index);
      continue;
    }
    const problems = checkEntry(entry, contract, key);
    if (problems.length > 0) results.push({ index: entry.index, url: entry.url, group: key, problems });
  }
  return { checked: results.length, ungrouped, results };
}

module.exports = { buildContract, checkEntry, checkExport, commonPrefix, UNGROUPED };
