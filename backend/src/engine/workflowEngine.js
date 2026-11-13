'use strict';
/**
 * Workflow engine: a config-driven state machine.
 *
 * It knows NOTHING about loans, vendors or claims. It only knows 4 stage types:
 *   rules          evaluate rules; pass -> stage.next, fail -> the failing rule's on_fail stage
 *   external_call  call a dependency; failure -> RETRY_PENDING (backoff) or on_exhausted after max attempts
 *   manual_review  park the request until a human decides
 *   terminal       final outcome (APPROVED / REJECTED)
 *
 * After EVERY stage the request is saved, so a crash loses at most one step and the
 * request can be resumed from its persisted currentStage (see retryWorker recovery).
 * The engine works on any object with the Request shape + save(), so it is testable without a DB.
 */
const { evaluateRules } = require('./rulesEngine');
const audit = require('../services/audit.service');
const adapter = require('../adapters/dependencyAdapter');
const env = require('../config/env');
const { STATUS, STOP_STATUSES } = require('../utils/constants');
const { AppError } = require('../utils/errors');

const MAX_STEPS = 50; // guard against misconfigured cycles

const touch = (request, path) => { if (typeof request.markModified === 'function') request.markModified(path); };

function transition(request, { status, stage, reason }) {
  request.stateHistory.push({
    from: request.status,
    to: status,
    fromStage: request.currentStage,
    toStage: stage === undefined ? request.currentStage : stage,
    reason,
    at: new Date(),
  });
  request.status = status;
  if (stage !== undefined) request.currentStage = stage;
}

const goto = (request, stage, reason) => transition(request, { status: STATUS.IN_PROGRESS, stage, reason });
const lastReason = (request) => (request.stateHistory[request.stateHistory.length - 1] || {}).reason || '';
const facts = (request) => ({ ...request.payload, ...request.context });

const handlers = {
  async rules({ request, stage, stageId }) {
    const result = evaluateRules(stage.rules, facts(request));
    audit.add(request, {
      type: 'RULES_EVALUATED',
      stage: stageId,
      message: result.passed
        ? `All ${stage.rules.length} rule(s) passed`
        : `Rule ${result.failedRule.id} failed`,
      ruleTrace: result.trace,
      data: { inputs: audit.collectInputs(result.trace), payloadHash: request.payloadHash },
    });
    if (result.passed) return goto(request, stage.next, `Rules in "${stageId}" passed`);
    const failed = result.failedRule;
    const lastTrace = result.trace[result.trace.length - 1];
    return goto(request, failed.on_fail, `Rule ${failed.id}${failed.description ? ` (${failed.description})` : ''} failed: ${lastTrace.reason}`);
  },

  async external_call({ request, stage, stageId }) {
    const attempt = (request.attempts[stageId] || 0) + 1;
    const max = stage.max_attempts || 3;
    try {
      const result = await adapter.call(stage.service, { payload: request.payload, attempt, timeoutMs: stage.timeout_ms });
      request.attempts[stageId] = attempt; touch(request, 'attempts');
      request.context[stageId] = result; touch(request, 'context');
      audit.add(request, {
        type: 'DEPENDENCY_SUCCESS', stage: stageId,
        message: `${stage.service} responded on attempt ${attempt}`,
        data: { service: stage.service, attempt, result },
      });
      return goto(request, stage.next, `${stage.service} succeeded on attempt ${attempt}`);
    } catch (err) {
      request.attempts[stageId] = attempt; touch(request, 'attempts');
      audit.add(request, {
        type: 'DEPENDENCY_FAILURE', stage: stageId,
        message: `${stage.service} failed on attempt ${attempt}/${max}: ${err.message}`,
        data: { service: stage.service, attempt, maxAttempts: max, error: err.message },
      });
      if (attempt >= max) {
        audit.add(request, { type: 'RETRIES_EXHAUSTED', stage: stageId, message: `Gave up on ${stage.service} after ${attempt} attempts` });
        return goto(request, stage.on_exhausted || 'manual_review', `${stage.service} unavailable after ${attempt} attempts`);
      }
      const base = stage.backoff_ms !== undefined ? stage.backoff_ms : env.RETRY_BASE_MS;
      const delay = base * 2 ** (attempt - 1); // exponential backoff
      request.nextRetryAt = new Date(Date.now() + delay);
      return transition(request, {
        status: STATUS.RETRY_PENDING,
        reason: `${stage.service} failed (attempt ${attempt}/${max}); retry scheduled in ${delay}ms`,
      });
    }
  },

  async manual_review({ request, stageId }) {
    audit.add(request, { type: 'MANUAL_REVIEW_REQUIRED', stage: stageId, message: `Needs human review. Reason: ${lastReason(request)}` });
    return transition(request, { status: STATUS.MANUAL_REVIEW, reason: lastReason(request) });
  },

  async terminal({ request, stage, stageId }) {
    const reason = lastReason(request);
    request.decision = { outcome: stage.outcome, reason, stage: stageId, workflowVersion: request.workflowVersion, decidedAt: new Date() };
    audit.add(request, { type: 'DECISION', stage: stageId, message: `Final outcome ${stage.outcome}. ${reason}`, data: { outcome: stage.outcome } });
    return transition(request, { status: STATUS[stage.outcome], reason });
  },
};

/** Run stages until the request reaches a stopping status. */
async function run(request, definition) {
  if (request.status === STATUS.RECEIVED) {
    transition(request, { status: STATUS.IN_PROGRESS, stage: definition.start, reason: 'Processing started' });
    audit.add(request, { type: 'PROCESSING_STARTED', stage: definition.start, message: `Started workflow ${definition.workflow} v${definition.version}` });
    await request.save();
  }
  let steps = 0;
  while (!STOP_STATUSES.includes(request.status)) {
    if (++steps > MAX_STEPS) throw new AppError(500, 'WORKFLOW_LOOP', `Exceeded ${MAX_STEPS} steps; check workflow for cycles`);
    const stageId = request.currentStage;
    const stage = definition.stages[stageId];
    if (!stage) throw new AppError(500, 'UNKNOWN_STAGE', `Stage "${stageId}" is not in ${definition.workflow} v${definition.version}`);
    await handlers[stage.type]({ request, stage, stageId });
    await request.save(); // persist state + history + audit atomically (single document)
  }
  return request;
}

/** Apply a human decision to a request that has already been claimed (status IN_PROGRESS at a manual_review stage). */
async function review(request, definition, { decision, reviewer, comment }) {
  const current = definition.stages[request.currentStage];
  if (!current || current.type !== 'manual_review') {
    throw new AppError(409, 'CONFLICT', 'Request is not waiting at a manual_review stage');
  }
  const outcome = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  const target = Object.entries(definition.stages).find(([, s]) => s.type === 'terminal' && s.outcome === outcome);
  if (!target) throw new AppError(422, 'UNPROCESSABLE', `Workflow has no terminal stage for ${outcome}`);
  audit.add(request, {
    type: 'MANUAL_REVIEW_DECISION', stage: request.currentStage,
    message: `${reviewer} chose to ${decision}${comment ? `: ${comment}` : ''}`,
    data: { reviewer, decision, comment: comment || null },
  });
  goto(request, target[0], `Manual review by ${reviewer}: ${decision}${comment ? ` (${comment})` : ''}`);
  await request.save();
  return run(request, definition);
}

module.exports = { run, review, transition };
