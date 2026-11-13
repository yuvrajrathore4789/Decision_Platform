'use strict';

const STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  RETRY_PENDING: 'RETRY_PENDING',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

// Statuses where the engine stops and waits for something external
const STOP_STATUSES = [STATUS.RETRY_PENDING, STATUS.MANUAL_REVIEW, STATUS.APPROVED, STATUS.REJECTED];
const FINAL_STATUSES = [STATUS.APPROVED, STATUS.REJECTED];

const STAGE_TYPES = Object.freeze(['rules', 'external_call', 'branch', 'manual_review', 'terminal']);

// Payload fields that only exist to drive the simulated dependencies. Accepted only when SIMULATION_MODE is on.
const SIMULATION_HOOK_FIELDS = Object.freeze(['mock_credit_score', 'mock_kyc_verified', 'mock_fraud_score', 'simulate_failure']);

module.exports = { STATUS, STOP_STATUSES, FINAL_STATUSES, STAGE_TYPES, SIMULATION_HOOK_FIELDS };