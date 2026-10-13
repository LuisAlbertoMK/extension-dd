// Pure quota helpers shared by background.js and the test suite (no browser APIs here).
// Cap a single result entry so one huge payload cannot exhaust the storage quota.
// Adobe data is trimmed first (it is supplementary); digitalData is trimmed last.
function capEntry(entry, maxBytes) {
  function size() {
    try {
      return JSON.stringify({ d: entry.digitalData, a: entry.adobeAnalytics }).length;
    } catch (e) {
      return 0;
    }
  }
  if (entry.adobeAnalytics && entry.adobeAnalytics.dataLayer && entry.adobeAnalytics.dataLayer.events &&
      size() > maxBytes) {
    const dl = entry.adobeAnalytics.dataLayer;
    entry.adobeAnalytics.dataLayer = {
      totalEvents: dl.totalEvents,
      events: dl.events.slice(0, 10),
      truncatedEvents: true
    };
    entry.truncated = true;
  }
  if (entry.adobeAnalytics && size() > maxBytes) {
    entry.adobeAnalytics = { truncated: true, reason: 'Dropped to fit storage quota' };
    entry.truncated = true;
  }
  let serialized = '';
  try {
    serialized = JSON.stringify(entry.digitalData);
  } catch (e) {
    serialized = '';
  }
  if (serialized && size() > maxBytes) {
    entry.digitalData = serialized.slice(0, maxBytes);
    entry.truncated = true;
  }
  return entry;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { capEntry };
}
