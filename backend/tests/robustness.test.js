'use strict';
// API-level tests for: audit integrity + retry/review audit entries, resume-after-review (vendor_approval),
// workflow activate/rollback, and the recovery lease. Uses the same in-memory MongoDB as api.test.js.
const helpers = require('./helpers');
const request = require('supertest');
const app = require('../src/app');
const Request = require('../src/models/Request');
const requestService = require('../src/services/request.service');
const retryWorker = require('../src/services/retryWorker');

beforeAll(helpers.connect);
afterAll(helpers.disconnect);
beforeEach(helpers.reset);

const goodLoan = (over = {}) => ({ applicant_id: 'A-1', income: 60000, loan_amount: 150000, age: 30, mock_credit_score: 720, ...over });
const submit = (payload, workflow = 'loan_approval') => request(app).post('/api/requests').send({ workflow, payload });
const auditOf = async (id) => (await request(app).get(`/api/requests/${id}/audit`)).body;
const types = (audit) => audit.auditLog.map((e) => e.type);

describe('audit integrity', () => {
  test('a stored audit log verifies, and tampering with the database is detected', async () => {
    const id = (await submit(goodLoan())).body.request.id;
    const before = await auditOf(id);
    expect(before.integrity).toMatchObject({ valid: true, checked: before.auditLog.length });

    await Request.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(id) }, { $set: { 'auditLog.1.message': 'edited by an attacker' } });
    const after = await auditOf(id);
    expect(after.integrity).toMatchObject({ valid: false, brokenAtSeq: 2 });
    expect((await request(app).get(`/api/requests/${id}/explanation`)).body.integrity.valid).toBe(false);
  });

  test('manual retries and background retries both leave an audit entry saying who triggered them', async () => {
    const flaky = () => goodLoan({ simulate_failure: { service: 'credit_bureau', fail_times: 1 } });
    const manual = (await submit(flaky())).body.request.id;
    await request(app).post(`/api/requests/${manual}/retry`);
    const m = await auditOf(manual);
    expect(m.auditLog.find((e) => e.type === 'RETRY_STARTED').data).toMatchObject({ trigger: 'manual', attemptsSoFar: 1 });

    const worker = (await submit({ ...flaky(), applicant_id: 'A-2' })).body.request.id;
    await Request.updateOne({ _id: worker }, { nextRetryAt: new Date(Date.now() - 1000) });
    await retryWorker.tick();
    const w = await auditOf(worker);
    expect(w.auditLog.find((e) => e.type === 'RETRY_STARTED').data.trigger).toBe('worker');
    expect(w.integrity.valid).toBe(true);
  });

  test('a review leaves REVIEW_CLAIMED then MANUAL_REVIEW_DECISION, and the chain still verifies', async () => {
    const id = (await submit(goodLoan({ income: 10000, loan_amount: 150000 }))).body.request.id; // R3 fails -> manual review
    await request(app).post(`/api/requests/${id}/review`).send({ decision: 'approve', reviewer: 'maya' });
    const a = await auditOf(id);
    const t = types(a);
    expect(t.indexOf('REVIEW_CLAIMED')).toBeGreaterThan(-1);
    expect(t.indexOf('MANUAL_REVIEW_DECISION')).toBeGreaterThan(t.indexOf('REVIEW_CLAIMED'));
    expect(a.integrity.valid).toBe(true);
  });
});

describe('manual review resumes the workflow (vendor_approval)', () => {
  const vendor = (over = {}) => ({ vendor_id: 'V-1', country: 'IN', years_in_business: 5, annual_revenue: 500000, simulate_failure: { service: 'kyc', fail_times: 10 }, ...over });
  const kycDown = async (over) => {
    const id = (await submit(vendor(over), 'vendor_approval')).body.request.id;
    const res = await request(app).post(`/api/requests/${id}/retry`); // second and last attempt
    expect(res.body.status).toBe('MANUAL_REVIEW');
    expect(res.body.currentStage).toBe('kyc_review');
    return id;
  };

  test('approval after a KYC outage still enforces the revenue rule (V4 passes -> APPROVED)', async () => {
    const id = await kycDown();
    const res = await request(app).post(`/api/requests/${id}/review`).send({ decision: 'approve', reviewer: 'maya' });
    expect(res.body.status).toBe('APPROVED');
    const stages = (await auditOf(id)).auditLog.filter((e) => e.type === 'RULES_EVALUATED').map((e) => e.stage);
    expect(stages).toContain('revenue_check');
  });

  test('approval after a KYC outage cannot bypass the revenue rule (V4 fails -> back to manual review)', async () => {
    const id = await kycDown({ annual_revenue: 50000 });
    const res = await request(app).post(`/api/requests/${id}/review`).send({ decision: 'approve', reviewer: 'maya' });
    expect(res.body.status).toBe('MANUAL_REVIEW');
    expect(res.body.currentStage).toBe('manual_review');
  });

  test('rejection follows on_reject', async () => {
    const id = await kycDown();
    expect((await request(app).post(`/api/requests/${id}/review`).send({ decision: 'reject', reviewer: 'sam' })).body.status).toBe('REJECTED');
  });
});

