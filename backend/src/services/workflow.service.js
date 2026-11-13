'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const WorkflowDefinition = require('../models/WorkflowDefinition');
const { validateDefinition } = require('../utils/workflowValidator');
const { badRequest, notFound, conflict } = require('../utils/errors');
const logger = require('../utils/logger');

const WORKFLOW_DIR = path.join(__dirname, '..', '..', 'config', 'workflows');

/** Load YAML files and insert any (name, version) that is not stored yet. Never overwrites: versions are immutable. */
async function seedFromFiles(dir = WORKFLOW_DIR) {
  const seeded = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const def = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
    const errors = validateDefinition(def);
    if (errors.length) throw new Error(`Invalid workflow file ${file}: ${errors.join('; ')}`); // fail fast at startup
    const res = await WorkflowDefinition.updateOne(
      { name: def.workflow, version: def.version },
      { $setOnInsert: { name: def.workflow, version: def.version, definition: def, active: true } },
      { upsert: true }
    );
    if (res.upsertedCount) { seeded.push(`${def.workflow}@v${def.version}`); }
  }
  if (seeded.length) logger.info(`Seeded workflows: ${seeded.join(', ')}`);
  return seeded;
}

/** Register a new workflow version at runtime (this is how rules change without a deploy). */
async function register(def) {
  const errors = validateDefinition(def);
  if (errors.length) throw badRequest('Invalid workflow definition', errors);
  try {
    const doc = await WorkflowDefinition.create({ name: def.workflow, version: def.version, definition: def });
    return doc;
  } catch (e) {
    if (e.code === 11000) throw conflict(`Workflow ${def.workflow} v${def.version} already exists; versions are immutable, publish a new version`);
    throw e;
  }
}

async function getActive(name) {
  const doc = await WorkflowDefinition.findOne({ name, active: true }).sort({ version: -1 });
  if (!doc) throw notFound(`Workflow "${name}" not found`);
  return doc.definition;
}

async function getVersion(name, version) {
  const doc = await WorkflowDefinition.findOne({ name, version: Number(version) });
  if (!doc) throw notFound(`Workflow "${name}" v${version} not found`);
  return doc.definition;
}

async function list() {
  const docs = await WorkflowDefinition.find().sort({ name: 1, version: -1 });
  return docs.map((d) => ({ name: d.name, version: d.version, active: d.active, stages: Object.keys(d.definition.stages), createdAt: d.createdAt }));
}

/**
 * Make one stored version THE live version (rollback or roll-forward). Nothing is rewritten: versions stay immutable,
 * only the `active` flag moves. In-flight requests keep their pinned version either way.
 */
async function activate(name, version) {
  const target = await WorkflowDefinition.findOne({ name, version: Number(version) });
  if (!target) throw notFound(`Workflow "${name}" v${version} not found`);
  const previous = await WorkflowDefinition.findOne({ name, active: true }).sort({ version: -1 });
  await WorkflowDefinition.updateOne({ _id: target._id }, { $set: { active: true } }); // activate first: there is never a moment with no live version
  await WorkflowDefinition.updateMany({ name, _id: { $ne: target._id } }, { $set: { active: false } });
  logger.info(`Workflow ${name}: active version is now v${target.version} (was ${previous ? `v${previous.version}` : 'none'})`);
  return { name, version: target.version, previousVersion: previous ? previous.version : null };
}

module.exports = { seedFromFiles, register, getActive, getVersion, list, activate };