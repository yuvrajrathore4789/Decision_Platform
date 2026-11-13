'use strict';
const helpers = require('./helpers');
const request = require('supertest');
const app = require('../src/app');
const Request = require('../src/models/Request');
const retryWorker = require('../src/services/retryWorker');

beforeAll(helpers.connect);
afterAll(helpers.disconnect);
beforeEach(helpers.reset);

const goodLoan = (over = {}) => ({
  applicant_id: 'A-1', income: 60000, loan_amount: 150000, age: 30, mock_credit_score: 720, ...over,
});
const submit = (payload, { key, workflow = 'loan_approval' } = {}) => {
  const r = request(app).post('/api/requests');
  if (key) r.set('Idempotency-Key', key);
  return r.send({ workflow, payload });
};

describe('1. Happy path', () => {
  test('approves a valid loan and records a full audit trail', async () => {
    const res = await submit(goodLoan());
    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe('APPROVED');
    expect(res.body.request.workflowVersion).toBe(1);

    const audit = await request(app).get(`/api/requests/${res.body.request.id}/audit`);
    const types = audit.body.auditLog.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['REQUEST_RECEIVED', 'RULES_EVALUATED', 'DEPENDENCY_SUCCESS', 'DECISION']));
    const rules = audit.body.auditLog.find((e) => e.type === 'RULES_EVALUATED');
    expect(rules.ruleTrace[0]).toMatchObject({ ruleId: 'R1', passed: true, actual: 30 });
  });

  test('explanation endpoint gives rule-level reasoning', async () => {
    const res = await submit(goodLoan({ age: 15 }));
    const ex = await request(app).get(`/api/requests/${res.body.request.id}/explanation`);
    expect(res.body.request.status).toBe('REJECTED');
    expect(ex.body.summary).toMatch(/R1/);
    expect(ex.body.steps.find((s) => s.rules).rules[0]).toMatchObject({ ruleId: 'R1', passed: false });
  });

  test('threshold failure routes to manual review, then a human approves', async () => {
    const res = await submit(goodLoan({ loan_amount: 900000 }));
    expect(res.body.request.status).toBe('MANUAL_REVIEW');
    const id = res.body.request.id;
    const reviewed = await request(app).post(`/api/requests/${id}/review`).send({ decision: 'approve', reviewer: 'maya', comment: 'collateral ok' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe('APPROVED');
    const again = await request(app).post(`/api/requests/${id}/review`).send({ decision: 'reject', reviewer: 'sam' });
    expect(again.status).toBe(409); // cannot review twice
  });

  test('a second workflow runs on the same engine with no code changes', async () => {
    const res = await submit({ vendor_id: 'V-1', country: 'IN', years_in_business: 5, annual_revenue: 500000 }, { workflow: 'vendor_approval' });
    expect(res.body.request.status).toBe('APPROVED');
    const bad = await submit({ vendor_id: 'V-2', country: 'IN', years_in_business: 5, annual_revenue: 500000, mock_kyc_verified: false }, { workflow: 'vendor_approval' });
    expect(bad.body.request.status).toBe('REJECTED');
  });
});

describe('2. Invalid input', () => {
  test('missing required field -> 400 with details, nothing stored', async () => {
    const res = await submit({ applicant_id: 'A-1', income: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
    expect(await Request.countDocuments()).toBe(0);
  });
  test('wrong type -> 400', async () => {
    expect((await submit(goodLoan({ income: 'lots' }))).status).toBe(400);
  });
  test('unknown workflow -> 404', async () => {
    expect((await submit(goodLoan(), { workflow: 'nope' })).status).toBe(404);
  });
  test('malformed envelope -> 400', async () => {
    const res = await request(app).post('/api/requests').send({ payload: {} });
    expect(res.status).toBe(400);
  });
  test('illegal Mongo keys in payload -> 400', async () => {
    const res = await submit(goodLoan({ 'a.b': 1 }));
    expect(res.status).toBe(400);
  });
});

describe('3. Duplicate requests / idempotency', () => {
  test('same Idempotency-Key returns the original result, one record', async () => {
    const a = await submit(goodLoan(), { key: 'abc-1' });
    const b = await submit(goodLoan(), { key: 'abc-1' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.request.id).toBe(a.body.request.id);
    expect(await Request.countDocuments()).toBe(1);
  });
  test('same payload without a key is detected by payload hash', async () => {
    const a = await submit(goodLoan());
    const b = await submit(goodLoan());
    expect(b.body.duplicate).toBe(true);
    expect(b.body.request.id).toBe(a.body.request.id);
  });
  test('key reused with a different payload -> 422', async () => {
    await submit(goodLoan(), { key: 'k' });
    expect((await submit(goodLoan({ income: 1 }), { key: 'k' })).status).toBe(422);
  });
  test('concurrent duplicates create exactly one request', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(goodLoan({ applicant_id: 'RACE' }), { key: 'race-1' })));
    expect(new Set(results.map((r) => r.body.request.id)).size).toBe(1);
    expect(await Request.countDocuments()).toBe(1);
  });
  test('recovers when the key was claimed but the request was never saved (partial failure)', async () => {
    const IdempotencyKey = require('../src/models/IdempotencyKey');
    const mongoose = require('mongoose');
    const { sha256 } = require('../src/utils/hash');
    const payload = goodLoan({ applicant_id: 'ORPHAN' });
    const orphanId = new mongoose.Types.ObjectId();
    await IdempotencyKey.create({ workflow: 'loan_approval', key: 'orphan', payloadHash: sha256(payload), requestId: orphanId, explicit: true });
    const res = await submit(payload, { key: 'orphan' });
    expect(res.status).toBe(201);
    expect(res.body.request.id).toBe(String(orphanId));
    expect(res.body.request.status).toBe('APPROVED');
  });
});