describe('workflow activate / rollback', () => {
  const publishStricterV2 = async () => {
    const v2 = JSON.parse(JSON.stringify((await request(app).get('/api/workflows/loan_approval/1')).body));
    v2.version = 2;
    v2.stages.threshold_checks.rules[0].expr = 'loan_amount <= income * 2';
    expect((await request(app).post('/api/workflows').send(v2)).status).toBe(201);
  };
  const bigLoan = (id) => goodLoan({ applicant_id: id, income: 70000, loan_amount: 250000 }); // passes 5x, fails 2x
  const versionUsed = async (id) => (await submit(bigLoan(id))).body.request.workflowVersion;

  test('roll back to v1, then forward to v2, without publishing a copy', async () => {
    await publishStricterV2();
    expect(await versionUsed('N1')).toBe(2);

    const back = await request(app).post('/api/workflows/loan_approval/1/activate');
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ version: 1, previousVersion: 2 });
    const fresh = await submit(bigLoan('N2'));
    expect(fresh.body.request.workflowVersion).toBe(1);
    expect(fresh.body.request.status).toBe('APPROVED'); // v1 rules again

    const listed = (await request(app).get('/api/workflows')).body.filter((w) => w.name === 'loan_approval');
    expect(listed.find((w) => w.version === 1).active).toBe(true);
    expect(listed.find((w) => w.version === 2).active).toBe(false);

    await request(app).post('/api/workflows/loan_approval/2/activate');
    expect(await versionUsed('N3')).toBe(2);
  });

  test('a request created under v2 keeps v2 after a rollback', async () => {
    await publishStricterV2();
    const created = await submit({ ...bigLoan('PIN'), simulate_failure: { service: 'credit_bureau', fail_times: 1 } });
    expect(created.body.request.workflowVersion).toBe(2);
    await request(app).post('/api/workflows/loan_approval/1/activate');
    const resumed = await request(app).post(`/api/requests/${created.body.request.id}/retry`);
    expect(resumed.body.workflowVersion).toBe(2);
    expect(resumed.body.status).toBe('MANUAL_REVIEW'); // decided by v2 rules, not the rolled-back-to v1
  });

  test('unknown version -> 404 and nothing changes', async () => {
    expect((await request(app).post('/api/workflows/loan_approval/9/activate')).status).toBe(404);
    expect((await request(app).post('/api/workflows/nope/1/activate')).status).toBe(404);
    expect(await versionUsed('N4')).toBe(1);
  });
});

describe('recovery lease', () => {
  const stuck = async (extra = {}) => {
    const id = (await submit(goodLoan())).body.request.id;
    await Request.updateOne(
      { _id: id },
      { status: 'IN_PROGRESS', currentStage: 'threshold_checks', decision: null, updatedAt: new Date(Date.now() - 3600 * 1000), ...extra },
      { timestamps: false }
    );
    return id;
  };

  test('a request leased by another worker is not resumed until the lease expires', async () => {
    const id = await stuck({ lockedUntil: new Date(Date.now() + 60000) });
    expect(await requestService.recoverStuck()).toBe(0);
    expect((await request(app).get(`/api/requests/${id}`)).body.status).toBe('IN_PROGRESS');

    await Request.updateOne({ _id: id }, { lockedUntil: new Date(Date.now() - 1000) }, { timestamps: false });
    expect(await requestService.recoverStuck()).toBe(1);
    expect((await request(app).get(`/api/requests/${id}`)).body.status).toBe('APPROVED');
  });

  test('two workers recovering at the same time resume the request exactly once', async () => {
    const id = await stuck();
    const counts = await Promise.all([requestService.recoverStuck(), requestService.recoverStuck()]);
    expect(counts[0] + counts[1]).toBe(1);
    const a = await auditOf(id);
    expect(types(a).filter((t) => t === 'RECOVERY')).toHaveLength(1);
    expect(a.integrity.valid).toBe(true);
    expect((await Request.findById(id)).lockedUntil).toBeNull(); // lease released
  });
});