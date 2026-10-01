const formatProblemDetails = require("../utils/problemDetails");

/**
 * Custom Error class for RFC 7807 compliant errors.
 * Extends the built-in Error class to include Problem Details fields.
 *
 * @invariant v1.0 - Instance is immutable after construction (frozen)
 * @invariant v1.0 - status is a valid HTTP status code (100-599)
 * @invariant v1.0 - type is a string when provided
 * @invariant v1.0 - retryable=true implies retryHint should be present
 * @invariant v1.0 - All properties are protected from mutation
 */
class AppError extends Error {
  /**
   * Validates HTTP status code is within valid range.
   *
   * @param {unknown} status - Status code to validate.
   * @throws {TypeError} If status is not a number or is out of valid range.
   * @static
   */
  static _validateStatus(status) {
    if (status !== undefined && status !== null) {
      if (typeof status !== 'number') {
        throw new TypeError(`AppError status must be a number, received: ${typeof status}`);
      }
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new RangeError(`AppError status must be an integer between 100 and 599, received: ${status}`);
      }
    }
  }

  /**
   * Validates type is a string when provided.
   *
   * @param {unknown} type - Type URI to validate.
   * @throws {TypeError} If type is not a string when provided.
   * @static
   */
  static _validateType(type) {
    if (type !== undefined && type !== null && typeof type !== 'string') {
      throw new TypeError(`AppError type must be a string, received: ${typeof type}`);
    }
  }

  /**
   * Validates retryable/retryHint consistency.
   *
   * @param {unknown} retryable - Retryable flag.
   * @param {unknown} retryHint - Retry hint.
   * @static
   */
  static _validateRetryConsistency(retryable, retryHint) {
    if (retryable === true && !retryHint) {
      // Log warning but don't throw - this is a soft invariant
      console.warn('[AppError] retryable=true without retryHint is discouraged');
    }
  }

  /**
   * Creates a new AppError instance.
   *
   * @param {Object} params
   * @param {string} params.type - A URI reference [RF3986] that identifies the problem type.
   * @param {string} params.title - A short, human-readable summary of the problem type.
   * @param {number} params.status - The HTTP status code (e.g., 400, 404, 500).
   * @param {string} params.detail - A human-readable explanation specific to this occurrence of the problem.
   * @param {string} [params.instance] - A URI reference that identifies the specific occurrence of the problem.
   * @param params.code
   * @param params.retryable
   * @param params.retryHint
   * @returns {AppError}
   */
  constructor(params) {
    const { title, context, status, type, retryable, retryHint } = params || {};

    // Validate inputs before construction (static methods)
    AppError._validateStatus(status);
    AppError._validateType(type);
    AppError._validateRetryConsistency(retryable, retryHint);

    super(title);
    this.name = this.constructor.name;

    // Delegate to canonical builder for ALL field assembly/defaulting
    const problem = formatProblemDetails({
      ...params,
      stack: undefined,
    });

    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.code = problem.code;
    this.retryable = problem.retryable;
    this.retryHint = problem.retry_hint;
    const hasFieldErrors = params && (Object.hasOwn ? Object.hasOwn(params, 'fieldErrors') : Object.prototype.hasOwnProperty.call(params, 'fieldErrors'));
    this.fieldErrors = hasFieldErrors ? params.fieldErrors : undefined;
    this.context = context || null;

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);

    // Freeze instance to prevent mutation (state invariant)
    Object.freeze(this);
    Object.freeze(this.context !== null ? this.context : this);
  }
}

/**
 * Error code indicating that a job lease fencing token was rejected.
 * This is returned when a worker attempts a write/complete operation after
 * its lease has expired or been reassigned. It is non-retryable by default.
 * @type {string}
 */
AppError.FENCING_TOKEN_REJECTED = 'FENCING_TOKEN_REJECTED';

module.exports = AppError;