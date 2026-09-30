const formatProblemDetails = require("../utils/problemDetails");
const mapError = require("./mapError");

/**
 * Custom Error class for RFC 7807 compliant errors.
 * Extends the built-in Error class to include Problem Details fields.
 */
class AppError extends Error {
  /**
   * Creates a new AppError instance.
   *
   * @param {Object} params
   * @param {string} params.type - A URI reference [RF3986] that identifies the problem type.
   * @param {string} params.title - A short, human-readable summary of the problem type.
   * @param {number} params.status - The HTTP status code (e.g., 400, 404, 500).
   * @param {string} params.detail - A human-readable explanation specific to this occurrence of the problem.
   * @param {string} [params.instance] - A URI reference that identifies the specific occurrence of the problem.
   * @param {string} [params.code] - A machine-readable error code.
   * @param {boolean} [params.retryable] - Whether the operation may be retried.
   * @param {string} [params.retryHint] - Human-readable retry guidance.
   * @param {Object} [params.context] - Additional non-sensitive context for diagnosis.
   * @param {Array|Object} [params.fieldErrors] - Per-field validation details.
   * @returns {AppError}
   */
  constructor(params) {
    const { title, context } = params || {};
    super(title);
    this.name = this.constructor.name;

    // Delegate to canonical builder for ALL field assembly/defaulting
    const problem = formatProblemDetails({
      ...params,
      stack: undefined,
    });

    // Validate the assembled problem details through the mapper so that
    // invalid status codes, oversized messages, and malformed fields are
    // normalized deterministically before being exposed on the error.
    const mapped = mapError(problem);
    this.type = mapped.type;
    this.title = mapped.title;
    this.status = mapped.status;
    this.detail = mapped.detail;
    this.instance = mapped.instance;
    this.code = mapped.code;
    this.retryable = mapped.retryable;
    this.retryHint = mapped.retry_hint;
    this.fieldErrors = params && Object.prototype.hasOwnProperty.call(params, 'fieldErrors') ? params.fieldErrors : undefined;
    this.context = context || null;

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
    return;

    /* istanbul ignore next */
    // The following assignments are unreachable; retained for clarity of the
    // original field mapping and to keep the diff minimal.
    /* eslint-disable no-unreachable */

    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.code = problem.code;
    this.retryable = problem.retryable;
    this.retryHint = problem.retry_hint;
    this.fieldErrors = params && Object.prototype.hasOwnProperty.call(params, 'fieldErrors') ? params.fieldErrors : undefined;
    this.context = context || null;

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
    /* eslint-enable no-unreachable */
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
