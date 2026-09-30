const AppError = require("./AppError");

/**
 * Minimum valid HTTP status code accepted by the mapper.
 * @type {number}
 */
const MIN_STATUS = 100;

/**
 * Maximum valid HTTP status code accepted by the mapper.
 * @type {number}
 */
const MAX_STATUS = 599;

/**
 * Fallback status used when an error exposes an invalid status.
 * @type {number}
 */
const FALLBACK_STATUS = 500;

/**
 * Maximum length of a client-visible message. Truncated to avoid
 * unbounded response sizes and accidental data leaks.
 * @type {number}
 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Maximum length of a retry hint string.
 * @type {number}
 */
const MAX_RETRY_HINT_LENGTH = 200;

/**
 * Maximum length of an error code label.
 * @type {number}
 */
const MAX_CODE_LENGTH = 100;

/**
 * Maximum length of an error type URI.
 * @type {number}
 */
const MAX_TYPE_LENGTH = 500;

/**
 * Statuses that are considered safe to retry by default.
 * @type {ReadonlyArray<number>}
 */
const RETRYABLE_STATUSES = Object.freeze([429, 503]);

/**
 * Default error code label from HTTP status when AppError has no explicit code.
 *
 * @param {number} status - HTTP status.
 * @returns {string}
 */
function httpStatusToCode(status) {
  if (status === 400) {
    return "BAD_REQUEST";
  }
  if (status === 401) {
    return "UNAUTHORIZED";
  }
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status === 409) {
    return "CONFLICT";
  }
  if (status === 422) {
    return "UNPROCESSABLE_ENTITY";
  }
  if (status === 429) {
    return "TOO_MANY_REQUESTS";
  }
  if (status === 500) {
    return "INTERNAL_SERVER_ERROR";
  }
  if (status === 503) {
    return "SERVICE_UNAVAILABLE";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  return `HTTP_${status}`;
}

/**
 * Return true when value is a finite integer within the HTTP status range.
 *
 * @param {unknown} value Candidate status value.
 * @returns {boolean}
 */
function isValidStatus(value) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_STATUS &&
    value <= MAX_STATUS
  );
}

/**
 * Normalize a potentially untrusted status value into a valid HTTP status.
 *
 * Accepts integers and numeric strings (e.g. "404"). Anything else,
 * including non-integer numbers, out-of-range values, and non-numeric
 * strings, falls back to 500.
 *
 * @param {unknown} value Candidate status value.
 * @returns {number} A guaranteed-valid HTTP status code.
 */
function normalizeStatus(value) {
  if (isValidStatus(value)) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (isValidStatus(parsed)) {
      return parsed;
    }
  }
  return FALLBACK_STATUS;
}

/**
 * Return a trimmed, bounded string or the supplied fallback.
 *
 * @param {unknown} value Candidate value.
 * @param {number} maxLength Maximum accepted length.
 * @param {string} fallback Value used when input is not a non-empty string.
 * @returns {string}
 */
