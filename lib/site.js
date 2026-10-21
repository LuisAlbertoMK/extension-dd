// Pure helpers for site-mode discovery: sitemap parsing and template marker
// classification. No browser APIs here so both the worker and node can use them.

// The real marker is the loader /metrics.ford.<locale>.js (or lincoln).
// The Adobe beacon (smetrics.ford.com/b/ss/...) contains "metrics.ford." but is
// NOT the marker, so the match is anchored on the script path and the .js suffix.
const METRICS_SCRIPT_RE = /((?:\/[\w.-]+)*\/metrics\.(ford|lincoln)\.([\w-]+)\.js)(\?|$)/i;

function parseSitemapLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match;
  while ((match = re.exec(String(xml || ''))) !== null) {
    out.push(match[1].replace(/&amp;/g, '&'));
  }
  return out;
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml || ''));
}

// `scriptSrcs` is the list of <script src> on the page, `fmcBlocks` the number of
// FMC.context occurrences found in inline scripts. The metrics loader is the
// definitive marker; FMC.context is reported as corroboration but never promotes
// a page to "new" on its own (it is present on some legacy pages too).
function classifyTemplate(scriptSrcs, fmcBlocks) {
  const files = [];
  let locale = null;
  (scriptSrcs || []).forEach((src) => {
    const found = metricsPath(src);
    if (!found) return;
    files.push(found.path);
    if (!locale) locale = found.locale;
  });
  const unique = [...new Set(files)].sort();
  return {
    template: unique.length ? 'new' : 'old',
    metrics_files: unique,
    metrics_locale: locale,
    has_fmc_context: Number(fmcBlocks) > 0
  };
}

// Returns the loader's path (locale included) or null. The host is dropped on
// purpose: the same loader is served from regional mirrors.
function metricsPath(src) {
  const text = String(src || '');
  const match = METRICS_SCRIPT_RE.exec(text);
  if (!match) return null;
  let path = match[1];
  try {
    const parsed = new URL(text, 'https://placeholder.invalid');
    if (parsed.pathname) path = parsed.pathname;
  } catch (e) { /* keep the raw match */ }
  return { path, locale: match[3].toLowerCase() };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { METRICS_SCRIPT_RE, parseSitemapLocs, isSitemapIndex, classifyTemplate };
}
