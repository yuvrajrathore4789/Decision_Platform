'use strict';

/** Compact API view of a request (no audit log; fetch that from /audit). */
function toSummary(doc) {
  const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(o._id),
    workflow: o.workflow,
    workflowVersion: o.workflowVersion,
    status: o.status,
    currentStage: o.currentStage,
    decision: o.decision,
    attempts: o.attempts,
    nextRetryAt: o.nextRetryAt || null,
    payload: o.payload,
    context: o.context,
    idempotencyKey: o.idempotencyKey,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

module.exports = { toSummary };
