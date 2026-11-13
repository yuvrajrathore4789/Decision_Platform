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

const STAGE_TYPES = Object.freeze(['rules', 'external_call', 'manual_review', 'terminal']);

module.exports = { STATUS, STOP_STATUSES, FINAL_STATUSES, STAGE_TYPES };
