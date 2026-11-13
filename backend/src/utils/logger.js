'use strict';
const silent = process.env.NODE_ENV === 'test';
const log = (level) => (...args) => { if (!silent) console[level === 'error' ? 'error' : 'log'](`[${level}]`, ...args); };
module.exports = { info: log('info'), warn: log('warn'), error: log('error') };
