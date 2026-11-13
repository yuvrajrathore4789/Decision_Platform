'use strict';
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: num(process.env.PORT, 3000),
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/decision_platform',
  // Retry / dependency behaviour
  RETRY_BASE_MS: num(process.env.RETRY_BASE_MS, 2000),
  DEPENDENCY_TIMEOUT_MS: num(process.env.DEPENDENCY_TIMEOUT_MS, 3000),
  DEPENDENCY_FAIL_MODE: process.env.DEPENDENCY_FAIL_MODE || 'none', // none | always
  // Test hooks (mock_* / simulate_failure in the payload). On by default except in production.
  SIMULATION_MODE: process.env.SIMULATION_MODE !== undefined
    ? process.env.SIMULATION_MODE === 'true'
    : (process.env.NODE_ENV || 'development') !== 'production',
  // Background worker
  ENABLE_RETRY_WORKER: (process.env.ENABLE_RETRY_WORKER || 'true') === 'true',
  WORKER_INTERVAL_MS: num(process.env.WORKER_INTERVAL_MS, 5000),
  STUCK_AFTER_MS: num(process.env.STUCK_AFTER_MS, 60000),
  RECOVERY_LOCK_MS: num(process.env.RECOVERY_LOCK_MS, 60000),
};