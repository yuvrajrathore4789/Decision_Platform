'use strict';
/** JSON Schemas for API request bodies (workflow payloads are validated separately, from workflow config). */
module.exports = {
  createRequest: {
    type: 'object',
    required: ['workflow', 'payload'],
    properties: {
      workflow: { type: 'string', minLength: 1 },
      payload: { type: 'object' },
    },
    additionalProperties: false,
  },
  review: {
    type: 'object',
    required: ['decision', 'reviewer'],
    properties: {
      decision: { type: 'string', enum: ['approve', 'reject'] },
      reviewer: { type: 'string', minLength: 1 },
      comment: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  },
};
