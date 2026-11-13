import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { api } from './api.js';

const SAMPLES = {
  loan_approval: {
    'Approve': { applicant_id: 'A-1001', income: 60000, loan_amount: 150000, age: 30, mock_credit_score: 720 },
    'Reject (underage)': { applicant_id: 'A-1002', income: 60000, loan_amount: 10000, age: 16 },
    'Manual review (loan too big)': { applicant_id: 'A-1003', income: 40000, loan_amount: 400000, age: 35, mock_credit_score: 700 },
    'Dependency fails once (retry)': { applicant_id: 'A-1004', income: 70000, loan_amount: 100000, age: 29, mock_credit_score: 700, simulate_failure: { service: 'credit_bureau', fail_times: 1 } },
  },
  vendor_approval: {
    'Approve': { vendor_id: 'V-77', country: 'IN', years_in_business: 5, annual_revenue: 500000 },
    'Reject (unsupported country)': { vendor_id: 'V-78', country: 'XX', years_in_business: 5, annual_revenue: 500000 },
  },
  claim_processing: {
    'Auto-approve (small claim)': { claim_id: 'CL-1', policy_id: 'P-1', policy_active: true, incident_type: 'accident', claim_amount: 4200, coverage_limit: 100000 },
    'Theft -> fraud check -> approve': { claim_id: 'CL-2', policy_id: 'P-1', policy_active: true, incident_type: 'theft', claim_amount: 8000, coverage_limit: 100000, mock_fraud_score: 12 },
    'Mid-value -> manual review': { claim_id: 'CL-3', policy_id: 'P-1', policy_active: true, incident_type: 'property', claim_amount: 25000, coverage_limit: 100000 },
    'Fraud engine fails once (retry)': { claim_id: 'CL-4', policy_id: 'P-1', policy_active: true, incident_type: 'medical', claim_amount: 80000, coverage_limit: 150000, mock_fraud_score: 5, simulate_failure: { service: 'fraud_screening', fail_times: 1 } },
  },
};

const STATUS = {
  APPROVED: { label: 'Approved', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'bad' },
  MANUAL_REVIEW: { label: 'Needs review', tone: 'warn' },
  RETRY_PENDING: { label: 'Retry scheduled', tone: 'retry' },
  IN_PROGRESS: { label: 'Running', tone: 'info' },
  RECEIVED: { label: 'Received', tone: 'info' },
};
const FINAL = ['APPROVED', 'REJECTED'];
const NEEDS_ACTION = ['MANUAL_REVIEW', 'RETRY_PENDING'];

const STEP_LABEL = {
  REQUEST_RECEIVED: 'Request received',
  PROCESSING_STARTED: 'Processing started',
  RULES_EVALUATED: 'Rules checked',
  BRANCH_TAKEN: 'Route chosen',
  DEPENDENCY_SUCCESS: 'Dependency answered',
  DEPENDENCY_FAILURE: 'Dependency failed',
  RETRIES_EXHAUSTED: 'Retries used up',
  MANUAL_REVIEW_REQUIRED: 'Sent to review',
  MANUAL_REVIEW_DECISION: 'Reviewer decided',
  DECISION: 'Decision made',
  RECOVERY: 'Recovered after a stall',
};

function stepTone(s) {
  switch (s.type) {
    case 'RULES_EVALUATED': return (s.rules || []).some((r) => !r.passed) ? 'bad' : 'ok';
    case 'BRANCH_TAKEN': return 'info';
    case 'DEPENDENCY_SUCCESS': return 'ok';
    case 'DEPENDENCY_FAILURE': return 'retry';
    case 'RETRIES_EXHAUSTED': return 'bad';
    case 'MANUAL_REVIEW_REQUIRED': return 'warn';
    case 'MANUAL_REVIEW_DECISION': return 'info';
    case 'DECISION': return s.data && s.data.outcome === 'APPROVED' ? 'ok' : 'bad';
    default: return 'neutral';
  }
}

const words = (id) => (id || '').replace(/_/g, ' ');
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
const friendly = (e) => (/failed to fetch|networkerror/i.test(e.message)
  ? 'Cannot reach the API. Start the backend (npm start in backend/) and try again.'
  : e.message);

