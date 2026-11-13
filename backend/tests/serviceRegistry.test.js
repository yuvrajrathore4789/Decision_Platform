'use strict';
// Config-defined dependencies: a new service is a YAML block, not a code change. No database.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('../src/adapters/dependencyAdapter');
const { validateDefinition } = require('../src/utils/workflowValidator');

const write = (text) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'svc-')), 'services.yaml');
  fs.writeFileSync(f, text);
  return f;
};
const original = adapter.loadRegistry();
afterEach(() => adapter.useRegistry(original));

const defUsing = (service) => ({
  workflow: 'w', version: 1, schema: { type: 'object' }, start: 'call',
  stages: { call: { type: 'external_call', service, next: 'ok', on_exhausted: 'no' }, ok: { type: 'terminal', outcome: 'APPROVED' }, no: { type: 'terminal', outcome: 'REJECTED' } },
});

describe('service registry (config/services.yaml)', () => {
  test('the shipped services load', () => {
    expect(adapter.knownServices().sort()).toEqual(['credit_bureau', 'fraud_screening', 'kyc']);
  });

  test('credit bureau output is unchanged by the move to config (deterministic, 300..850)', async () => {
    const a = await adapter.call('credit_bureau', { payload: { applicant_id: 'A-1' } });
    const b = await adapter.call('credit_bureau', { payload: { applicant_id: 'A-1' } });
    expect(a).toEqual(b);
    expect(a.score).toBeGreaterThanOrEqual(300);
    expect(a.score).toBeLessThanOrEqual(850);
    expect((await adapter.call('credit_bureau', { payload: { applicant_id: 'A-1', mock_credit_score: 720 } })).score).toBe(720);
  });

  test('a brand-new service is usable and valid in workflows without touching code', async () => {
    expect(validateDefinition(defUsing('sanctions_check')).join()).toMatch(/unknown service "sanctions_check"/);
    adapter.useRegistry(adapter.loadRegistry(write(`
services:
  sanctions_check:
    kind: static
    response: { listed: false, provider: SIMULATED_SANCTIONS }
    mock_overrides: { mock_listed: listed }
`)));
    expect(validateDefinition(defUsing('sanctions_check'))).toEqual([]);
    expect(await adapter.call('sanctions_check', { payload: {} })).toMatchObject({ listed: false });
    expect(await adapter.call('sanctions_check', { payload: { mock_listed: true } })).toMatchObject({ listed: true });
    expect(adapter.hookFields()).toContain('mock_listed'); // gated by SIMULATION_MODE like every other hook
  });

  test('bad service config fails fast', () => {
    expect(() => adapter.loadRegistry(write('services:\n  x: { kind: telepathy }'))).toThrow(/unknown kind/);
    expect(() => adapter.loadRegistry(write('services:\n  x: { kind: hash_score, id_field: a, output_key: s, min: 5, max: 1 }'))).toThrow(/min\/max/);
    expect(() => adapter.loadRegistry(write('nothing: true'))).toThrow(/services/);
  });

  test('calling an unregistered service is a dependency error', async () => {
    await expect(adapter.call('nope', { payload: {} })).rejects.toThrow(/unknown service/);
  });
});