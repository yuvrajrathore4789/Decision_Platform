'use strict';
// Unit tests for the `branch` stage (conditional branching). The engine runs on a plain object: no database.
process.env.NODE_ENV = 'test';
process.env.RETRY_BASE_MS = '0';
const engine = require('../src/engine/workflowEngine');
const { validateDefinition } = require('../src/utils/workflowValidator');

const def = {
  workflow: 'demo', version: 1, schema: { type: 'object' }, start: 'route',
  stages: {
    route: {
      type: 'branch',
      branches: [
        { id: 'B1', description: 'big amount', expr: 'amount > 100', next: 'no' },
        { id: 'B2', description: 'vip customer', field: 'tier', op: 'eq', value: 'vip', next: 'human' },
      ],
      default: 'yes',
    },
    yes: { type: 'terminal', outcome: 'APPROVED' },
    no: { type: 'terminal', outcome: 'REJECTED' },
    human: { type: 'manual_review' },
  },
};
const make = (payload) => ({
  workflow: 'demo', workflowVersion: 1, payload, payloadHash: 'h', status: 'RECEIVED', currentStage: 'route',
  context: {}, attempts: {}, decision: null, stateHistory: [], auditLog: [], save: async () => {},
});

describe('branch stage', () => {
  test('definition is valid', () => expect(validateDefinition(def)).toEqual([]));

  test('first matching branch wins and is traced', async () => {
    const r = await engine.run(make({ amount: 500, tier: 'vip' }), def); // B1 and B2 both match; B1 is first
    expect(r.status).toBe('REJECTED');
    const entry = r.auditLog.find((e) => e.type === 'BRANCH_TAKEN');
    expect(entry.data).toMatchObject({ matched: 'B1', next: 'no' });
    expect(entry.ruleTrace).toHaveLength(1); // evaluation stopped at the first match
    expect(entry.data.inputs).toMatchObject({ amount: 500 });
    expect(r.decision.reason).toMatch(/Branch B1/);
  });

  test('a later branch is taken when earlier ones do not match', async () => {
    const r = await engine.run(make({ amount: 5, tier: 'vip' }), def);
    expect(r.status).toBe('MANUAL_REVIEW');
    const entry = r.auditLog.find((e) => e.type === 'BRANCH_TAKEN');
    expect(entry.ruleTrace.map((t) => t.passed)).toEqual([false, true]);
  });

  test('default route is used when nothing matches', async () => {
    const r = await engine.run(make({ amount: 5, tier: 'basic' }), def);
    expect(r.status).toBe('APPROVED');
    const entry = r.auditLog.find((e) => e.type === 'BRANCH_TAKEN');
    expect(entry.data).toMatchObject({ matched: null, next: 'yes' });
    expect(r.decision.reason).toMatch(/No branch matched/);
  });

  test('a branch condition that cannot be evaluated does not match (visible in the trace)', async () => {
    const r = await engine.run(make({ tier: 'basic' }), def); // amount missing -> "undefined > 100" is false, never a crash
    expect(r.status).toBe('APPROVED');
    const broken = { ...def, stages: { ...def.stages, route: { ...def.stages.route, branches: [{ id: 'X', expr: 'a.b.c(', next: 'no' }] } } };
    const e = validateDefinition(broken).join(' | ');
    expect(e).toMatch(/Unexpected|Missing/); // bad expressions are caught at config time
  });

  test('validator requires branches, valid targets and a default', () => {
    const bad = (stage) => validateDefinition({ ...def, stages: { ...def.stages, route: stage } }).join(' | ');
    expect(bad({ type: 'branch', branches: [], default: 'yes' })).toMatch(/branches\[\] required/);
    expect(bad({ type: 'branch', branches: [{ id: 'B', expr: 'a > 1', next: 'ghost' }], default: 'yes' })).toMatch(/ghost/);
    expect(bad({ type: 'branch', branches: [{ id: 'B', expr: 'a > 1', next: 'no' }] })).toMatch(/default/);
  });
});