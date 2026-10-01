'use strict';

/**
 * @fileoverview Structured error for KYC webhook handlers.
 *
 * Carries an HTTP status and a machine-readable error code through the
 * Express error chain so that {@link module:middleware/kycWebhookErrorHandler}
 * can produce a consistent structured response without per-handler
 * duplication.
 *
 * @module errors/KycWebhookError
 */

/**
 * Lowest HTTP status accepted by {@link KycWebhookError}.
 *
 * The error is always a failure carrying a client- or server-error status;
 * anything outside the 4xx/5xx range would be misreported by the shared error
 * handler, which uses this value verbatim as `res.status(...)`.
 *
 * @type {number}
 */
const MIN_STATUS = 400;

/**
 * Highest HTTP status accepted by {@link KycWebhookError}.
 *
 * @type {number}
 */
const MAX_STATUS = 599;

/**
 * Renders a value for an error message by shape, never by content.
 *
 * @description Reports only the kind and size of a value. Webhook handlers
 * routinely build messages out of provider-controlled payload fields, so the
 * rejection message must stay diagnosable without echoing whatever was passed
 * into a message or a log line.
 * @param {unknown} value - The offending value.
 * @returns {string} Short, non-sensitive description of the value.
 */
function describeValue(value) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value.length === 0 ? 'an empty string' : `a string (${value.length} characters)`;
  }
  if (Array.isArray(value)) {
    return `an array (${value.length} items)`;
  }
  if (typeof value === 'object') {
    return 'an object';
  }
  return `a ${typeof value}`;
}

/**
 * Locks a value onto the instance as a read-only, non-configurable property.
 *
 * @description This is what makes the error's routing fields *invariants*
 * rather than ordinary properties. The error is handed to a shared handler
 * that later reads `status` (to pick the response code and the retry hint) and
 * `code` (to decide retryability), so a later `err.status = 500` anywhere in
 * the chain would silently desync the response from the failure that actually
 * occurred. `enumerable` stays true to preserve the existing serialisation
 * footprint.
 * @param {object} target - The error instance being constructed.
 * @param {string} property - Property name to define.
 * @param {unknown} value - Frozen value.
 * @returns {void} Returns nothing.
 */
function defineInvariant(target, property, value) {
  Object.defineProperty(target, property, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

/**
 * Asserts that the message is a string.
 *
 * @description An empty message is deliberately allowed — the handler renders
 * it as an empty `detail`, which existing callers and tests rely on — but a
 * non-string would be coerced by `Error` into `"[object Object]"` and reach
 * clients as a meaningless detail.
 * @param {unknown} message - Candidate message.
 * @returns {void} Returns nothing when the message is valid.
 * @throws {TypeError} When the message is not a string.
 */
function assertValidMessage(message) {
  if (typeof message !== 'string') {
    throw new TypeError(
      `KycWebhookError message must be a string, received ${describeValue(message)}.`,
    );
  }
}

/**
 * Asserts that the status is a valid HTTP error status.
 *
 * @description Rejects non-integers (`NaN`, `404.5`), numeric strings, and
 * out-of-range values, all of which would otherwise be passed straight to
 * `res.status(...)` — producing a wrong or throwing response at the very point
 * the error is meant to be reported.
 * @param {unknown} status - Candidate status.
 * @returns {void} Returns nothing when the status is valid.
 * @throws {TypeError} When the status is not an integer in the 400-599 range.
 */
function assertValidStatus(status) {
  const isInteger = Number.isInteger(status);
  if (!isInteger || status < MIN_STATUS || status > MAX_STATUS) {
    throw new TypeError(
      `KycWebhookError status must be an integer between ${MIN_STATUS} and ${MAX_STATUS}, received ${describeValue(status)}.`,
    );
  }
}

/**
 * Asserts that the error code is either absent or a non-empty string.
 *
 * @description `undefined` is an accepted, meaningful value: the handler omits
 * `code` from the problem body when it is absent, and existing callers rely on
 * that. Any other type is rejected because the code is used as a lookup key
 * for retryability and as a metrics label, where a non-string silently fails
 * to match.
 * @param {unknown} code - Candidate code.
 * @returns {void} Returns nothing when the code is valid.
 * @throws {TypeError} When the code is neither undefined nor a non-empty string.
 */
function assertValidCode(code) {
  if (code === undefined) {
    return;
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError(
      `KycWebhookError code must be a non-empty string or undefined, received ${describeValue(code)}.`,
    );
  }
}

/**
 * Lightweight error class that pairs an HTTP status with an application
 * error code for KYC webhook ingestion and listing endpoints.
 *
 * The constructor is the single place where this error's invariants are
 * established: a valid HTTP error status, an optional non-empty string code,
 * and a string message. Once set, `status`, `code`, and `name` cannot be
 * reassigned, so the response the handler builds always reflects the failure
 * that was actually raised.
 */
class KycWebhookError extends Error {
  /**
   * Creates a KYC webhook error whose status, code, and name are immutable.
   *
   * @param {string} message - Human-readable error description. May be empty.
   * @param {number} status - HTTP status code, an integer in the 400-599 range (e.g. 400, 401, 403, 429, 500, 503).
   * @param {string} [code] - Machine-readable error code (e.g. 'missing_secret'). Omit when there is no code to report.
   * @returns {KycWebhookError} The constructed error.
   * @throws {TypeError} When the message is not a string, the status is not an
   *   integer in range, or the code is neither undefined nor a non-empty string.
   */
  constructor(message, status, code) {
    // Validate before `super()` so a rejected construction never yields a
    // half-initialised error to the caller's catch block.
    assertValidMessage(message);
    assertValidStatus(status);
    assertValidCode(code);

    super(message);

    defineInvariant(this, 'name', 'KycWebhookError');
    defineInvariant(this, 'status', status);
    defineInvariant(this, 'code', code);
  }
}

module.exports = KycWebhookError;
module.exports.MIN_STATUS = MIN_STATUS;
module.exports.MAX_STATUS = MAX_STATUS;
