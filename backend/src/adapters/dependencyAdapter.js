'use strict';
/**
 * Simulated external dependencies (credit bureau, KYC provider, fraud engine) with failure injection.
 * Which services exist is CONFIG (config/services.yaml), not code: see loadRegistry().
 *
 * Failure injection, per request (deterministic, great for tests/demos), via payload:
 *   "simulate_failure": { "service": "credit_bureau", "fail_times": 2, "mode": "error" | "timeout" }
 * -> the first `fail_times` attempts fail; later attempts succeed.
 * Global switch: DEPENDENCY_FAIL_MODE=always makes every call fail.
 * All payload hooks (simulate_failure, mock_*) are honoured ONLY when env.SIMULATION_MODE is true.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const env = require('../config/env');
const { DependencyError } = require('../utils/errors');

const SERVICES_FILE = path.join(__dirname, '..', '..', 'config', 'services.yaml');

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

function withTimeout(promise, ms, service) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DependencyError(service, `timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function maybeFail(service, payload, attempt, timeoutMs) {
  if (env.DEPENDENCY_FAIL_MODE === 'always') throw new DependencyError(service, '503 Service Unavailable (global fail mode)');
  const sim = env.SIMULATION_MODE && payload ? payload.simulate_failure : undefined;
  if (sim && sim.service === service && attempt <= Number(sim.fail_times || 0)) {
    if (sim.mode === 'timeout') await sleep(timeoutMs + 5000); // outlives the timeout wrapper
    throw new DependencyError(service, `503 Service Unavailable (injected failure, attempt ${attempt})`);
  }
}

/** Service "kinds": each turns one config block into a handler. Add a kind here only for genuinely new behaviour. */
const KINDS = {
  hash_score(name, cfg) {
    for (const k of ['id_field', 'output_key']) if (!cfg[k]) throw new Error(`service "${name}": ${k} is required for kind hash_score`);
    if (!Number.isInteger(cfg.min) || !Number.isInteger(cfg.max) || cfg.max < cfg.min) throw new Error(`service "${name}": min/max must be integers with max >= min`);
    const span = cfg.max - cfg.min + 1;
    return async ({ payload }) => {
      const mocked = env.SIMULATION_MODE && cfg.mock_field && payload[cfg.mock_field] !== undefined;
      const value = mocked
        ? Number(payload[cfg.mock_field])
        : cfg.min + (parseInt(crypto.createHash('sha256').update(String(payload[cfg.id_field])).digest('hex').slice(0, 6), 16) % span);
      return { ...(cfg.response || {}), [cfg.output_key]: value };
    };
  },
  static(name, cfg) {
    if (!cfg.response || typeof cfg.response !== 'object') throw new Error(`service "${name}": response is required for kind static`);
    return async ({ payload }) => {
      const out = { ...cfg.response };
      if (env.SIMULATION_MODE) {
        for (const [field, key] of Object.entries(cfg.mock_overrides || {})) if (payload[field] !== undefined) out[key] = payload[field];
      }
      return out;
    };
  },
};

/** Parse + validate a services file. Returns { handlers, hookFields }. Throws on a bad definition (fail fast at startup). */
function loadRegistry(file = SERVICES_FILE) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const defs = doc.services;
  if (!defs || typeof defs !== 'object' || !Object.keys(defs).length) throw new Error(`${file}: "services" block is required`);
  const handlers = {};
  const hookFields = new Set();
  for (const [name, cfg] of Object.entries(defs)) {
    if (!cfg || !KINDS[cfg.kind]) throw new Error(`service "${name}": unknown kind "${cfg && cfg.kind}" (known: ${Object.keys(KINDS).join(', ')})`);
    handlers[name] = KINDS[cfg.kind](name, cfg);
    if (cfg.mock_field) hookFields.add(cfg.mock_field);
    Object.keys(cfg.mock_overrides || {}).forEach((f) => hookFields.add(f));
  }
  return { handlers, hookFields: [...hookFields] };
}

let registry = loadRegistry();

/** Swap the active registry (used by tests and by a future "reload services" endpoint). */
function useRegistry(next) { registry = next; }

const isKnownService = (name) => Object.prototype.hasOwnProperty.call(registry.handlers, name);
const knownServices = () => Object.keys(registry.handlers);
/** Payload fields that only exist to fake dependency results (refused when SIMULATION_MODE is off). */
const hookFields = () => [...registry.hookFields];

async function call(service, { payload, attempt = 1, timeoutMs } = {}) {
  if (!isKnownService(service)) throw new DependencyError(service, 'unknown service');
  const handler = registry.handlers[service];
  const limit = timeoutMs || env.DEPENDENCY_TIMEOUT_MS;
  return withTimeout((async () => {
    await maybeFail(service, payload, attempt, limit);
    return handler({ payload, attempt });
  })(), limit, service);
}

module.exports = { call, isKnownService, knownServices, hookFields, loadRegistry, useRegistry };