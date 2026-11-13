'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/request.controller');
const validateBody = require('../middleware/validateBody');
const schemas = require('../validators/schemas');

router.post('/', validateBody(schemas.createRequest), ctrl.create);
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.get('/:id/audit', ctrl.getAudit);
router.get('/:id/explanation', ctrl.getExplanation);
router.post('/:id/retry', ctrl.retry);
router.post('/:id/review', validateBody(schemas.review), ctrl.review);

module.exports = router;