/** Flatten a small object into [key, value] pairs for the "data used" chips. */
const pairs = (o) => Object.entries(o || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);

function Tag({ status }) {
  const m = STATUS[status] || { label: status, tone: 'neutral' };
  return <span className={`tag tone-${m.tone}`}>{m.label}</span>;
}

/* ---------- the path a request took ---------- */
function Path({ steps }) {
  const nodes = useMemo(() => {
    const order = [];
    const byStage = {};
    steps.forEach((s) => {
      if (!s.stage) return;
      if (!byStage[s.stage]) { byStage[s.stage] = []; order.push(s.stage); }
      byStage[s.stage].push(s);
    });
    return order.map((id) => {
      const list = byStage[id];
      return { id, tone: stepTone(list[list.length - 1]), tries: list.filter((s) => s.type === 'DEPENDENCY_FAILURE').length };
    });
  }, [steps]);
  return (
    <ol className="path" aria-label="Stages this request passed through">
      {nodes.map((n, i) => (
        <li key={n.id} className={`tone-${n.tone}`} style={{ '--i': i }}>
          <span className="path-dot" aria-hidden="true" />
          <span className="path-name">{words(n.id)}</span>
          {n.tries > 0 && <span className="path-note">{n.tries} failed {n.tries === 1 ? 'try' : 'tries'}</span>}
        </li>
      ))}
    </ol>
  );
}

/* ---------- the audit trail ---------- */
function Rules({ rules }) {
  return (
    <ul className="rules">
      {rules.map((r) => (
        <li key={r.ruleId} className={r.passed ? 'pass' : 'fail'}>
          <span className="verdict">{r.passed ? 'Passed' : 'Failed'}</span>
          <span className="rule-id">{r.ruleId}</span>
          <span className="rule-desc">{r.description || 'Rule'}</span>
          <code className="rule-why">{r.reason}</code>
        </li>
      ))}
    </ul>
  );
}

