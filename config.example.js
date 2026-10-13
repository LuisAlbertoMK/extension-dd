// Copy this file to config.local.js (untracked, gitignored) and fill in real values.
// config.local.js is loaded by background.js via importScripts; without it the
// Ford AEM bypass stays disabled and everything else works normally.
globalThis.FORD_CONFIG = {
  edgeValue: 'PUT-REAL-X-AEM-EDGE-KEY-HERE',
  cookieValue: 'true'
};
