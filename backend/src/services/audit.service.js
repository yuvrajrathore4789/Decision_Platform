'use strict';
/**
 * Audit helpers. Pure functions (no DB access) so the engine can be unit-tested without Mongo.
 * Every engine step appends one entry: what happened, which rules fired, and which data was used.
 *
 * Tamper evidence: each entry stores `prevHash` (the hash of the entry before it) and its own `hash`
 * (SHA-256 over the entry's content + prevHash). Editing, removing or re-ordering any entry in the
 * middle of the log breaks the chain, and verifyChain() reports where.
 */
const { sha256 } = require('../utils/hash');

const GENESIS = '0'.repeat(64);

/** JSON round-trip: drops undefined, turns Dates into ISO strings. What we hash is exactly what MongoDB will store. */
const clean = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Databases may drop empty objects ({}) when saving (Mongoose "minimize"). Ignore them when hashing so the same entry
 * hashes the same before and after a round-trip through storage.
 */
function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val);
      if (!(p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0)) out[k] = p;
    }
    return out;
  }
  return v;
}

function entryHash(e, prevHash) {
  return sha256({
    at: new Date(e.at).toISOString(),
    type: e.type,
    stage: e.stage === undefined ? null : e.stage,
    message: e.message === undefined ? null : e.message,
    ruleTrace: e.ruleTrace === undefined ? null : prune(e.ruleTrace),
    data: e.data === undefined ? null : prune(e.data),
    prevHash,
  });
}

function add(request, { type, stage, message, ruleTrace, data }) {
  const entry = { at: new Date(), type, stage, message };
  if (ruleTrace) entry.ruleTrace = clean(ruleTrace);
  if (data) entry.data = clean(data);
  const last = request.auditLog[request.auditLog.length - 1];
  entry.prevHash = last && last.hash ? last.hash : GENESIS;
  entry.hash = entryHash(entry, entry.prevHash);
  request.auditLog.push(entry);
  return entry;
}

/** Re-computes the chain. Entries written before hashing existed (no `hash`) are skipped and counted as legacy. */
function verifyChain(auditLog = []) {
  let prev = GENESIS;
  let checked = 0;
  let legacy = 0;
  for (let i = 0; i < auditLog.length; i += 1) {
    const raw = auditLog[i];
    const e = typeof raw.toObject === 'function' ? raw.toObject() : raw;
    if (!e.hash) { legacy += 1; continue; }
    if (e.prevHash !== prev || entryHash(e, e.prevHash) !== e.hash) {
      return { valid: false, entries: auditLog.length, checked, legacy, brokenAtSeq: i + 1, headHash: null };
    }
    prev = e.hash;
    checked += 1;
  }
  return { valid: true, entries: auditLog.length, checked, legacy, brokenAtSeq: null, headHash: checked ? prev : null };
}

/** Collect the concrete input values a rule trace looked at (the "data reference"). */
function collectInputs(trace = []) {
  const inputs = {};
  const walk = (t) => {
    if (t.field !== undefined) inputs[t.field] = t.actual;
    if (t.inputs) Object.assign(inputs, t.inputs);
    (t.children || []).forEach(walk);
  };
  trace.forEach(walk);
  return inputs;
}

const flattenTrace = (trace = []) => trace.map((t) => ({
  ruleId: t.ruleId,
  description: t.description,
  passed: t.passed,
  reason: t.reason,
}));

/** Human-readable explanation of how a request reached its current state. */
function explain(request) {
  const decision = request.decision;
  const steps = request.auditLog.map((e, i) => ({
    seq: i + 1,
    at: e.at,
    type: e.type,
    stage: e.stage,
    message: e.message,
    ...(e.ruleTrace ? { rules: flattenTrace(e.ruleTrace) } : {}),
    ...(e.data ? { data: e.data } : {}),
    ...(e.hash ? { hash: e.hash } : {}),
  }));
  const summary = decision
    ? `Request ${request.status} under ${request.workflow} v${request.workflowVersion}. ${decision.reason}`
    : `Request is ${request.status} at stage "${request.currentStage}" under ${request.workflow} v${request.workflowVersion}.`;
  return {
    requestId: String(request._id),
    workflow: request.workflow,
    workflowVersion: request.workflowVersion,
    status: request.status,
    decision,
    summary,
    steps,
    stateHistory: request.stateHistory,
    dataReference: { payloadHash: request.payloadHash, payload: request.payload, context: request.context },
    integrity: verifyChain(request.auditLog),
  };
}

module.exports = { add, collectInputs, flattenTrace, explain, verifyChain, GENESIS };