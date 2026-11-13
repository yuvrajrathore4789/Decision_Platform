'use strict';
const mongoose = require('mongoose');
const Ajv = require('ajv');
const Request = require('../models/Request');
const workflowService = require('./workflow.service');
const idempotency = require('./idempotency.service');
const audit = require('./audit.service');
const engine = require('../engine/workflowEngine');
const env = require('../config/env');
const { STATUS, SIMULATION_HOOK_FIELDS } = require('../utils/constants');
const { sha256 } = require('../utils/hash');
const { badRequest, notFound, conflict, unprocessable } = require('../utils/errors');

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(); // compiled schema cache, keyed by workflow@version

function validatePayload(def, payload) {
  const cacheKey = `${def.workflow}@${def.version}`;
  if (!validators.has(cacheKey)) validators.set(cacheKey, ajv.compile(def.schema));
  const validate = validators.get(cacheKey);
  if (!validate(payload)) {
    throw badRequest('Payload does not match the workflow schema', validate.errors.map((e) => ({
      path: e.instancePath || '/', message: e.message, params: e.params,
    })));
  }
}

/** MongoDB rejects keys starting with "$" or containing "."; refuse them at the door. */
function assertSafeKeys(value, path = '') {
  if (Array.isArray(value)) return value.forEach((v, i) => assertSafeKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.')) throw badRequest(`Illegal field name "${k}" at ${path || '/'}`);
      assertSafeKeys(v, `${path}.${k}`);
    }
  }
}

/** Simulation hooks let a caller fake dependency results, so they are refused unless SIMULATION_MODE is on. */
function assertNoSimulationHooks(payload) {
  if (env.SIMULATION_MODE) return;
  const used = SIMULATION_HOOK_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(payload, f));
  if (used.length) {
    throw badRequest(`Simulation hooks are disabled (SIMULATION_MODE=false): ${used.join(', ')}`, used.map((f) => ({ path: `/${f}`, message: 'not allowed outside simulation mode' })));
  }
}

const isId = (id) => mongoose.isValidObjectId(id);

async function getById(id) {
  if (!isId(id)) throw notFound(`Request ${id} not found`);
  const doc = await Request.findById(id);
  if (!doc) throw notFound(`Request ${id} not found`);
  return doc;
}

async function list({ status, workflow, limit = 20, skip = 0 } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (workflow) filter.workflow = workflow;
  const [items, total] = await Promise.all([
    Request.find(filter, { auditLog: 0, stateHistory: 0 }).sort({ createdAt: -1 }).skip(Number(skip)).limit(Math.min(Number(limit), 100)),
    Request.countDocuments(filter),
  ]);
  return { total, items };
}

/**
 * Intake -> validate -> idempotency -> persist -> run workflow.
 * Returns { request, duplicate }.
 */
async function submit({ workflow, payload, idempotencyKey }) {
  const def = await workflowService.getActive(workflow);
  assertSafeKeys(payload);
  assertNoSimulationHooks(payload);
  validatePayload(def, payload);

  const payloadHash = sha256(payload);
  const explicit = Boolean(idempotencyKey);
  const key = idempotencyKey || `auto:${sha256({ workflow, payload })}`;

  const { record, created } = await idempotency.acquire({ workflow, key, payloadHash, explicit });
  if (!created) {
    if (explicit && record.payloadHash !== payloadHash) {
      throw unprocessable('Idempotency-Key was already used with a different payload');
    }
    const existing = await Request.findById(record.requestId);
    if (existing) return { request: existing, duplicate: true };
    // Key exists but request does not: an earlier attempt died mid-way. Fall through and finish creating it.
  }

  const doc = new Request({
    _id: record.requestId,
    workflow,
    workflowVersion: def.version, // pinned: later rule changes never affect this request
    payload,
    payloadHash,
    idempotencyKey: key,
    status: STATUS.RECEIVED,
    currentStage: def.start,
  });
  audit.add(doc, {
    type: 'REQUEST_RECEIVED', stage: def.start,
    message: `Request accepted for ${workflow} v${def.version}`,
    data: { payloadHash, idempotencyKey: key },
  });
  try {
    await doc.save();
  } catch (err) {
    if (err.code === 11000) { // a concurrent duplicate created it first
      const existing = await Request.findById(record.requestId);
      if (existing) return { request: existing, duplicate: true };
    }
    throw err;
  }
  await engine.run(doc, def);
  return { request: doc, duplicate: false };
}

/** Atomically move a request from one status to IN_PROGRESS. Only one caller can win. */
async function claim(id, fromStatus, reason) {
  return Request.findOneAndUpdate(
    { _id: id, status: fromStatus },
    {
      $set: { status: STATUS.IN_PROGRESS, nextRetryAt: null },
      $push: { stateHistory: { from: fromStatus, to: STATUS.IN_PROGRESS, reason, at: new Date() } },
    },
    { new: true }
  );
}

/** Retry a request that is RETRY_PENDING (manual trigger ignores nextRetryAt). */
async function retry(id) {
  const existing = await getById(id);
  if (existing.status !== STATUS.RETRY_PENDING) {
    throw conflict(`Cannot retry a request in status ${existing.status}; only RETRY_PENDING can be retried`);
  }
  const claimed = await claim(id, STATUS.RETRY_PENDING, 'Retry triggered');
  if (!claimed) throw conflict('Request was already picked up by another retry');
  const def = await workflowService.getVersion(claimed.workflow, claimed.workflowVersion); // pinned version
  await engine.run(claimed, def);
  return claimed;
}

async function review(id, { decision, reviewer, comment }) {
  const existing = await getById(id);
  if (existing.status !== STATUS.MANUAL_REVIEW) {
    throw conflict(`Cannot review a request in status ${existing.status}; only MANUAL_REVIEW can be reviewed`);
  }
  const claimed = await claim(id, STATUS.MANUAL_REVIEW, `Review started by ${reviewer}`);
  if (!claimed) throw conflict('Request was already reviewed');
  const def = await workflowService.getVersion(claimed.workflow, claimed.workflowVersion);
  await engine.review(claimed, def, { decision, reviewer, comment });
  return claimed;
}

/** Called by the retry worker. Returns the number of requests processed. */
async function processDueRetries(limit = 20) {
  const due = await Request.find({ status: STATUS.RETRY_PENDING, nextRetryAt: { $lte: new Date() } }, { _id: 1 }).limit(limit);
  let processed = 0;
  for (const { _id } of due) {
    try { await retry(String(_id)); processed += 1; } catch (e) { if (e.status !== 409) throw e; }
  }
  return processed;
}

/** Resume requests stuck IN_PROGRESS (e.g. process crashed after a partial save). */
async function recoverStuck(limit = 20) {
  const cutoff = new Date(Date.now() - env.STUCK_AFTER_MS);
  let recovered = 0;
  for (let i = 0; i < limit; i += 1) {
    const doc = await Request.findOneAndUpdate(
      { status: STATUS.IN_PROGRESS, updatedAt: { $lt: cutoff } },
      { $push: { auditLog: { at: new Date(), type: 'RECOVERY', message: 'Resumed after being stuck IN_PROGRESS' } } },
      { new: true }
    );
    if (!doc) break;
    const def = await workflowService.getVersion(doc.workflow, doc.workflowVersion);
    await engine.run(doc, def);
    recovered += 1;
  }
  return recovered;
}

module.exports = { submit, getById, list, retry, review, processDueRetries, recoverStuck };