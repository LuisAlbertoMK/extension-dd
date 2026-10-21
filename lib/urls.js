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

// Matches preview/staging/author hosts. Extend with team-specific patterns as needed.
const PREVIEW_PATTERN = /preview|author[-.]|stage|dev[-.]|test[-.]|localhost|127\.0\.0\.1|\.corp|aem.*preview|hlx.*preview/i;

function isPreviewUrl(url) {
  try {
    const u = new URL(url);
    return PREVIEW_PATTERN.test(u.hostname) || PREVIEW_PATTERN.test(u.href);
  } catch (e) {
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseUrls, isPreviewUrl, PREVIEW_PATTERN };
}
