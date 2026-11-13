'use strict';
/**
 * Simulated external dependencies (credit bureau, KYC provider) with failure injection.
 *
 * Failure injection, per request (deterministic, great for tests/demos), via payload:
 *   "simulate_failure": { "service": "credit_bureau", "fail_times": 2, "mode": "error" | "timeout" }
 * -> the first `fail_times` attempts fail; later attempts succeed.
 * Global switch: DEPENDENCY_FAIL_MODE=always makes every call fail.
 * All payload hooks (simulate_failure, mock_*) are honoured ONLY when env.SIMULATION_MODE is true.
 */
const crypto = require('crypto');
const env = require('../config/env');
const { DependencyError } = require('../utils/errors');

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

const SERVICES = {
  async credit_bureau({ payload }) {
    const score = env.SIMULATION_MODE && payload.mock_credit_score !== undefined
      ? Number(payload.mock_credit_score)
      : 300 + (parseInt(crypto.createHash('sha256').update(String(payload.applicant_id)).digest('hex').slice(0, 6), 16) % 551);
    return { score, bureau: 'SIMULATED_BUREAU' };
  },
  async kyc({ payload }) {
    return { verified: !(env.SIMULATION_MODE && payload.mock_kyc_verified === false), riskLevel: 'LOW', provider: 'SIMULATED_KYC' };
  },
  async fraud_screening({ payload }) {
    const riskScore = env.SIMULATION_MODE && payload.mock_fraud_score !== undefined
      ? Number(payload.mock_fraud_score)
      : parseInt(crypto.createHash('sha256').update(String(payload.claim_id)).digest('hex').slice(0, 6), 16) % 100;
    return { risk_score: riskScore, provider: 'SIMULATED_FRAUD_ENGINE' };
  },
};

const KNOWN_SERVICES = Object.keys(SERVICES);

async function call(service, { payload, attempt = 1, timeoutMs } = {}) {
  const handler = SERVICES[service];
  if (!handler) throw new DependencyError(service, 'unknown service');
  const limit = timeoutMs || env.DEPENDENCY_TIMEOUT_MS;
  return withTimeout((async () => {
    await maybeFail(service, payload, attempt, limit);
    return handler({ payload, attempt });
  })(), limit, service);
}

module.exports = { call, KNOWN_SERVICES };