# Configurable Workflow Decision Platform (MERN)

A generic, configuration-driven workflow engine. It accepts structured requests, validates them, evaluates rules, runs
workflow stages (including a simulated external dependency), keeps full state history and an audit trail, and handles
retries, duplicates and failures. **Business logic lives in YAML/JSON workflow definitions, not in code.**

Two use cases ship in `backend/config/workflows/` and run on the same engine with zero code differences:
`loan_approval` and `vendor_approval`.

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

Test hooks in the payload (simulation only): `mock_credit_score`, `mock_kyc_verified`, and
`simulate_failure: {service, fail_times, mode: "error"|"timeout"}`.

## Project layout

```
backend/
  config/workflows/        loan_approval.yaml, vendor_approval.yaml   <- the configuration model
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
