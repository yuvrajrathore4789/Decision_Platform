# Configurable Workflow Decision Platform (MERN)

A generic, configuration-driven workflow engine. It accepts structured requests, validates them, evaluates rules, runs
workflow stages (including a simulated external dependency), keeps full state history and an audit trail, and handles
retries, duplicates and failures. **Business logic lives in YAML/JSON workflow definitions, not in code.**

Three use cases ship in `backend/config/workflows/` and run on the same engine with zero code differences:
`loan_approval`, `vendor_approval` and `claim_processing` (the last one demonstrates conditional `branch` routing).

**Stack:** MongoDB + Express + React (Vite) + Node.js, REST API, Jest/Supertest tests, Swagger UI.

## Quick start

**Prerequisites:** Node 18+ and MongoDB running locally (or use Docker, below).

```bash
# 1. Backend
cd backend
cp .env.example .env
npm install
npm start                 # API  http://localhost:3000   Swagger UI  http://localhost:3000/docs

# 2. Frontend (optional minimal UI)
cd ../frontend
npm install
npm run dev               # http://localhost:5173  (proxies /api to :3000)
```

**Docker alternative** (MongoDB + API): `docker compose up --build`

## Run the tests

```bash
cd backend
npm test
```

Tests use an in-memory MongoDB (`mongodb-memory-server`; the first run downloads a MongoDB binary). To use a real
instance instead: `TEST_MONGO_URI=mongodb://127.0.0.1:27017/dp_test npm test`.

| Required scenario | Where |
|---|---|
| Happy path | `tests/api.test.js` (1), `tests/workflowEngine.test.js` |
| Invalid input | `tests/api.test.js` (2) |
| Duplicate requests | `tests/api.test.js` (3): same key, same payload, key reuse, 6 concurrent duplicates, crash recovery |
| Dependency failure | `tests/api.test.js` (4): failure, timeout, retries exhausted |
| Retry flow | `tests/api.test.js` (5): manual retry, concurrent retries, background worker, stuck-request recovery |
| Rule change | `tests/api.test.js` (6): pinned versions, immutability, invalid config rejected |
| Conditional branching | `tests/branchStage.test.js` (unit), `tests/claimProcessing.test.js` (API, third workflow) |
| Config graph validation | `tests/workflowGraph.test.js`: cycles, unreachable stages, manual-review terminals |
| Simulation hooks gated | `tests/claimProcessing.test.js` (SIMULATION_MODE) |
| Rules engine | `tests/rulesEngine.test.js`; config validation: `tests/workflowValidator.test.js` |

## API (full docs at `/docs`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/requests` | Submit (header `Idempotency-Key` optional). 201 new, 200 duplicate |
| GET | `/api/requests` / `/api/requests/:id` | List / status |
| GET | `/api/requests/:id/audit` | Raw audit log + state history |
| GET | `/api/requests/:id/explanation` | Human-readable decision with rule trace |
| POST | `/api/requests/:id/retry` | Retry a `RETRY_PENDING` request now |
| POST | `/api/requests/:id/review` | Approve/reject a `MANUAL_REVIEW` request |
| GET/POST | `/api/workflows` | List versions / register a new version (rule change, no redeploy) |
| GET | `/api/workflows/:name[/:version]` | Read a definition |

### Try it

```bash
# Approved
curl -s -X POST localhost:3000/api/requests -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"workflow":"loan_approval","payload":{"applicant_id":"A-1","income":60000,"loan_amount":150000,"age":30,"mock_credit_score":720}}'

# Same call again -> 200, "duplicate": true, same request id
# Dependency fails once -> RETRY_PENDING, then POST /api/requests/<id>/retry -> APPROVED
curl -s -X POST localhost:3000/api/requests -H 'Content-Type: application/json' \
  -d '{"workflow":"loan_approval","payload":{"applicant_id":"A-2","income":60000,"loan_amount":100000,"age":30,"mock_credit_score":700,"simulate_failure":{"service":"credit_bureau","fail_times":1}}}'

# Explain a decision
curl -s localhost:3000/api/requests/<id>/explanation
```

Test hooks in the payload (simulation only): `mock_credit_score`, `mock_kyc_verified`, `mock_fraud_score`, and
`simulate_failure: {service, fail_times, mode: "error"|"timeout"}`.

**Simulation mode.** These hooks are honoured only when `SIMULATION_MODE=true` (the default, except when
`NODE_ENV=production`). When it is `false`, a payload containing a hook is rejected with `400` and the adapters ignore
them, so a caller can never supply their own credit score. Set it in `backend/.env` (see `backend/.env.example`).

### Conditional branching example (claim_processing)

```bash
# Theft claim -> branch B2 routes it to fraud screening -> low risk -> APPROVED
curl -s -X POST localhost:3000/api/requests -H 'Content-Type: application/json' \
  -d '{"workflow":"claim_processing","payload":{"claim_id":"CL-1","policy_id":"P-1","policy_active":true,"incident_type":"theft","claim_amount":8000,"coverage_limit":100000,"mock_fraud_score":12}}'
```

## Project layout

```
backend/
  config/workflows/        loan_approval, vendor_approval, claim_processing (.yaml)   <- the configuration model
  src/
    app.js, server.js      Express app / process bootstrap
    config/                env, db connection, swagger spec
    routes/                URL -> controller mapping
    controllers/           thin HTTP layer (no business logic)
    middleware/            validateBody, errorHandler, notFound, requestLogger
    validators/            JSON Schemas for API request bodies
    services/              request, workflow (config + versions), idempotency, audit, retryWorker
    engine/                rulesEngine (safe evaluator), workflowEngine (state machine)
    adapters/              simulated external dependencies with failure injection
    models/                Mongoose schemas: Request, WorkflowDefinition, IdempotencyKey
    utils/                 errors, constants, hashing, workflow validator, presenters
  .env.example             copy to .env
  scripts/generateExamples.js   regenerates docs/decision_examples.md from the real engine
  tests/
frontend/                  minimal React UI (submit, list, explanation, retry/review)
docs/
  architecture.md          design, data flow, trade-offs, assumptions, scaling
  decision_examples.md     real inputs -> rules triggered -> outcome -> audit reasoning
```

## Documentation
- [Architecture](docs/architecture.md): components, data flow, configuration model, trade-offs, assumptions, scaling
- [Decision examples](docs/decision_examples.md)