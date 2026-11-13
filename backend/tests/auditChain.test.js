'use strict';
// Audit hash chain: pure unit tests, no database.
process.env.NODE_ENV = 'test';
process.env.RETRY_BASE_MS = '0';
const engine = require('../src/engine/workflowEngine');
const audit = require('../src/services/audit.service');

const def = {
  workflow: 'demo', version: 1, schema: { type: 'object' }, start: 'check',
  stages: {
    check: { type: 'rules', rules: [{ id: 'R1', description: 'x positive', field: 'x', op: 'gt', value: 0, on_fail: 'no' }], next: 'yes' },
    yes: { type: 'terminal', outcome: 'APPROVED' },
    no: { type: 'terminal', outcome: 'REJECTED' },
  },
};
const make = (payload) => ({
  workflow: 'demo', workflowVersion: 1, payload, payloadHash: 'h', status: 'RECEIVED', currentStage: 'check',
  context: {}, attempts: {}, decision: null, stateHistory: [], auditLog: [], save: async () => {},
});
const run = (payload) => engine.run(make(payload), def);
const copyLog = (r) => JSON.parse(JSON.stringify(r.auditLog)); // what a client / the database would hand back

describe('audit hash chain', () => {
  test('every entry is linked to the previous one', async () => {
    const r = await run({ x: 5 });
    expect(r.auditLog.length).toBeGreaterThan(2);
    expect(r.auditLog[0].prevHash).toBe(audit.GENESIS);
    r.auditLog.slice(1).forEach((e, i) => expect(e.prevHash).toBe(r.auditLog[i].hash));
    const result = audit.verifyChain(copyLog(r)); // survives a JSON round-trip, like a database read
    expect(result).toMatchObject({ valid: true, brokenAtSeq: null });
    expect(result.headHash).toBe(r.auditLog[r.auditLog.length - 1].hash);
  });

  test('editing an entry is detected, and the first broken entry is reported', async () => {
    const log = copyLog(await run({ x: 5 }));
    log[1].message = 'Rules failed'; // tamper
    expect(audit.verifyChain(log)).toMatchObject({ valid: false, brokenAtSeq: 2 });
  });

  test('editing recorded rule data is detected', async () => {
    const log = copyLog(await run({ x: 5 }));
    const i = log.findIndex((e) => e.type === 'RULES_EVALUATED');
    log[i].ruleTrace[0].passed = false;
    expect(audit.verifyChain(log).valid).toBe(false);
  });

  test('removing or re-ordering entries is detected', async () => {
    const r = await run({ x: 5 });
    const removed = copyLog(r); removed.splice(1, 1);
    expect(audit.verifyChain(removed).valid).toBe(false);
    const swapped = copyLog(r); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(audit.verifyChain(swapped).valid).toBe(false);
  });

  test('entries written before hashing existed are counted as legacy, not as tampering', async () => {
    const log = copyLog(await run({ x: 5 }));
    const legacy = [{ at: new Date().toISOString(), type: 'OLD', message: 'pre-chain entry' }, ...log];
    expect(audit.verifyChain(legacy)).toMatchObject({ valid: true, legacy: 1 });
  });

  test('empty objects dropped by storage do not cause false tamper alarms', () => {
    const req = { auditLog: [] };
    audit.add(req, { type: 'X', stage: 's', message: 'm', data: { inputs: {}, kept: 1 } });
    const stored = JSON.parse(JSON.stringify(req.auditLog));
    delete stored[0].data.inputs; // what a minimizing database may do
    expect(audit.verifyChain(stored).valid).toBe(true);
  });

  test('explain() carries the integrity verdict', async () => {
    const r = await run({ x: -1 });
    r._id = 'abc';
    expect(audit.explain(r).integrity.valid).toBe(true);
  });
});