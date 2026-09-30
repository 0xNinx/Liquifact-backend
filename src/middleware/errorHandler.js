const AppError = require('../errors/AppError');
const { mapError } = require('../errors/mapError');
const logger = require('../logger');
const { captureException } = require('../observability/sentry');

/**
 * Express 404 handler that forwards a structured not-found error.
 *
 * @param {import('express').Request} req Request object.
 * @param {import('express').Response} _res Response object.
 * @param {import('express').NextFunction} next Next middleware.
 * @returns {void}
 */
function notFoundHandler(req, _res, next) {
  next(
    new AppError({
      type: 'https://liquifact.com/probs/not-found',
      title: 'Not Found',
      status: 404,
      detail: `Route ${req.method} ${req.path} was not found.`,
      instance: req.originalUrl,
    }),
  );
}

/**
 * Centralized terminal error handler.
 *
 * @param {unknown} error Thrown error value.
 * @param {import('express').Request} req Request object.
 * @param {import('express').Response} res Response object.
 * @param {import('express').NextFunction} _next Next middleware.
 * @returns {void}
 */
function errorHandler(error, req, res, _next) {
  const mapped = mapError(error);
  const correlationId = req.correlationId || req.id || 'unknown';

  logError(error, correlationId, req);
  captureException(error, req);

  res.status(mapped.status).json({
    error: {
      code: mapped.code,
      message: mapped.message,
      correlation_id: correlationId,
      retryable: mapped.retryable,
      retry_hint: mapped.retryHint,
    },
  });
}

/**
 * Log the error with correlation context without exposing internals to clients.
 *
 * @param {unknown} error Thrown error value.
 * @param {string} correlationId Request correlation ID.
 * @param {import('express').Request} req Request object.
 * @returns {void}
 */
function logError(error, correlationId, req) {
  const message =
    error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : 'Non-error value thrown';

  const requestLogger = req?.log || logger;
  requestLogger.error({ err: error, requestId: correlationId, correlationId }, message);
}

module.exports = errorHandler;
module.exports.errorHandler = errorHandler;
module.exports.notFoundHandler = notFoundHandler;
module.exports.logError = logError;
