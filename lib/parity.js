// Compares two DD-view exports of the same URL list (e.g. baseline branch vs
// perf branch) and reports whether the extracted data layers are identical.
// Pure, no dependencies.
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') {
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => {
    let v;
    try {
      v = JSON.stringify(k) + ':' + canonical(value[k]);
    } catch (e) {
      v = JSON.stringify(k) + ':"<unserializable>"';
    }
    return v;
  });
  return `{${parts.join(',')}}`;
}

function diffDDExports(base, other) {
  const result = { total: 0, matched: 0, changed: [], onlyInBase: [], onlyInOther: [] };
  const byIndex = (arr) => {
    const map = new Map();
    (arr || []).forEach((item) => {
      if (item && Number.isInteger(item.index)) map.set(item.index, item);
    });
    return map;
  };
  const a = byIndex(base);
  const b = byIndex(other);
  const all = new Set([...a.keys(), ...b.keys()]);
  result.total = all.size;
  all.forEach((idx) => {
    const x = a.get(idx);
    const y = b.get(idx);
    if (!x) {
      result.onlyInOther.push({ index: idx, url: y.url || null });
      return;
    }
    if (!y) {
      result.onlyInBase.push({ index: idx, url: x.url || null });
      return;
    }
    if (x.status !== y.status) {
      result.changed.push({ index: idx, url: x.url, kind: 'status', base: x.status, other: y.status });
      return;
    }
    if (canonical(x.digitalData) !== canonical(y.digitalData)) {
      result.changed.push({ index: idx, url: x.url, kind: 'payload', base: x.status, other: y.status });
      return;
    }
    result.matched++;
  });
  return result;
}

function parityOk(diff) {
  return diff.changed.length === 0 && diff.onlyInBase.length === 0 && diff.onlyInOther.length === 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { canonical, diffDDExports, parityOk };
}
