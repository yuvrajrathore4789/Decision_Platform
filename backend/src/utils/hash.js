'use strict';
const crypto = require('crypto');

/** JSON.stringify with sorted keys so equal objects always hash equally. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');

module.exports = { canonical, sha256 };