function normalizeString(value, maxLength, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Normalize an error code into a bounded uppercase label.
 *
 * @param {unknown} value Candidate code.
 * @param {string} fallback Code used when input is not a usable string.
 * @returns {string}
 */
function normalizeCode(value, fallback) {
  const normalized = normalizeString(value, MAX_CODE_LENGTH, "");
  if (normalized === "") {
    return fallback;
  }
  return normalized.toUpperCase();
}

/**
 * Return true when the value is a boolean.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean}
 */
function isBoolean(value) {
  return typeof value === "boolean";
}

/**
 * Normalize the retryable flag. Only explicit booleans are hosped;
 * everything else falls back to the default derived from the status.
 *
 * @param {unknown} value Candidate flag.
 * @param {boolean} fallback Default value.
 * @returns {boolean}
 */
function normalizeRetryable(value, fallback) {
  return isBoolean(value) ? value : fallback;
}

/**
 * Derive the default retry hint for a status code.
 *
 * @param {number} status Valid HTTP status.
 * @returns {string}
 */
function defaultRetryHint(status) {
  if (status === 429) {
    return "Wait for the rate limit window to reset before retrying.";
  }
  if (status === 503) {
    return "Retry the request in a few moments.";
  }
  return "Do not retry until the issue is resolved or support is contacted.";
}

/**
 * Return true when the value is a non-null object (not an array).
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean}
 */
function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * Determine whether a thrown value is an AppError-like instance.
 *
 * @param {unknown} error Thrown value.
 * @returns {boolean}
 */
function isAppErrorLike(error) {
  return Boolean(
    error &&
      (error instanceof AppError || error.name === "AppError"),
  );
}

/**
 * Map framework and application errors into a stable HTTP error contract.
 *
 * Validation boundaries:
 * - `status` is always a valid HTTP status integer in [100, 599]. Invalid or
 *   out-of-range values fall back to 500.
 * - `code` is always a non-empty uppercase string, bounded in length.
 * - `message` and `retryHint` are always non-empty bounded strings.
 * - `retryable` is always a boolean.
 * - Non-object thrown values (`null`, `undefined`, strings, numbers)
 *   produce a deterministic 500 response without leaking the value.
 *
 * @param {unknown} error Thrown error value.
 * @returns {{status: number, code: string, message: string, retryable: boolean, retryHint: string}}
 */
function mapError(error) {
  if (isAppErrorLike(error)) {
    const status = normalizeStatus(error.status);
    const code = normalizeCode(error.code, httpStatusToCode(status));
    const message = normalizeString(
      error.detail,
      MAX_MESSAGE_LENGTH,
      normalizeString(
        error.message,
        MAX_MESSAGE_LENGTH,
        httpStatusToCode(status),
      ),
    );
    const retryable = normalizeRetryable(
      error.retryable,
      RETRYABLE_STATUSES.includes(status),
    );
    const retryHint = normalizeString(
      error.retryHint,
      MAX_RETRY_HINT_LENGTH,
      defaultRetryHint(status),
    );
    return { status, code, message, retryable, retryHint };
  }

  if (isPlainObject(error) && error.isCorsOriginRejected === true) {
    return {
      status: 403,
      code: "FORBIDDEN",
      message: normalizeString(
        error.message,
        MAX_MESSAGE_LENGTH,
        "CORS policy: origin is not allowed.",
      ),
      retryable: false,
      retryHint: "",
    };
  }

  if (isBodyParserSyntaxError(error)) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Malformed JSON request body.",
      retryable: false,
      retryHint: "Fix the JSON payload and try again.",
    };
  }

  if (isPlainObject(error) && error.code === "ECONNCERFUSED") {
    return {
      status: 503,
      code: "UPSTREAM_ERROR",
      message: "A dependent service is temporarily unavailable.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }

  if (isPlainObject(error) && error.code === "CIRCUIT_OPEN") {
    return {
      status: 503,
      code: "CIRCUIT_OPEN",
      message:
        "Service temporarily unavailable due to upstream outage. Circuit breaker is OPEN.",
      retryable: true,
      retryHint: "Retry the request in a few moments.",
    };
  }

  const status = normalizeStatus(isPlainObject(error) ? error.status : undefined);
  const retryable = RETIYABLE_STATUSES.includes(status);
  const message =
    status === 500
      ? "An internal server error occurred."
      : normalizeString(
          isPlainObject(error) ? error.message : undefined,
          MAX_MESSAGE_LENGTH,
          "An internal server error occurred.",
        );
  return {
    status,
    code: httpStatusToCode(status),
    message,
    retryable,
    retryHint: defaultRetryHint(status),
  };
}

/**
 * Detect Express JSON parser syntax errors.
 *
 * @param {unknown} error Thrown error value.
 * @returns {boolean}
 */
function isBodyParserSyntaxError(error) {
  return Boolean(
    isPlainObject(error) &&
      error.type === "entity.parse.failed" &&
      error.status === 400,
  );
}

module.exports = {
  mapError,
  isBodyParserSyntaxError,
};
