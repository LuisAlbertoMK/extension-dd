// Pure URL helpers shared by the popup and the test suite (no browser APIs here).
function parseUrls(raw) {
  const seen = new Set();
  const urls = [];
  String(raw).split('\n').forEach((line) => {
    const s = line.trim();
    if (!s) return;
    // Reject an explicit non-http(s) scheme instead of force-prefixing it.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return;
    const candidate = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (e) {
      return; // ignore malformed URLs
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    const normalized = parsed.href;
    if (seen.has(normalized)) return; // dedupe
    seen.add(normalized);
    urls.push(normalized);
  });
  return urls;
}

// Assets are never audited: a crawler that follows them wastes a tab per file.
const ASSET_EXTENSION_RE = /\.(?:pdf|zip|docx?|xlsx?|pptx?|csv|png|jpe?g|gif|svg|webp|ico|css|js|json|xml|mp4|webm|mp3|woff2?|ttf|eot)$/i;

// Stable dedupe key for the crawl queue: lowercase host, no fragment, no
// trailing slash, query preserved (some pages differ only by query).
function normalizeQueueUrl(raw, base) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''), base || undefined);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (ASSET_EXTENSION_RE.test(parsed.pathname)) return null;
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.protocol + '//' + parsed.hostname.toLowerCase() + path + parsed.search;
}

function hostOf(raw) {
  try {
    return new URL(String(raw || '')).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

// Matches preview/staging/author hosts. Extend with team-specific patterns as needed.
const PREVIEW_PATTERN = /preview|author[-.]|brandauthor|stage|dev[-.]|test[-.]|localhost|127\.0\.0\.1|\.corp|aem.*preview|hlx.*preview/i;

function isPreviewUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (e) {
    return false;
  }
  // Match the host only. Real production paths contain words like "test-drive"
  // or "contest", and matching the whole URL turned /overlay/request-a-test-drive-home/
  // into a preview host (measured: 1/155 false positive on a real run).
  if (PREVIEW_PATTERN.test(parsed.hostname)) return true;
  // AEM editor sessions expose the author-tier editor on any host.
  return /(^|[?&])wcmmode=/i.test(parsed.search);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseUrls,
    isPreviewUrl,
    normalizeQueueUrl,
    hostOf,
    ASSET_EXTENSION_RE,
    PREVIEW_PATTERN
  };
}
