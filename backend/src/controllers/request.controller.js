'use strict';
const requestService = require('../services/request.service');
const audit = require('../services/audit.service');
const asyncHandler = require('../utils/asyncHandler');
const { toSummary } = require('../utils/presenters');

exports.create = asyncHandler(async (req, res) => {
  const { workflow, payload } = req.body;
  const { request, duplicate } = await requestService.submit({
    workflow,
    payload,
    idempotencyKey: req.get('Idempotency-Key') || undefined,
  });
  if (duplicate) res.set('Idempotent-Replay', 'true');
  res.status(duplicate ? 200 : 201).json({ duplicate, request: toSummary(request) });
});

exports.list = asyncHandler(async (req, res) => {
  const { total, items } = await requestService.list(req.query);
  res.json({ total, items: items.map(toSummary) });
});

exports.get = asyncHandler(async (req, res) => {
  res.json(toSummary(await requestService.getById(req.params.id)));
});

exports.getAudit = asyncHandler(async (req, res) => {
  const doc = await requestService.getById(req.params.id);
  res.json({ requestId: String(doc._id), stateHistory: doc.stateHistory, auditLog: doc.auditLog, integrity: audit.verifyChain(doc.auditLog) });
});

exports.getExplanation = asyncHandler(async (req, res) => {
  res.json(audit.explain(await requestService.getById(req.params.id)));
});

exports.retry = asyncHandler(async (req, res) => {
  res.json(toSummary(await requestService.retry(req.params.id)));
});

exports.review = asyncHandler(async (req, res) => {
  res.json(toSummary(await requestService.review(req.params.id, req.body)));
});