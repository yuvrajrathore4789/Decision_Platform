'use strict';
const mongoose = require('mongoose');

/**
 * The unique index on (workflow, key) is what makes duplicate handling race-safe:
 * whoever inserts first wins, everybody else gets E11000 and reads the winner's record.
 * requestId is pre-generated so a crash between "claim key" and "create request" is recoverable.
 */
const schema = new mongoose.Schema(
  {
    workflow: { type: String, required: true },
    key: { type: String, required: true },
    payloadHash: { type: String, required: true },
    requestId: { type: mongoose.Schema.Types.ObjectId, required: true },
    explicit: { type: Boolean, default: false }, // true when client supplied Idempotency-Key
  },
  { timestamps: true }
);
schema.index({ workflow: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyKey', schema);
