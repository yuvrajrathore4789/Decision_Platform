'use strict';
// Pure unit tests: the engine runs on a plain object, so no database is involved.
process.env.NODE_ENV = 'test';
process.env.RETRY_BASE_MS = '0';
const engine = require('../src/engine/workflowEngine');

const def = {
  workflow: 'demo', version: 1, start: 'check',
  stages: {
    check: { type: 'rules', rules: [{ id: 'A', field: 'x', op: 'gt', value: 1, on_fail: 'no' }], next: 'dep' },
    dep: { type: 'external_call', service: 'kyc', max_attempts: 2, backoff_ms: 10, next: 'yes', on_exhausted: 'human' },
    yes: { type: 'terminal', outcome: 'APPROVED' },
    no: { type: 'terminal', outcome: 'REJECTED' },
    human: { type: 'manual_review' },
  },
};
const make = (payload, over = {}) => ({
  workflow: 'demo', workflowVersion: 1, payload, payloadHash: 'h', status: 'RECEIVED', currentStage: 'check',
  context: {}, attempts: {}, decision: null, stateHistory: [], auditLog: [], save: async () => {}, ...over,
});

test('approves when rules pass and the dependency answers', async () => {
  const r = await engine.run(make({ x: 5 }), def);
  expect(r.status).toBe('APPROVED');
  expect(r.context.dep).toMatchObject({ verified: true });
});

test('failing rule follows its on_fail edge', async () => {
  const r = await engine.run(make({ x: 0 }), def);
  expect(r.status).toBe('REJECTED');
  expect(r.decision.reason).toMatch(/Rule A/);
});

test('dependency failure schedules a backoff retry, then exhausts to manual review', async () => {
  const r = make({ x: 5, simulate_failure: { service: 'kyc', fail_times: 5 } });
  await engine.run(r, def);
  expect(r.status).toBe('RETRY_PENDING');
  expect(r.nextRetryAt).toBeInstanceOf(Date);
  r.status = 'IN_PROGRESS';
  await engine.run(r, def);
  expect(r.status).toBe('MANUAL_REVIEW');
  expect(r.attempts.dep).toBe(2);
});

test('misconfigured cycle is stopped by the step guard', async () => {
  const loop = { workflow: 'loop', version: 1, start: 'a', stages: { a: { type: 'rules', rules: [{ id: 'T', field: 'x', op: 'exists', on_fail: 'a' }], next: 'a' } } };
  await expect(engine.run(make({ x: 1 }, { currentStage: 'a' }), loop)).rejects.toThrow(/Exceeded/);
});

test('every state transition is recorded in history', async () => {
  const r = await engine.run(make({ x: 5 }), def);
  expect(r.stateHistory[0]).toMatchObject({ from: 'RECEIVED', to: 'IN_PROGRESS' });
  expect(r.stateHistory[r.stateHistory.length - 1].to).toBe('APPROVED');
});
