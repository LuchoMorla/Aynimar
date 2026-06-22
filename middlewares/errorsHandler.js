const { ValidationError } = require('sequelize');
const boom = require('@hapi/boom');
const log = require('../libs/logger');
const Sentry = require('../libs/sentry');

function logErrors(err, req, res, next) {
  // Sentry.setupExpressErrorHandler runs before this and has already captured the event.
  // We grab its event ID so the structured log line and the Sentry event are correlated.
  const sentryEventId = Sentry.lastEventId?.() ?? undefined;
  log.error('unhandled_error', {
    err_message: err.message,
    path:        req.path,
    method:      req.method,
    stack:       err.stack?.split('\n').slice(0, 3).join(' | '),
    ...(sentryEventId && { sentry_event_id: sentryEventId }),
  });
  next(err);
}

function errorHandler(err, req, res, next) {
  res.status(500).json({ message: err.message });
}

function boomErrorHandler(err, req, res, next) {
    if (err.isBoom) {
        const { output } = err;
        return res.status(output.statusCode).json(output.payload);
    }
    next(err);
}

function ormErrorHandler(err, req, res, next) {
    if (err instanceof ValidationError) {
      return res.status(409).json({
        statusCode: 409,
        message: err.name,
        errors: err.errors
      });
    }
    next(err);
  }

module.exports = {logErrors, errorHandler, boomErrorHandler, ormErrorHandler }