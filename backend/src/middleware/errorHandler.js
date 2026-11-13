'use strict';
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

/** Central error handler: every error leaves the API in the same JSON shape. */
// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err.type === 'entity.parse.failed') {
    status = 400; code = 'INVALID_JSON'; message = 'Request body is not valid JSON';
  } else if (err.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large';
  } else if (err.name === 'VersionError') {
    // optimistic concurrency: someone else modified the document between our read and write
    status = 409; code = 'CONCURRENT_MODIFICATION'; message = 'Request was modified concurrently; retry';
  } else if (err.name === 'ValidationError' || err.name === 'CastError') {
    status = 400; code = 'VALIDATION_ERROR'; message = err.message;
  }

  if (status >= 500) logger.error(err);
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
};
