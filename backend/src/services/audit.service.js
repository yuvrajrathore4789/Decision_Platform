'use strict';
/**
 * Audit helpers. Pure functions (no DB access) so the engine can be unit-tested without Mongo.
 * Every engine step appends one entry: what happened, which rules fired, and which data was used.
 */

function add(request, { type, stage, message, ruleTrace, data }) {
  const entry = { at: new Date(), type, stage, message };
  if (ruleTrace) entry.ruleTrace = ruleTrace;
  if (data) entry.data = data;
  request.auditLog.push(entry);
  return entry;
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
  };
}

module.exports = { add, collectInputs, flattenTrace, explain };
