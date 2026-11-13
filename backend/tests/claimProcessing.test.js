'use strict';
const helpers = require('./helpers');
const request = require('supertest');
const app = require('../src/app');
const env = require('../src/config/env');

beforeAll(helpers.connect);
afterAll(helpers.disconnect);
beforeEach(helpers.reset);

const claim = (over = {}) => ({
  claim_id: 'CL-1', policy_id: 'P-1', policy_active: true, incident_type: 'accident',
  claim_amount: 5000, coverage_limit: 100000, ...over,
});
const submit = (payload) => request(app).post('/api/requests').send({ workflow: 'claim_processing', payload });

describe('claim_processing (third workflow, same engine, uses the branch stage)', () => {
  test('small low-risk claim takes the default branch and is auto-approved', async () => {
    const res = await submit(claim());
    expect(res.body.request.status).toBe('APPROVED');
    const audit = await request(app).get(`/api/requests/${res.body.request.id}/audit`);
    const branch = audit.body.auditLog.find((e) => e.type === 'BRANCH_TAKEN');
    expect(branch.data).toMatchObject({ matched: null, next: 'approve' });
  });

  test('mid-value claim is routed to manual review by branch B3', async () => {
    const res = await submit(claim({ claim_amount: 20000 }));
    expect(res.body.request.status).toBe('MANUAL_REVIEW');
    const ex = await request(app).get(`/api/requests/${res.body.request.id}/explanation`);
    expect(JSON.stringify(ex.body.steps)).toMatch(/B3/);
  });

  test('theft claim goes through fraud screening; low risk is approved', async () => {
    const res = await submit(claim({ incident_type: 'theft', mock_fraud_score: 10 }));
    expect(res.body.request.status).toBe('APPROVED');
    expect(res.body.request.context.fraud_check.risk_score).toBe(10);
  });

  test('high fraud score is rejected, medium goes to manual review', async () => {
    expect((await submit(claim({ claim_amount: 80000, mock_fraud_score: 90 }))).body.request.status).toBe('REJECTED');
    expect((await submit(claim({ claim_id: 'CL-2', claim_amount: 80000, mock_fraud_score: 55 }))).body.request.status).toBe('MANUAL_REVIEW');
  });

  test('fraud engine outage is retried and then succeeds', async () => {
    const res = await submit(claim({ claim_amount: 80000, mock_fraud_score: 5, simulate_failure: { service: 'fraud_screening', fail_times: 1 } }));
    expect(res.body.request.status).toBe('RETRY_PENDING');
    const retried = await request(app).post(`/api/requests/${res.body.request.id}/retry`);
    expect(retried.body.status).toBe('APPROVED');
  });

  test('inactive policy and over-limit claims are rejected by eligibility rules', async () => {
    expect((await submit(claim({ policy_active: false }))).body.request.status).toBe('REJECTED');
    expect((await submit(claim({ claim_id: 'CL-3', claim_amount: 200000 }))).body.request.status).toBe('REJECTED');
  });

  test('invalid enum value -> 400', async () => {
    expect((await submit(claim({ incident_type: 'alien' }))).status).toBe(400);
  });
});

describe('SIMULATION_MODE gating', () => {
  afterEach(() => { env.SIMULATION_MODE = true; });

  test('hooks are rejected with 400 when simulation mode is off', async () => {
    env.SIMULATION_MODE = false;
    const res = await submit(claim({ mock_fraud_score: 1 }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/mock_fraud_score/);
    const loan = await request(app).post('/api/requests').send({
      workflow: 'loan_approval', payload: { applicant_id: 'A', income: 1, loan_amount: 1, age: 30, mock_credit_score: 800 },
    });
    expect(loan.status).toBe(400); // an applicant can no longer pick their own credit score
  });

  test('clean payloads still work and use the simulated dependency, not caller-supplied values', async () => {
    env.SIMULATION_MODE = false;
    const res = await request(app).post('/api/requests').send({
      workflow: 'loan_approval', payload: { applicant_id: 'A-1', income: 60000, loan_amount: 100000, age: 30 },
    });
    expect(res.status).toBe(201);
    expect(res.body.request.context.credit_check.bureau).toBe('SIMULATED_BUREAU');
  });
});