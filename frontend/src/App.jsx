import { useEffect, useState, useCallback } from 'react';
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
};

const Badge = ({ status }) => <span className={`badge ${status}`}>{status}</span>;

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [workflow, setWorkflow] = useState('loan_approval');
  const [payload, setPayload] = useState(JSON.stringify(Object.values(SAMPLES.loan_approval)[0], null, 2));
  const [key, setKey] = useState('');
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => setItems((await api.list()).items), []);
  const open = useCallback(async (id) => setSelected(await api.explanation(id)), []);
  const guard = (fn) => async (...a) => { try { setNotice(null); await fn(...a); } catch (e) { setNotice({ error: e.message }); } };

  useEffect(() => { guard(async () => { setWorkflows(await api.workflows()); await refresh(); })(); }, []); // eslint-disable-line

  const names = [...new Set(workflows.map((w) => w.name))];
  const pick = (name) => { setWorkflow(name); setPayload(JSON.stringify(Object.values(SAMPLES[name] || { x: {} })[0], null, 2)); };

  const submit = guard(async () => {
    const { duplicate, request } = await api.submit(workflow, JSON.parse(payload), key || undefined);
    setNotice({ ok: duplicate ? `Duplicate detected: returned original request (${request.status})` : `Created: ${request.status}` });
    await refresh(); await open(request.id);
  });
  const act = (fn, id) => guard(async () => { await fn(id); await refresh(); await open(id); })();

  return (
    <div className="app">
      <h1>Workflow Decision Platform</h1>
      {notice && <div className={notice.error ? 'notice err' : 'notice ok'}>{notice.error || notice.ok}</div>}
      <div className="grid">
        <section className="card">
          <h2>Submit a request</h2>
          <label>Workflow
            <select value={workflow} onChange={(e) => pick(e.target.value)}>
              {(names.length ? names : ['loan_approval']).map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
          <div className="chips">
            {Object.entries(SAMPLES[workflow] || {}).map(([label, p]) => (
              <button key={label} className="chip" onClick={() => setPayload(JSON.stringify(p, null, 2))}>{label}</button>
            ))}
          </div>
          <label>Payload (JSON)<textarea rows={11} value={payload} onChange={(e) => setPayload(e.target.value)} /></label>
          <label>Idempotency-Key (optional)<input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. order-123" /></label>
          <button className="primary" onClick={submit}>Submit</button>
        </section>

        <section className="card">
          <h2>Requests <button className="link" onClick={guard(refresh)}>refresh</button></h2>
          <ul className="list">
            {items.map((r) => (
              <li key={r.id} onClick={guard(() => open(r.id))} className={selected?.requestId === r.id ? 'sel' : ''}>
                <Badge status={r.status} /> <b>{r.workflow}</b> v{r.workflowVersion}
                <small>{r.id.slice(-6)}</small>
              </li>
            ))}
            {!items.length && <li className="muted">No requests yet</li>}
          </ul>
        </section>

        <section className="card wide">
          <h2>Decision explanation</h2>
          {!selected ? <p className="muted">Select or submit a request.</p> : (
            <>
              <p><Badge status={selected.status} /> {selected.summary}</p>
              {selected.status === 'RETRY_PENDING' && <button onClick={() => act(api.retry, selected.requestId)}>Retry now</button>}
              {selected.status === 'MANUAL_REVIEW' && (
                <span>
                  <button onClick={() => act((id) => api.review(id, 'approve'), selected.requestId)}>Approve</button>{' '}
                  <button onClick={() => act((id) => api.review(id, 'reject'), selected.requestId)}>Reject</button>
                </span>
              )}
              <ol className="steps">
                {selected.steps.map((s) => (
                  <li key={s.seq}>
                    <code>{s.type}</code> <span className="muted">{s.stage}</span> {s.message}
                    {s.rules && <ul>{s.rules.map((r) => <li key={r.ruleId} className={r.passed ? 'pass' : 'fail'}>{r.passed ? 'PASS' : 'FAIL'} {r.ruleId}: {r.reason}</li>)}</ul>}
                  </li>
                ))}
              </ol>
              <details><summary>State history</summary>
                <pre>{selected.stateHistory.map((h) => `${h.from} -> ${h.to}: ${h.reason}`).join('\n')}</pre>
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
