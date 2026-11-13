'use strict';
const mongoose = require('mongoose');

/**
 * One document per (name, version). Versions are immutable: a rule change is a NEW version.
 * Requests pin the version they started with, so in-flight work is never affected.
 */
const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    version: { type: Number, required: true, min: 1 },
    definition: { type: mongoose.Schema.Types.Mixed, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
schema.index({ name: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('WorkflowDefinition', schema);
