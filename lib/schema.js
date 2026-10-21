// Export contract shared with downstream importers (e.g. MYCO pipeline step 5).
// validateExport returns an array of human-readable violations; empty means valid.
// No dependencies so both node and the browser can use it.
const EXPORT_STATUS = ['ok', 'no-data', 'error', 'pending'];

const EXPORT_SCHEMA = {
  type: 'array',
  items: {
    required: ['index', 'url', 'finalUrl', 'status', 'truncated', 'digitalData', 'adobeAnalytics', 'error'],
    types: {
      index: 'nonNegativeInteger',
      url: 'nonEmptyString',
      finalUrl: ['string', 'null'],
      status: 'statusEnum',
      truncated: 'boolean',
      digitalData: ['object', 'string', 'null'],
      adobeAnalytics: ['object', 'null'],
      error: ['string', 'null']
    }
  }
};

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validateExport(data) {
  const violations = [];
  if (!Array.isArray(data)) return ['export must be an array'];
  let prevIndex = -1;
  data.forEach((item, pos) => {
    const at = `item[${pos}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      violations.push(`${at}: must be an object`);
      return;
    }
    EXPORT_SCHEMA.items.required.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(item, field)) {
        violations.push(`${at}: missing required field "${field}"`);
      }
    });
    if (!Number.isInteger(item.index) || item.index < 0) {
      violations.push(`${at}.index: must be a non-negative integer`);
    } else if (item.index < prevIndex) {
      violations.push(`${at}.index: out of order (export must preserve submission order)`);
    } else {
      prevIndex = item.index;
    }
    if (typeof item.url !== 'string' || !item.url) {
      violations.push(`${at}.url: must be a non-empty string`);
    }
    const finalKind = kindOf(item.finalUrl);
    if (finalKind !== 'string' && finalKind !== 'null') {
      violations.push(`${at}.finalUrl: must be string or null`);
    }
    if (!EXPORT_STATUS.includes(item.status)) {
      violations.push(`${at}.status: must be one of ${EXPORT_STATUS.join(', ')}`);
    }
    if (typeof item.truncated !== 'boolean') {
      violations.push(`${at}.truncated: must be a boolean`);
    }
    const ddKind = kindOf(item.digitalData);
    if (ddKind !== 'object' && ddKind !== 'string' && ddKind !== 'null') {
      violations.push(`${at}.digitalData: must be object, string (truncated) or null`);
    }
    const aaKind = kindOf(item.adobeAnalytics);
    if (aaKind !== 'object' && aaKind !== 'null') {
      violations.push(`${at}.adobeAnalytics: must be object or null`);
    }
    const errKind = kindOf(item.error);
    if (errKind !== 'string' && errKind !== 'null') {
      violations.push(`${at}.error: must be string or null`);
    }
  });
  return violations;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EXPORT_STATUS, EXPORT_SCHEMA, validateExport, validateDDExport, validateAAExport };
}

// Split-view contracts: same envelope rules as the combined export, but each
// view carries only its own payload so independent agents cannot misread it.
function validateViewExport(data, payloadField, payloadKinds) {
  const violations = [];
  if (!Array.isArray(data)) return ['export must be an array'];
  let prevIndex = -1;
  data.forEach((item, pos) => {
    const at = `item[${pos}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      violations.push(`${at}: must be an object`);
      return;
    }
    ['index', 'url', 'finalUrl', 'status', payloadField, 'error'].forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(item, field)) {
        violations.push(`${at}: missing required field "${field}"`);
      }
    });
    if (!Number.isInteger(item.index) || item.index < 0) {
      violations.push(`${at}.index: must be a non-negative integer`);
    } else if (item.index < prevIndex) {
      violations.push(`${at}.index: out of order (export must preserve submission order)`);
    } else {
      prevIndex = item.index;
    }
    if (typeof item.url !== 'string' || !item.url) {
      violations.push(`${at}.url: must be a non-empty string`);
    }
    if (!EXPORT_STATUS.includes(item.status)) {
      violations.push(`${at}.status: must be one of ${EXPORT_STATUS.join(', ')}`);
    }
    const viewFinalKind = kindOf(item.finalUrl);
    if (viewFinalKind !== 'string' && viewFinalKind !== 'null') {
      violations.push(`${at}.finalUrl: must be string or null`);
    }
    if (!payloadKinds.includes(kindOf(item[payloadField]))) {
      violations.push(`${at}.${payloadField}: must be one of ${payloadKinds.join(', ')}`);
    }
    const errKind = kindOf(item.error);
    if (errKind !== 'string' && errKind !== 'null') {
      violations.push(`${at}.error: must be string or null`);
    }
  });
  return violations;
}

function validateDDExport(data) {
  return validateViewExport(data, 'digitalData', ['object', 'string', 'null']);
}

function validateAAExport(data) {
  return validateViewExport(data, 'adobeAnalytics', ['object', 'null']);
}
