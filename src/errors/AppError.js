"use strict";

const formatProblemDetails = require("../utils/problemDetails");

/**
 * Lowest HTTP status code accepted by {@link AppError}.
 *
 * `AppError` models a *failure* response, so its status must live in the
 * RFC 9110 4xx/5xx range. Bounding it here keeps values such as `200`, `0`,
 * `NaN`, or the string `"404"` from ever reaching `res.status(...)` in the
 * error middleware, where they would either be silently coerced or throw.
 *
 * @type {number}
 */
const MIN_ERROR_STATUS = 400;

/**
 * Highest HTTP status code accepted by {@link AppError}.
 *
 * @type {number}
 */
const MAX_ERROR_STATUS = 599;

/**
 * Problem-details fields that must hold a string when they are supplied.
 *
 * A non-string here (a number, an object, an array) would be serialised onto
 * the wire as-is, producing a problem+json document that violates the RFC 7807
 * member types, so it is rejected at construction instead.
 *
 * @type {readonly string[]}
 */
const STRING_FIELDS = Object.freeze(["type", "title", "detail", "instance", "code", "retryHint"]);

/**
 * Determines whether a value is a usable problem-details input.
 *
 * @description Accepts only non-null, non-array objects. `null`, arrays, and
 * primitives are rejected because spreading them into the canonical builder
 * silently produces a default problem instead of surfacing the caller's bug.
 * @param {unknown} value - Candidate input.
 * @returns {boolean} True when the value is a plain object.
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Renders a value for an error message by shape, never by content.
 *
 * @description Deliberately reports only the kind and size of the value. A
 * caller that passes the wrong thing often passes something like an object of
 * credentials or a bearer token, so the rejection message must stay
 * diagnosable without copying the offending value into a message or a log
 * line. String length is reported because "empty" versus "populated" is the
 * distinction that actually helps debugging.
 * @param {unknown} value - The offending value.
 * @returns {string} Short, non-sensitive description of the value.
 */
function describeValue(value) {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value.length === 0 ? "an empty string" : `a string (${value.length} characters)`;
  }
  if (Array.isArray(value)) {
    return `an array (${value.length} items)`;
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value}`;
}

/**
 * Enforces the {@link AppError} constructor's validation boundary.
 *
 * @description Validates only the fields that are actually supplied — an
 * absent field is meaningful (it means "use the canonical default"), so
 * `undefined` is always permitted and only a *present* value of the wrong
 * type or range is rejected. This keeps every existing call site that omits
 * `status`, `title`, or the extension fields working unchanged.
 * @param {unknown} params - Raw constructor argument.
 * @returns {void} Returns nothing when `params` is valid.
 * @throws {TypeError} When `params` is not a plain object, or when `status`,
 *   a problem-details string field, `retryable`, or `fieldErrors` is present
 *   with an invalid type or value.
 */
function assertValidParams(params) {
  if (!isPlainObject(params)) {
    throw new TypeError(
      `AppError requires a plain object of problem-details fields, received ${describeValue(params)}.`,
    );
  }

  if (params.status !== undefined) {
    const statusIsInteger = Number.isInteger(params.status);
    if (!statusIsInteger || params.status < MIN_ERROR_STATUS || params.status > MAX_ERROR_STATUS) {
      throw new TypeError(
        `AppError status must be an integer between ${MIN_ERROR_STATUS} and ${MAX_ERROR_STATUS}, received ${describeValue(params.status)}.`,
      );
    }
  }

  for (const field of STRING_FIELDS) {
    const value = params[field];
    if (value !== undefined && typeof value !== "string") {
      throw new TypeError(
        `AppError ${field} must be a string when provided, received ${describeValue(value)}.`,
      );
    }
  }

  if (params.retryable !== undefined && typeof params.retryable !== "boolean") {
    throw new TypeError(
      `AppError retryable must be a boolean when provided, received ${describeValue(params.retryable)}.`,
    );
  }

  if (params.fieldErrors !== undefined && !isPlainObject(params.fieldErrors)) {
    throw new TypeError(
      `AppError fieldErrors must be a plain object when provided, received ${describeValue(params.fieldErrors)}.`,
    );
  }
}

/**
 * Custom Error class for RFC 7807 compliant errors.
 * Extends the built-in Error class to include Problem Details fields.
 *
 * The constructor is a validation boundary: it rejects a non-object argument
 * and out-of-range or wrong-typed fields with a `TypeError` rather than
 * silently degrading to an `about:blank`/`500` problem, which would hide the
 * caller's mistake behind a plausible-looking response. Valid input is still
 * assembled exclusively by the canonical problem-details builder.
 */
class AppError extends Error {
  /**
   * Creates a new AppError instance.
   *
   * @param {Object} params - Problem-details fields for this error.
   * @param {string} [params.type] - A URI reference [RF3986] that identifies the problem type.
   * @param {string} [params.title] - A short, human-readable summary of the problem type.
   * @param {number} [params.status] - The HTTP status code, an integer in the 400-599 range (e.g. 400, 404, 500).
   * @param {string} [params.detail] - A human-readable explanation specific to this occurrence of the problem.
   * @param {string} [params.instance] - A URI reference that identifies the specific occurrence of the problem.
   * @param {string} [params.code] - Machine-readable application error code.
   * @param {boolean} [params.retryable] - Whether retrying the operation is appropriate.
   * @param {string} [params.retryHint] - Guidance on how and when to retry.
   * @param {Object} [params.fieldErrors] - Field-level validation messages, when applicable.
   * @param {Object} [params.context] - Additional non-serialised context for logging.
   * @returns {AppError} The constructed error.
   * @throws {TypeError} When `params` is not a plain object, or a supplied
   *   field has an invalid type or value.
   */
  constructor(params) {
    assertValidParams(params);

    const { title, context } = params;
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

    // Only define `fieldErrors` when the caller actually supplied it. Assigning
    // `undefined` unconditionally would still create an own enumerable
    // property, so every AppError would advertise a fieldErrors key that
    // carries no information (and `'fieldErrors' in err` could never be false).
    if (Object.prototype.hasOwnProperty.call(params, "fieldErrors")) {
      this.fieldErrors = params.fieldErrors;
    }

    this.context = context || null;

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
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
module.exports.MIN_ERROR_STATUS = MIN_ERROR_STATUS;
module.exports.MAX_ERROR_STATUS = MAX_ERROR_STATUS;
