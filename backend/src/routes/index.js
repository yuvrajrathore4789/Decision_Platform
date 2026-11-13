'use strict';
const router = require('express').Router();
const mongoose = require('mongoose');

router.get('/health', (req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});
router.use('/api/requests', require('./request.routes'));
router.use('/api/workflows', require('./workflow.routes'));

module.exports = router;
