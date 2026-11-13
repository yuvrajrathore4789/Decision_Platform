'use strict';
const router = require('express').Router();
const ctrl = require('../controllers/workflow.controller');

router.get('/', ctrl.list);
router.post('/', ctrl.register);
router.get('/:name', ctrl.getLatest);
router.get('/:name/:version', ctrl.getVersion);
router.post('/:name/:version/activate', ctrl.activate);

module.exports = router;