// Pure formatting helpers (no browser APIs here).
function formatElapsed(start, end) {
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return '—';
  const s = (end - start) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(0)}s`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatElapsed };
}
