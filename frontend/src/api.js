// Thin wrapper over the REST API. Throws Error(message) with the server's error message.
async function call(path, options = {}) {
  const { headers = {}, ...rest } = options;
  const res = await fetch(path, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers }, // merge, don't replace
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error || {};
    const detail = e.details ? ` ${JSON.stringify(e.details)}` : '';
    throw new Error(`${e.message || res.statusText}${detail}`);
  }
  return body;
}

export const api = {
  workflows: () => call('/api/workflows'),
  list: () => call('/api/requests?limit=30'),
  explanation: (id) => call(`/api/requests/${id}/explanation`),
  submit: (workflow, payload, key) =>
    call('/api/requests', {
      method: 'POST',
      headers: key ? { 'Idempotency-Key': key } : {},
      body: JSON.stringify({ workflow, payload }),
    }),
  retry: (id) => call(`/api/requests/${id}/retry`, { method: 'POST' }),
  review: (id, decision) =>
    call(`/api/requests/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, reviewer: 'ui-reviewer', comment: 'Decided in UI' }),
    }),
};