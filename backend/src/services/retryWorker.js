'use strict';
const requestService = require('./request.service');
const env = require('../config/env');
const logger = require('../utils/logger');

let timer = null;
let running = false;

/** One polling pass: run due retries, then resume stuck requests. Exported for tests. */
async function tick() {
  if (running) return 0; // never overlap passes
  running = true;
  try {
    const retried = await requestService.processDueRetries();
    const recovered = await requestService.recoverStuck();
    if (retried || recovered) logger.info(`Retry worker: retried=${retried} recovered=${recovered}`);
    return retried + recovered;
  } catch (err) {
    logger.error('Retry worker error', err.message);
    return 0;
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, env.WORKER_INTERVAL_MS);
  if (timer.unref) timer.unref();
  logger.info(`Retry worker started (every ${env.WORKER_INTERVAL_MS}ms)`);
}
const stop = () => { clearInterval(timer); timer = null; };

module.exports = { start, stop, tick };
