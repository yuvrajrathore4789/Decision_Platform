'use strict';
const { validateDefinition } = require('../src/utils/workflowValidator');

const base = () => ({
  workflow: 'g', version: 1, schema: { type: 'object' }, start: 'a',
  stages: {
    a: { type: 'rules', rules: [{ id: 'r', field: 'x', op: 'exists', on_fail: 'no' }], next: 'yes' },
    yes: { type: 'terminal', outcome: 'APPROVED' },
    no: { type: 'terminal', outcome: 'REJECTED' },
  },
});

describe('config-time graph validation', () => {
  test('a clean graph is valid', () => expect(validateDefinition(base())).toEqual([]));

  test('detects a cycle', () => {
    const d = base();
    d.stages.b = { type: 'rules', rules: [{ id: 'r2', field: 'x', op: 'exists', on_fail: 'no' }], next: 'a' };
    d.stages.a.next = 'b'; // a -> b -> a
    expect(validateDefinition(d).join(' | ')).toMatch(/cycle: a -> b -> a/);
  });

  test('detects a self loop', () => {
    const d = base();
    d.stages.a.next = 'a';
    expect(validateDefinition(d).join(' | ')).toMatch(/cycle: a -> a/);
  });

  test('detects unreachable stages', () => {
    const d = base();
    d.stages.orphan = { type: 'terminal', outcome: 'APPROVED' };
    expect(validateDefinition(d).join(' | ')).toMatch(/"orphan" is unreachable/);
  });

  test('retry is not a cycle: external_call with on_exhausted is valid', () => {
    const d = base();
    d.stages.a = { type: 'external_call', service: 'kyc', max_attempts: 3, next: 'yes', on_exhausted: 'human' };
    d.stages.human = { type: 'manual_review' };
    expect(validateDefinition(d)).toEqual([]);
  });

  test('manual_review needs both terminal outcomes', () => {
    const d = base();
    d.stages.a = { type: 'external_call', service: 'kyc', next: 'yes', on_exhausted: 'human' };
    d.stages.human = { type: 'manual_review' };
    delete d.stages.no;
    expect(validateDefinition(d).join(' | ')).toMatch(/APPROVED and a REJECTED/);
  });
});