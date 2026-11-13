const { evaluateRule, evaluateRules, validateRule } = require('../src/engine/rulesEngine');

describe('rulesEngine', () => {
  const data = { age: 25, income: 50000, loan_amount: 200000, country: 'IN', credit_check: { score: 700 } };

  test('structured comparison passes and fails with trace', () => {
    expect(evaluateRule({ id: 'R1', field: 'age', op: 'gte', value: 18 }, data).passed).toBe(true);
    const r = evaluateRule({ id: 'R1', field: 'age', op: 'gte', value: 30 }, data);
    expect(r.passed).toBe(false);
    expect(r.actual).toBe(25);
  });

  test('expression with arithmetic and nested path', () => {
    expect(evaluateRule({ id: 'R3', expr: 'loan_amount <= income * 5' }, data).passed).toBe(true);
    expect(evaluateRule({ id: 'R3', expr: 'loan_amount <= income * 3' }, data).passed).toBe(false);
    expect(evaluateRule({ id: 'R4', expr: 'credit_check.score >= 650' }, data).passed).toBe(true);
  });

  test('in operator and composite rules', () => {
    expect(evaluateRule({ id: 'V1', field: 'country', op: 'in', value: ['IN', 'US'] }, data).passed).toBe(true);
    const any = { id: 'A', any: [{ id: 'a', field: 'age', op: 'lt', value: 18 }, { id: 'b', field: 'age', op: 'gt', value: 21 }] };
    expect(evaluateRule(any, data).passed).toBe(true);
  });

  test('missing field fails safely', () => {
    expect(evaluateRule({ id: 'X', field: 'nope', op: 'gt', value: 1 }, data).passed).toBe(false);
  });

  test('no code execution via expressions', () => {
    expect(() => validateRule({ id: 'E', expr: 'process.exit(1)' })).toThrow();
    expect(() => validateRule({ id: 'E', expr: 'a; b' })).toThrow();
  });

  test('evaluateRules stops at first failure', () => {
    const res = evaluateRules([
      { id: 'a', field: 'age', op: 'gte', value: 99 },
      { id: 'b', field: 'age', op: 'gte', value: 1 },
    ], data);
    expect(res.passed).toBe(false);
    expect(res.trace).toHaveLength(1);
  });
});
