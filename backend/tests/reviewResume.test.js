'use strict';
// manual_review on_approve / on_reject: approval resumes the workflow so later rules still run. No database.
process.env.NODE_ENV = 'test';
process.env.RETRY_BASE_MS = '0';
const engine = require('../src/engine/workflowEngine');
const { validateDefinition } = require('../src/utils/workflowValidator');

const def = {
  workflow: 'demo', version: 1, schema: { type: 'object' }, start: 'dep',
  stages: {
    dep: { type: 'external_call', service: 'kyc', max_attempts: 1, next: 'rules_a', on_exhausted: 'review' },
    rules_a: { type: 'rules', rules: [{ id: 'A1', description: 'a', field: 'a', op: 'eq', value: true, on_fail: 'no' }], next: 'rules_b' },
    rules_b: { type: 'rules', rules: [{ id: 'B1', description: 'amount under 100', expr: 'amount < 100', on_fail: 'no' }], next: 'yes' },
    review: { type: 'manual_review', on_approve: 'rules_b', on_reject: 'no' },
    yes: { type: 'terminal', outcome: 'APPROVED' },
    no: { type: 'terminal', outcome: 'REJECTED' },
  },
};
const make = (payload) => ({
  workflow: 'demo', workflowVersion: 1, payload, payloadHash: 'h', status: 'RECEIVED', currentStage: 'dep',
  context: {}, attempts: {}, decision: null, stateHistory: [], auditLog: [], save: async () => {},
});
const down = { simulate_failure: { service: 'kyc', fail_times: 5 } };
const claim = (r) => { r.status = 'IN_PROGRESS'; return r; }; // what request.service does before engine.review

describe('manual_review resume stages', () => {
  test('definition is valid', () => expect(validateDefinition(def)).toEqual([]));

  test('on_approve to an unknown stage is rejected', () => {
    const bad = JSON.parse(JSON.stringify(def));
    bad.stages.review.on_approve = 'nowhere';
    expect(validateDefinition(bad).join()).toMatch(/on_approve references unknown stage "nowhere"/);
  });

  test('approve resumes at on_approve: the later rule still runs and can still reject', async () => {
    const r = await engine.run(make({ a: true, amount: 500, ...down }), def);
    expect(r.status).toBe('MANUAL_REVIEW');
    const done = await engine.review(claim(r), def, { decision: 'approve', reviewer: 'maya' });
    expect(done.status).toBe('REJECTED'); // B1 ran after the human approval: 500 is not < 100
    expect(done.decision.reason).toMatch(/Rule B1/);
    expect(done.auditLog.find((e) => e.type === 'MANUAL_REVIEW_DECISION').data.resumeAt).toBe('rules_b');
  });

  test('approve resumes at on_approve and approves when the remaining rules pass', async () => {
    const r = await engine.run(make({ a: true, amount: 50, ...down }), def);
    const done = await engine.review(claim(r), def, { decision: 'approve', reviewer: 'maya' });
    expect(done.status).toBe('APPROVED');
    const evaluated = done.auditLog.filter((e) => e.type === 'RULES_EVALUATED').map((e) => e.stage);
    expect(evaluated).toEqual(['rules_b']); // A1 skipped (the human vouched for it), B1 enforced
  });

  test('reject follows on_reject', async () => {
    const r = await engine.run(make({ a: true, amount: 50, ...down }), def);
    expect((await engine.review(claim(r), def, { decision: 'reject', reviewer: 'sam' })).status).toBe('REJECTED');
  });

  test('without on_approve / on_reject the old behaviour holds: straight to a terminal stage', async () => {
    const plain = JSON.parse(JSON.stringify(def));
    plain.stages.review = { type: 'manual_review' };
    expect(validateDefinition(plain)).toEqual([]);
    const r = await engine.run(make({ a: true, amount: 500, ...down }), plain);
    expect((await engine.review(claim(r), plain, { decision: 'approve', reviewer: 'maya' })).status).toBe('APPROVED');
  });

  test('a resume stage that loops back before the review is caught as a cycle', () => {
    const loop = JSON.parse(JSON.stringify(def));
    loop.stages.review.on_approve = 'dep';
    expect(validateDefinition(loop).join()).toMatch(/cycle/);
  });
});