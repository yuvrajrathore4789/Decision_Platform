'use strict';
const mongoose = require('mongoose');
const IdempotencyKey = require('../models/IdempotencyKey');

/**
 * Claim an idempotency key. The unique index decides the winner, so this is safe under concurrency.
 * The winner's requestId is generated up-front: if the process dies before the request is saved,
 * the next duplicate finds the key without a request and completes the creation (self-healing).
 */
async function acquire({ workflow, key, payloadHash, explicit }) {
  const requestId = new mongoose.Types.ObjectId();
  try {
    const record = await IdempotencyKey.create({ workflow, key, payloadHash, requestId, explicit });
    return { record, created: true };
  } catch (err) {
    if (err.code !== 11000) throw err;
    const record = await IdempotencyKey.findOne({ workflow, key });
    return { record, created: false };
  }
}

module.exports = { acquire };