function Trail({ steps }) {
  return (
    <ol className="trail">
      {steps.map((s) => {
        const used = [...pairs(s.data && s.data.inputs), ...pairs(s.data && s.data.result)];
        return (
          <li key={s.seq} className={`step tone-${stepTone(s)}`}>
            <span className="step-dot" aria-hidden="true" />
            <div className="step-head">
              <h4>{STEP_LABEL[s.type] || s.type}</h4>
              {s.stage && <span className="stage-chip">{words(s.stage)}</span>}
              <time>{clock(s.at)}</time>
            </div>
            <p className="step-msg">{s.message}</p>
            {s.rules && <Rules rules={s.rules} />}
            {used.length > 0 && (
              <dl className="used" aria-label="Data used">
                {used.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- selected request ---------- */
function Detail({ ex, onRetry, onReview, busy }) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [ex.requestId]);
  // Decided: the decision reason. Waiting: why it is waiting (the reason on the last state change).
  const lastChange = ex.stateHistory[ex.stateHistory.length - 1];
  const text = ex.decision ? ex.decision.reason : (lastChange && lastChange.reason) || ex.summary;
  return (
    <article className="detail" key={ex.requestId}>
      <header className={`verdict-head tone-${(STATUS[ex.status] || {}).tone}`}>
        <div>
          <h2>{(STATUS[ex.status] || {}).label || ex.status}</h2>
          <p className="meta">{ex.workflow} v{ex.workflowVersion} <span aria-hidden="true">/</span> <code>{ex.requestId}</code></p>
          <p className="reason">{text}</p>
        </div>
        {ex.status === 'RETRY_PENDING' && (
          <div className="actions">
            <p className="hint">The dependency failed. The background worker retries automatically, or you can retry now.</p>
            <button className="btn primary" disabled={busy} onClick={onRetry}>Retry now</button>
          </div>
        )}
        {ex.status === 'MANUAL_REVIEW' && (
          <div className="actions">
            <label>Reviewer note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this decision?" />
            </label>
            <div className="btn-row">
              <button className="btn approve" disabled={busy} onClick={() => onReview('approve', note)}>Approve</button>
              <button className="btn reject" disabled={busy} onClick={() => onReview('reject', note)}>Reject</button>
            </div>
          </div>
        )}
      </header>

      <section className="block">
        <h3>Path taken</h3>
        <Path steps={ex.steps} />
      </section>

      <section className="block">
        <h3>Decision trail</h3>
        <Trail steps={ex.steps} />
      </section>

      <section className="block disclosures">
        <details>
          <summary>Submitted data</summary>
          <pre>{JSON.stringify(ex.dataReference.payload, null, 2)}</pre>
          <p className="muted small">Payload hash <code>{ex.dataReference.payloadHash}</code></p>
        </details>
        <details>
          <summary>State history ({ex.stateHistory.length} changes)</summary>
          <table className="history">
            <tbody>
              {ex.stateHistory.map((h, i) => (
                <tr key={i}>
                  <td className="nowrap"><time>{clock(h.at)}</time></td>
                  <td className="nowrap">{(STATUS[h.from] || {}).label || h.from || 'New'} to {(STATUS[h.to] || {}).label || h.to}</td>
                  <td>{h.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    </article>
  );
}

/* ---------- new request ---------- */
function Intake({ names, workflows, onSubmit, busy }) {
  const [workflow, setWorkflow] = useState('loan_approval');
  const [label, setLabel] = useState(null);
  const [payload, setPayload] = useState(JSON.stringify(Object.values(SAMPLES.loan_approval)[0], null, 2));
  const [key, setKey] = useState('');
  const samples = SAMPLES[workflow] || {};
  const jsonError = useMemo(() => { try { JSON.parse(payload); return null; } catch (e) { return e.message; } }, [payload]);
  const def = workflows.filter((w) => w.name === workflow).sort((a, b) => b.version - a.version)[0];

  const choose = (name) => {
    setWorkflow(name);
    const first = Object.entries(SAMPLES[name] || {})[0];
    setLabel(first ? first[0] : null);
    setPayload(JSON.stringify(first ? first[1] : {}, null, 2));
  };
  const useSample = (l, p) => { setLabel(l); setPayload(JSON.stringify(p, null, 2)); };

  return (
    <form className="intake" onSubmit={(e) => { e.preventDefault(); if (!jsonError) onSubmit(workflow, JSON.parse(payload), key.trim()); }}>
      <h2>New request</h2>
      <p className="lede">Pick a workflow, start from a scenario or write your own data, then submit. The decision and its reasoning appear next.</p>

      <label className="field">Workflow
        <select value={workflow} onChange={(e) => choose(e.target.value)}>
          {(names.length ? names : ['loan_approval']).map((n) => <option key={n} value={n}>{words(n)}</option>)}
        </select>
        {def && <span className="muted small">Version {def.version}, {def.stages.length} stages</span>}
      </label>

      <fieldset className="scenarios">
        <legend>Scenarios</legend>
        {Object.entries(samples).map(([l, p]) => (
          <button type="button" key={l} className={`scenario${label === l ? ' on' : ''}`} aria-pressed={label === l} onClick={() => useSample(l, p)}>{l}</button>
        ))}
      </fieldset>

      <label className="field">Request data (JSON)
        <textarea rows={12} spellCheck="false" value={payload} aria-invalid={Boolean(jsonError)}
          onChange={(e) => { setPayload(e.target.value); setLabel(null); }} />
        {jsonError && <span className="field-error">Not valid JSON: {jsonError}</span>}
      </label>

      <label className="field">Idempotency key (optional)
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="order-123" />
        <span className="muted small">Submit the same key twice to see duplicate handling: the original result comes back.</span>
      </label>

      <button className="btn primary wide" type="submit" disabled={busy || Boolean(jsonError)}>Submit request</button>
    </form>
  );
}

/* ---------- sidebar ---------- */
function Sidebar({ items, selectedId, filter, setFilter, onOpen, onNew, creating }) {
  const counts = { all: items.length, action: items.filter((r) => NEEDS_ACTION.includes(r.status)).length, done: items.filter((r) => FINAL.includes(r.status)).length };
  const shown = items.filter((r) => filter === 'all' || (filter === 'action' ? NEEDS_ACTION.includes(r.status) : FINAL.includes(r.status)));
  return (
    <aside className="side" aria-label="Requests">
      <button className={`btn primary wide${creating ? ' on' : ''}`} onClick={onNew}>New request</button>
      <div className="filters" role="tablist" aria-label="Filter requests">
        {[['all', 'All'], ['action', 'Needs action'], ['done', 'Decided']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {l} <span className="count">{counts[k]}</span>
          </button>
        ))}
      </div>
      <ul className="requests">
        {shown.map((r) => {
          const m = STATUS[r.status] || { label: r.status, tone: 'neutral' };
          return (
            <li key={r.id}>
              <button className={`req tone-${m.tone}${!creating && selectedId === r.id ? ' sel' : ''}`} onClick={() => onOpen(r.id)}>
                <span className="req-dot" aria-hidden="true" />
                <span className="req-main">
                  <span className="req-name">{words(r.workflow)}</span>
                  <span className="req-sub">{m.label} · {ago(r.updatedAt || r.createdAt)}</span>
                </span>
                <code className="req-id">{r.id.slice(-6)}</code>
              </button>
            </li>
          );
        })}
        {!shown.length && (
          <li className="empty">{items.length ? 'Nothing in this filter.' : 'No requests yet. Submit one to see how it is decided.'}</li>
        )}
      </ul>
    </aside>
  );
}

/* ---------- app ---------- */
export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(true);
  const [filter, setFilter] = useState('all');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const selRef = useRef(null);
  selRef.current = selected;

  const refresh = useCallback(async () => setItems((await api.list()).items), []);
  const open = useCallback(async (id) => { setSelected(await api.explanation(id)); }, []);
  const say = (t) => setToast(t);

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (e) { say({ error: friendly(e) }); } finally { setBusy(false); }
  };

  useEffect(() => { run(async () => { setWorkflows(await api.workflows()); await refresh(); }); }, []); // eslint-disable-line
  useEffect(() => { // keep the list and any waiting request fresh (retries and reviews finish in the background)
    const t = setInterval(() => {
      refresh().catch(() => {});
      const s = selRef.current;
      if (s && !FINAL.includes(s.status)) open(s.requestId).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [refresh, open]);
  useEffect(() => { if (toast && toast.ok) { const t = setTimeout(() => setToast(null), 4500); return () => clearTimeout(t); } }, [toast]);

  const names = [...new Set(workflows.map((w) => w.name))];

  const submit = (workflow, payload, key) => run(async () => {
    const { duplicate, request } = await api.submit(workflow, payload, key || undefined);
    say({ ok: duplicate ? 'Duplicate request. Showing the original result, nothing was run again.' : 'Request submitted.' });
    await refresh(); await open(request.id); setCreating(false);
  });
  const retry = () => run(async () => { await api.retry(selected.requestId); say({ ok: 'Retry sent.' }); await refresh(); await open(selected.requestId); });
  const review = (decision, note) => run(async () => {
    await api.review(selected.requestId, decision, note);
    say({ ok: decision === 'approve' ? 'Approved.' : 'Rejected.' });
    await refresh(); await open(selected.requestId);
  });
  const pick = (id) => run(async () => { await open(id); setCreating(false); });

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M4 11h6m0 0 6-5.5M10 11l6 5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="4" cy="11" r="2.4" fill="currentColor" /><circle cx="17" cy="5" r="2.4" fill="currentColor" /><circle cx="17" cy="17" r="2.4" fill="currentColor" /></svg>
          <span>Decision Platform</span>
        </div>
        <a className="toplink" href="http://localhost:3000/docs" target="_blank" rel="noreferrer">API reference</a>
      </header>

      <div className="body">
        <Sidebar items={items} selectedId={selected && selected.requestId} filter={filter} setFilter={setFilter}
          onOpen={pick} onNew={() => setCreating(true)} creating={creating} />
        <main className="main">
          {creating || !selected
            ? <Intake names={names} workflows={workflows} onSubmit={submit} busy={busy} />
            : <Detail ex={selected} onRetry={retry} onReview={review} busy={busy} />}
        </main>
      </div>

      <div className="toast-zone" aria-live="polite">
        {toast && (
          <div className={`toast ${toast.error ? 'err' : 'ok'}`} role={toast.error ? 'alert' : 'status'}>
            <span>{toast.error || toast.ok}</span>
            {toast.error && <button className="toast-x" onClick={() => setToast(null)} aria-label="Dismiss">Dismiss</button>}
          </div>
        )}
      </div>
    </div>
  );
}