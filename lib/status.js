// Pure helpers that turn a tab load outcome into an honest per-URL status.
// Shared by background.js and the test suite (no browser APIs here).

const LOAD_TIMEOUT_MESSAGE = 'Timeout waiting for page load';
const TAB_CLOSED_MESSAGE = 'Tab closed before the page could be read';

// Chrome renders network failures (DNS, TLS, connection refused, blocked) on an
// internal error page. Its URL is the only signal tabs.get exposes for it:
// chrome-error://chromewebdata/ or about:neterror?... depending on the platform.
function isErrorPageUrl(url) {
  return typeof url === 'string' && /^(chrome-error:|edge-error:|about:neterror)/.test(url);
}

// A page that never finished loading and exposed no data layer is a load
// failure, not a page without digitalData. Reporting it as "no-data" blamed the
// site for something the audit never managed to read.
function noDataResult(loadOutcome) {
  if (loadOutcome === 'timeout') return { status: 'error', error: LOAD_TIMEOUT_MESSAGE };
  if (loadOutcome === 'gone') return { status: 'error', error: TAB_CLOSED_MESSAGE };
  return { status: 'no-data', error: null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LOAD_TIMEOUT_MESSAGE, TAB_CLOSED_MESSAGE, isErrorPageUrl, noDataResult };
}
