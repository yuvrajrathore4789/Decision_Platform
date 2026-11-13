'use strict';
const { notFound } = require('../utils/errors');
module.exports = (req, res, next) => next(notFound(`Route ${req.method} ${req.originalUrl} not found`));
