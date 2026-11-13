'use strict';
const Ajv = require('ajv');
const { badRequest } = require('../utils/errors');

const ajv = new Ajv({ allErrors: true, strict: false });

/** validateBody(schema) -> Express middleware that rejects bodies not matching the JSON Schema. */
module.exports = (schema) => {
  const validate = ajv.compile(schema);
  return (req, res, next) => {
    if (validate(req.body)) return next();
    return next(badRequest('Invalid request body', validate.errors.map((e) => ({ path: e.instancePath || '/', message: e.message }))));
  };
};
