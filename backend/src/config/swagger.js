'use strict';
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };

module.exports = {
  openapi: '3.0.3',
  info: { title: 'Configurable Workflow Decision Platform', version: '1.0.0', description: 'Submit requests to configurable workflows, with rules, retries, idempotency and a full audit trail.' },
  paths: {
    '/api/requests': {
      post: {
        summary: 'Submit a request',
        description: 'Send an Idempotency-Key header to make retries safe. Without it, a hash of workflow+payload is used.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        requestBody: jsonBody(ref('CreateRequest')),
        responses: { 201: ok('Created and processed'), 200: ok('Duplicate: original result returned'), 400: ok('Schema validation failed'), 404: ok('Unknown workflow'), 422: ok('Idempotency key reused with a different payload') },
      },
      get: { summary: 'List requests', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'workflow', in: 'query', schema: { type: 'string' } }], responses: { 200: ok('OK') } },
    },
    '/api/requests/{id}': { get: { summary: 'Get request status', parameters: [idParam], responses: { 200: ok('OK'), 404: ok('Not found') } } },
    '/api/requests/{id}/audit': { get: { summary: 'Full audit log, state history and hash-chain integrity check', parameters: [idParam], responses: { 200: ok('OK') } } },
    '/api/requests/{id}/explanation': { get: { summary: 'Human-readable decision explanation with rule trace', parameters: [idParam], responses: { 200: ok('OK') } } },
    '/api/requests/{id}/retry': { post: { summary: 'Retry a RETRY_PENDING request now', parameters: [idParam], responses: { 200: ok('OK'), 409: ok('Not retryable') } } },
    '/api/requests/{id}/review': { post: { summary: 'Approve or reject a MANUAL_REVIEW request', parameters: [idParam], requestBody: jsonBody(ref('Review')), responses: { 200: ok('OK'), 409: ok('Not in manual review') } } },
    '/api/workflows': {
      get: { summary: 'List workflow versions', responses: { 200: ok('OK') } },
      post: { summary: 'Register a new workflow version (rule change without redeploy)', requestBody: jsonBody({ type: 'object' }), responses: { 201: ok('Registered'), 400: ok('Invalid definition'), 409: ok('Version already exists') } },
    },
    '/api/workflows/{name}': { get: { summary: 'Latest definition', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok('OK') } } },
    '/api/workflows/{name}/{version}/activate': { post: { summary: 'Make this version the live one (rollback / roll-forward)', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: ok('Activated'), 404: ok('Unknown workflow or version') } } },
    '/api/workflows/{name}/{version}': { get: { summary: 'Specific version', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: ok('OK') } } },
  },
  components: {
    schemas: {
      CreateRequest: {
        type: 'object', required: ['workflow', 'payload'],
        properties: {
          workflow: { type: 'string', example: 'loan_approval' },
          payload: { type: 'object', example: { applicant_id: 'A-1001', income: 60000, loan_amount: 150000, age: 30, mock_credit_score: 720 } },
        },
      },
      Review: {
        type: 'object', required: ['decision', 'reviewer'],
        properties: { decision: { type: 'string', enum: ['approve', 'reject'] }, reviewer: { type: 'string' }, comment: { type: 'string' } },
      },
    },
  },
};