'use strict';
const mongoose = require('mongoose');
const { STATUS } = require('../utils/constants');

const stateHistorySchema = new mongoose.Schema(
  {
    from: String,
    to: String,
    fromStage: String,
    toStage: String,
    reason: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const auditSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, required: true }, // RULES_EVALUATED, DEPENDENCY_FAILURE, DECISION, ...
    stage: String,
    message: String,
    ruleTrace: { type: mongoose.Schema.Types.Mixed },
    data: { type: mongoose.Schema.Types.Mixed },
    prevHash: String, // hash chain: tamper evidence (see audit.service)
    hash: String,
  },
  { _id: false, minimize: false }
);

/**
 * One document per request. State, history and audit live together so that every step
 * is persisted with a single atomic document write (consistency without multi-doc transactions).
 * Trade-off: unbounded arrays; at scale the audit log moves to its own collection.
 */
const schema = new mongoose.Schema(
  {
    workflow: { type: String, required: true, index: true },
    workflowVersion: { type: Number, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    payloadHash: { type: String, required: true },
    idempotencyKey: String,
    status: { type: String, enum: Object.values(STATUS), default: STATUS.RECEIVED, index: true },
    currentStage: String,
    context: { type: mongoose.Schema.Types.Mixed, default: {} }, // outputs of external stages
    attempts: { type: mongoose.Schema.Types.Mixed, default: {} }, // { stageId: count }
    nextRetryAt: Date,
    lockedUntil: Date, // recovery lease: a worker owns this request until then
    decision: { type: mongoose.Schema.Types.Mixed, default: null },
    stateHistory: { type: [stateHistorySchema], default: [] },
    auditLog: { type: [auditSchema], default: [] },
  },
  { timestamps: true, minimize: false }
);
schema.index({ status: 1, nextRetryAt: 1 });

module.exports = mongoose.model('Request', schema);