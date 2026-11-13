'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const badRequest = (msg, details) => new AppError(400, 'VALIDATION_ERROR', msg, details);
const notFound = (msg) => new AppError(404, 'NOT_FOUND', msg);
const conflict = (msg, details) => new AppError(409, 'CONFLICT', msg, details);
const unprocessable = (msg, details) => new AppError(422, 'UNPROCESSABLE', msg, details);

class DependencyError extends Error {
  constructor(service, message) {
    super(`${service}: ${message}`);
    this.service = service;
  }
}

module.exports = { AppError, badRequest, notFound, conflict, unprocessable, DependencyError };