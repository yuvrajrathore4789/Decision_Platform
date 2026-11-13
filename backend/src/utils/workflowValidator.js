'use strict';
const Ajv = require('ajv');
const { validateRule } = require('../engine/rulesEngine');
const { isKnownService } = require('../adapters/dependencyAdapter');
const { STAGE_TYPES } = require('./constants');

const ajv = new Ajv({ allErrors: true, strict: false });

/** Stage graph: stageId -> reachable stageIds. A manual_review stage can end in any terminal stage (human decision). */
function buildGraph(stages) {
  const terminals = Object.keys(stages).filter((id) => stages[id] && stages[id].type === 'terminal');
  const edges = {};
  for (const [id, st] of Object.entries(stages)) {
    const out = [];
    if (st && st.type === 'rules') out.push(st.next, ...(Array.isArray(st.rules) ? st.rules : []).map((r) => r && r.on_fail));
    else if (st && st.type === 'external_call') out.push(st.next, st.on_exhausted);
    else if (st && st.type === 'branch') out.push(st.default, ...(Array.isArray(st.branches) ? st.branches : []).map((b) => b && b.next));
    else if (st && st.type === 'manual_review') {
      // Explicit resume stages when configured; otherwise a human decision can end in any matching terminal stage.
      const byOutcome = (o) => terminals.filter((t) => stages[t].outcome === o);
      out.push(st.on_approve || byOutcome('APPROVED'), st.on_reject || byOutcome('REJECTED'));
    }
    edges[id] = [...new Set(out.flat().filter((t) => t && stages[t]))];
  }
  return edges;
}

/** Returns one cycle as ['a', 'b', 'a'], or null. */
function findCycle(edges) {
  const state = {}; // 1 = on the DFS stack, 2 = done
  const stack = [];
  let found = null;
  const visit = (n) => {
    state[n] = 1; stack.push(n);
    for (const m of edges[n]) {
      if (found) return;
      if (state[m] === 1) { found = [...stack.slice(stack.indexOf(m)), m]; return; }
      if (!state[m]) visit(m);
    }
    stack.pop(); state[n] = 2;
  };
  for (const n of Object.keys(edges)) if (!state[n] && !found) visit(n);
  return found;
}

function reachableFrom(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const m of edges[queue.shift()] || []) if (!seen.has(m)) { seen.add(m); queue.push(m); }
  return seen;
}

/**
 * Fail-fast validation of a workflow definition. Returns an array of problems (empty = valid).
 * Run at startup (YAML seed) and on POST /api/workflows, so a bad config can never be activated.
 */
function validateDefinition(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['definition must be an object'];
  if (!def.workflow || typeof def.workflow !== 'string') errors.push('workflow (name) is required');
  if (!Number.isInteger(def.version) || def.version < 1) errors.push('version must be an integer >= 1');
  if (!def.schema || typeof def.schema !== 'object') errors.push('schema (JSON Schema) is required');
  else { try { ajv.compile(def.schema); } catch (e) { errors.push(`schema is not valid JSON Schema: ${e.message}`); } }

  const stages = def.stages;
  if (!stages || typeof stages !== 'object' || !Object.keys(stages).length) return [...errors, 'stages are required'];
  if (!def.start || !stages[def.start]) errors.push(`start stage "${def.start}" does not exist`);

  const exists = (id, where) => { if (!id || !stages[id]) errors.push(`${where} references unknown stage "${id}"`); };
  let terminals = 0;

  for (const [id, st] of Object.entries(stages)) {
    if (!STAGE_TYPES.includes(st.type)) { errors.push(`stage "${id}": invalid type "${st.type}"`); continue; }
    if (st.type === 'rules') {
      if (!Array.isArray(st.rules) || !st.rules.length) errors.push(`stage "${id}": rules[] required`);
      else st.rules.forEach((r) => {
        try { validateRule(r); } catch (e) { errors.push(`stage "${id}": ${e.message}`); }
        exists(r.on_fail, `stage "${id}" rule ${r.id} on_fail`);
      });
      exists(st.next, `stage "${id}" next`);
    }
    if (st.type === 'external_call') {
      if (!isKnownService(st.service)) errors.push(`stage "${id}": unknown service "${st.service}"`);
      if (st.max_attempts !== undefined && !(st.max_attempts >= 1)) errors.push(`stage "${id}": max_attempts must be >= 1`);
      exists(st.next, `stage "${id}" next`);
      exists(st.on_exhausted, `stage "${id}" on_exhausted`);
    }
    if (st.type === 'branch') {
      if (!Array.isArray(st.branches) || !st.branches.length) errors.push(`stage "${id}": branches[] required`);
      else st.branches.forEach((b) => {
        try { validateRule(b); } catch (e) { errors.push(`stage "${id}": ${e.message}`); }
        exists(b.next, `stage "${id}" branch ${b.id} next`);
      });
      exists(st.default, `stage "${id}" default`); // a branch must always have a route
    }
    if (st.type === 'manual_review') {
      // Optional: where the workflow resumes after the human decision (so later rules still run).
      if (st.on_approve !== undefined) exists(st.on_approve, `stage "${id}" on_approve`);
      if (st.on_reject !== undefined) exists(st.on_reject, `stage "${id}" on_reject`);
    }
    if (st.type === 'terminal') {
      terminals += 1;
      if (!['APPROVED', 'REJECTED'].includes(st.outcome)) errors.push(`stage "${id}": outcome must be APPROVED or REJECTED`);
    }
  }
  if (!terminals) errors.push('at least one terminal stage is required');

  const outcomes = new Set(Object.values(stages).filter((s) => s && s.type === 'terminal').map((s) => s.outcome));
  if (Object.values(stages).some((s) => s && s.type === 'manual_review') && !(outcomes.has('APPROVED') && outcomes.has('REJECTED'))) {
    errors.push('a manual_review stage needs both an APPROVED and a REJECTED terminal stage');
  }

  // Graph checks: no cycles, nothing unreachable. (The engine step limit stays as a runtime safety net.)
  if (def.start && stages[def.start]) {
    const edges = buildGraph(stages);
    const cycle = findCycle(edges);
    if (cycle) errors.push(`workflow contains a cycle: ${cycle.join(' -> ')}`);
    const reachable = reachableFrom(def.start, edges);
    Object.keys(stages).filter((id) => !reachable.has(id)).forEach((id) => errors.push(`stage "${id}" is unreachable from start "${def.start}"`));
  }
  return errors;
}

module.exports = { validateDefinition };