describe('4. Dependency failure', () => {
  const failing = (n) => goodLoan({ simulate_failure: { service: 'credit_bureau', fail_times: n } });

  test('first failure parks the request as RETRY_PENDING with an attempt count', async () => {
    const res = await submit(failing(1));
    expect(res.body.request.status).toBe('RETRY_PENDING');
    expect(res.body.request.attempts.credit_check).toBe(1);
    expect(res.body.request.nextRetryAt).toBeTruthy();
  });
  test('timeouts are treated as dependency failures', async () => {
    const res = await submit(goodLoan({ simulate_failure: { service: 'credit_bureau', fail_times: 1, mode: 'timeout' } }));
    expect(res.body.request.status).toBe('RETRY_PENDING');
    const audit = await request(app).get(`/api/requests/${res.body.request.id}/audit`);
    expect(JSON.stringify(audit.body.auditLog)).toMatch(/timed out/);
  });
  test('retries exhausted -> MANUAL_REVIEW', async () => {
    let res = await submit(failing(10));
    const id = res.body.request.id;
    await request(app).post(`/api/requests/${id}/retry`);
    res = await request(app).post(`/api/requests/${id}/retry`);
    expect(res.body.status).toBe('MANUAL_REVIEW');
    expect(res.body.attempts.credit_check).toBe(3);
    const audit = await request(app).get(`/api/requests/${id}/audit`);
    expect(audit.body.auditLog.map((e) => e.type)).toContain('RETRIES_EXHAUSTED');
  });
});

describe('5. Retry flow', () => {
  test('manual retry after a transient failure succeeds and approves', async () => {
    const created = await submit(goodLoan({ simulate_failure: { service: 'credit_bureau', fail_times: 1 } }));
    const id = created.body.request.id;
    const res = await request(app).post(`/api/requests/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.attempts.credit_check).toBe(2);
  });
  test('retrying a request that is not RETRY_PENDING -> 409', async () => {
    const created = await submit(goodLoan());
    expect((await request(app).post(`/api/requests/${created.body.request.id}/retry`)).status).toBe(409);
  });
  test('concurrent retries: only one wins', async () => {
    const created = await submit(goodLoan({ simulate_failure: { service: 'credit_bureau', fail_times: 1 } }));
    const id = created.body.request.id;
    const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/requests/${id}/retry`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const doc = await Request.findById(id);
    expect(doc.attempts.credit_check).toBe(2); // dependency called once on retry, not three times
  });
  test('background worker retries requests whose backoff has elapsed', async () => {
    const created = await submit(goodLoan({ simulate_failure: { service: 'credit_bureau', fail_times: 1 } }));
    const id = created.body.request.id;
    await Request.updateOne({ _id: id }, { nextRetryAt: new Date(Date.now() - 1000) });
    await retryWorker.tick();
    expect((await request(app).get(`/api/requests/${id}`)).body.status).toBe('APPROVED');
  });
  test('worker resumes a request stuck IN_PROGRESS (crash recovery)', async () => {
    const created = await submit(goodLoan());
    const id = created.body.request.id;
    await Request.updateOne({ _id: id }, { status: 'IN_PROGRESS', currentStage: 'threshold_checks', decision: null, updatedAt: new Date(Date.now() - 3600 * 1000) }, { timestamps: false });
    await retryWorker.tick();
    expect((await request(app).get(`/api/requests/${id}`)).body.status).toBe('APPROVED');
  });
});

describe('6. Rule change scenarios', () => {
  async function publishStricterV2() {
    const v1 = (await request(app).get('/api/workflows/loan_approval/1')).body;
    const v2 = JSON.parse(JSON.stringify(v1));
    v2.version = 2;
    v2.stages.threshold_checks.rules[0].expr = 'loan_amount <= income * 2';
    return request(app).post('/api/workflows').send(v2);
  }

  test('in-flight requests keep their pinned version; new requests use the new one', async () => {
    const payload = (id) => goodLoan({ applicant_id: id, income: 70000, loan_amount: 250000 }); // passes 5x, fails 2x
    const inFlight = await submit({ ...payload('INFLIGHT'), simulate_failure: { service: 'credit_bureau', fail_times: 1 } });
    expect(inFlight.body.request.status).toBe('RETRY_PENDING');

    expect((await publishStricterV2()).status).toBe(201);

    const resumed = await request(app).post(`/api/requests/${inFlight.body.request.id}/retry`);
    expect(resumed.body.workflowVersion).toBe(1);
    expect(resumed.body.status).toBe('APPROVED'); // decided under v1 rules

    const fresh = await submit(payload('FRESH'));
    expect(fresh.body.request.workflowVersion).toBe(2);
    expect(fresh.body.request.status).toBe('MANUAL_REVIEW'); // v2 rule R3 now fails
  });

  test('published versions are immutable', async () => {
    const v1 = (await request(app).get('/api/workflows/loan_approval/1')).body;
    expect((await request(app).post('/api/workflows').send(v1)).status).toBe(409);
  });

  test('invalid workflow definitions are rejected, not activated', async () => {
    const v1 = (await request(app).get('/api/workflows/loan_approval/1')).body;
    const broken = JSON.parse(JSON.stringify(v1));
    broken.version = 3;
    broken.stages.mandatory_checks.next = 'does_not_exist';
    const res = await request(app).post('/api/workflows').send(broken);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/does_not_exist/);
  });
});
