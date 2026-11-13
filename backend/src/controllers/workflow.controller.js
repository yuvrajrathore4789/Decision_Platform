'use strict';
const workflowService = require('../services/workflow.service');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (req, res) => res.json(await workflowService.list()));

exports.getLatest = asyncHandler(async (req, res) => res.json(await workflowService.getActive(req.params.name)));

exports.getVersion = asyncHandler(async (req, res) => res.json(await workflowService.getVersion(req.params.name, req.params.version)));

exports.register = asyncHandler(async (req, res) => {
  const doc = await workflowService.register(req.body);
  res.status(201).json({ name: doc.name, version: doc.version, message: 'Workflow version registered. New requests use it; in-flight requests keep their pinned version.' });
});
