'use strict';
const Ajv = require('ajv');
const { validateRule } = require('../engine/rulesEngine');
const { KNOWN_SERVICES } = require('../adapters/dependencyAdapter');
const { STAGE_TYPES } = require('./constants');

const ajv = new Ajv({ allErrors: true, strict: false });

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
      if (!KNOWN_SERVICES.includes(st.service)) errors.push(`stage "${id}": unknown service "${st.service}"`);
      if (st.max_attempts !== undefined && !(st.max_attempts >= 1)) errors.push(`stage "${id}": max_attempts must be >= 1`);
      exists(st.next, `stage "${id}" next`);
      exists(st.on_exhausted, `stage "${id}" on_exhausted`);
    }
    if (st.type === 'terminal') {
      terminals += 1;
      if (!['APPROVED', 'REJECTED'].includes(st.outcome)) errors.push(`stage "${id}": outcome must be APPROVED or REJECTED`);
    }
  }
  if (!terminals) errors.push('at least one terminal stage is required');
  return errors;
}

module.exports = { validateDefinition };
