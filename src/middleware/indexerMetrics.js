'use strict';

/**
 * @fileoverview Instrumentation wrapper for the indexer endpoint.
 *
 * Wraps the async Express handler for GET /api/admin/indexer/events so that
 * every request records:
 *   - request duration (histogram, labelled by status class)
 *   - a request count (counter, labelled by status class)
 *   - an error count on failure (counter, labelled by bounded cause)
 *   - a single structured log line (no PII: outcome only)
 *
 * Labels are bounded to keep Prometheus time-series cardinality fixed.
 *
 * @module middleware/indexerMetrics
 */

const {
  indexerRequestDurationSeconds,
  indexerRequestsTotal,
  indexerRequestErrorsTotal,
  normalizeIndexerStatusClass,
  normalizeIndexerCause,
} = require('../metrics');
const logger = require('../logger');

/**
 * Status classes that the instrumentation understands. Anything else is
 * normalized to 'unknown' by {@link normalizeIndexerStatusClass}.
 * @type {Set<string>}
 */
const KNOWN_STATUS_CLASSES = new Set(['2xx', '30x', '4xx', '5xx']);

/**
 * Records metrics and a structured log for one completed indexer request.
 *
 * Kept separate from {@link instrumentIndexer} so it can be unit-tested in
 * isolation against each status class without driving a full HTTP request.
 *
 * Invariants:
 *   - Always records exactly one duration observation and one request count.
 *   - Error counter is incremented at most once, and only for a bounded cause.
 *   - Never logs raw error messages or other PII.
 *
 * @param {object} params
 * @param {number} params.statusCode - Final HTTP status code.
 * @param {number} params.durationSeconds - Wall-clock duration in seconds.
 * @param {unknown} [params.error] - Error thrown by the handler, if any.
 * @param {import('express').Request} [params.req] - Request, for a scoped logger.
 * @returns {void}
 */
function recordIndexerOutcome({ statusCode, durationSeconds, error, req }) {
  // Normalize inputs so a malformed status or duration cannot create an
  // unbounded label or a NaN observation.
  const safeStatusCode = Number.isInteger(statusCode) ? statusCode : 0;
  const statusClass = normalizeIndexerStatusClass(safeStatusCode);
  const boundedStatusClass = KNOWN_STATUS_CLASSES.has(statusClass)
    ? statusClass
    : 'unknown';
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds >= 0
    ? durationSeconds
    : 0;

  indexerRequestDurationSeconds.labels(boundedStatusClass).observe(safeDuration);
  indexerRequestsTotal.labels(boundedStatusClass).inc();

  const cause = normalizeIndexerCause(error, safeStatusCode);
  if (cause !== 'none') {
    indexerRequestErrorsTotal.labels(cause).inc();
  }

  // Structured log – safe fields only. Never log file contents, raw error messages,
  // or other data that could contain PII.
  const log = (req && typeof logger.createRequestLogger === 'function')
    ? logger.createRequestLogger(req)
    : logger;
  const fields = {
    statusClass: boundedStatusClass,
    statusCode: safeStatusCode,
    durationSeconds: Number(safeDuration.toFixed(6)),
    cause,
  };

  if (boundedStatusClass === '5xx') {
    log.error(fields, 'indexer request failed');
  } else if (boundedStatusClass === '4xx') {
    log.warn(fields, 'indexer request rejected');
  } else {
    log.info(fields, 'indexer request completed');
  }
}

/**
 * Wraps the async indexer handler with metrics + structured logging.
 *
 * The wrapped handler runs normally. Duration is measured from entry to the
 * moment the response finishes (`res.on('finish')`), so the recorded status&
 * code is the one actually sent. If the handler throws, the error is recorded
 * and re-thrown to the next error middleware.
 *
 * Compatibility contracts (preserved):
 *   - Returns a function with the same (req, res, next) async signature.
 *   - Resolves to the handler's resolved value (typically undefined).
 *   - Rejects with the handler's error after forwarding it to `next`.
 *   - Records exactly once per request, even if `finish` fires multiple times
 *     or the response is already finished before the listener is attached.
 *   - Never mutates the request or response beyond the private `_error` stash.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>} handler
 * @returns {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<void>}
 */
function instrumentIndexer(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('instrumentIndexer requires a handler function');
  }

  return async function instrumentedIndexerHandler(req, res, next) {
    const startNs = process.hrtime.bigint();
    let recorded = false;

    // Ensure locals exists before any listener can read it, so the finish
    // handler never observes an undefined stash on early-finished responses.
    res.locals = res.locals || {};

    // Single source of truth: record on response finish, when the final status
    // code is known. A thrown handler stashes its error on res.locals so the
    // finish listener can classify the cause consistently with that status.
    const onFinish = () => {
      if (recorded) { return; }
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      recordIndexerOutcome({
        statusCode: res.statusCode,
        durationSeconds,
        error: res.locals && res.locals._error,
        req,
      });
    };

    res.on('finish', onFinish);

    // If the response was already finished before the listener was attached
    // (e.g. a cache or upstream short-circuit), the `finish` event will not
    // fire again. Record immediately so the outcome is not silently lost.
    if (res.finished) {
      onFinish();
    }

    try {
      await handler(req, res, next);
    } catch (err) {
      // Stash the error so the finish listener can classify it. Preserve any
      // existing locals so we do not clobber upstream state.
      res.locals._error = err;
      // Ensure the outcome is recorded even if the error middleware never sends a
      // response (e.g. a crash or a stream that never ends). The `finish`
      // listener will still record once the response actually finishes.
      next(err);
    }
  };
}

module.exports = {
  recordIndexerOutcome,
  instrumentIndexer,
  knownStatusClasses: KNOWN_STATUS_CLASSES,
};
