'use strict';

const AppError = require('./AppError');

// Snapshot Object.prototype.hasOwnProperty once so prototype-pollution on
// Object.prototype cannot swap in a forged implementation at call time.
const _hasOwn = Object.prototype.hasOwnProperty;
const _hasOwnProp = (obj, key) => _hasOwn.call(obj, key);

/**
 * Default error code label from HTTP status when AppError has no explicit code.
 *
 * @param {number} status - HTTP status.
 * @returns {string}
 */
function httpStatusToCode(status) {
  if (status === 400) {
    return 'BAD_REQUEST';
  }
  if (status === 401) {
    return 'UNAUTHORIZED';
  }
  if (status === 403) {
    return 'FORBIDDEN';
  }
  if (status === 409) {
    return 'CONFLICT';
  }
  if (status === 422) {
    return 'UNPROCESSABLE_ENTITY';
  }
  if (status === 429) {
    return 'TOO_MANY_REQUESTS';
  }
  if (status === 500) {
    return 'INTERNAL_SERVER_ERROR';
  }
  if (status === 503) {
    return 'SERVICE_UNAVAILABLE';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  return `HTTP_${status}`;
}

/**
 * Safely read a single property from an unknown value without triggering a
 * getter more than once and without being fooled by prototype-pollution.
 *
 * - Returns `undefined` for null / non-object / non-function inputs.
 * - Only returns the value when the property is an OWN property of the object
 *   OR when `allowInherited` is explicitly true (needed for Error subclasses
 *   that set properties on the prototype chain, e.g. `name`).
 * - Swallows any exception thrown by a getter so adversarial objects cannot
 *   cause mapError itself to throw.
 *
 * @param {unknown} obj - Value to read from.
 * @param {string}  key - Property key.
 * @param {boolean} [allowInherited=false] - When true, inherited properties
 *   are also returned (used for Error built-ins like `.message`).
 * @returns {unknown}
 */
function _safeProp(obj, key, allowInherited = false) {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return undefined;
  }
  try {
    // Only look at own properties unless the caller explicitly allows inherited
    // ones.  This prevents a polluted `Object.prototype.isCorsOriginRejected`
    // from matching unrelated errors.
    if (!allowInherited && !_hasOwnProp(obj, key)) {
      return undefined;
    }
    return obj[key];
  } catch {
    // Defensive: getter threw — treat as absent.
    return undefined;
  }
}

/**
 * Snapshot the properties of an unknown error object once, atomically, so
 * that concurrent mutation cannot make different branches see different values
 * for the same field.  All downstream logic reads from the snapshot.
 *
 * @param {unknown} error - Thrown value.
 * @returns {{
 *   isObject: boolean,
 *   isAppError: boolean,
 *   name: unknown,
 *   status: unknown,
 *   code: unknown,
 *   message: unknown,
 *   detail: unknown,
 *   retryable: unknown,
 *   retryHint: unknown,
 *   isCorsOriginRejected: unknown,
 *   type: unknown,
 *   details: unknown,
 * }}
 */
function _snapshotError(error) {
  const isObject =
    error !== null && (typeof error === 'object' || typeof error === 'function');

  if (!isObject) {
    return {
      isObject: false,
      isAppError: false,
      name: undefined,
      status: undefined,
      code: undefined,
      message: undefined,
      detail: undefined,
      retryable: undefined,
      retryHint: undefined,
      isCorsOriginRejected: undefined,
      type: undefined,
      details: undefined,
    };
  }

  // Read every property exactly once to eliminate TOCTOU risk.
  // `allowInherited: true` is required for Error subclass fields that live on
  // the prototype (e.g. `message`, `name`).
  const name = _safeProp(error, 'name', /* allowInherited */ true);
  const status = _safeProp(error, 'status', true);
  const code = _safeProp(error, 'code', true);
  const message = _safeProp(error, 'message', true);
  const detail = _safeProp(error, 'detail', true);
  const retryable = _safeProp(error, 'retryable', true);
  const retryHint = _safeProp(error, 'retryHint', true);
  // Prototype-pollution guard: only honour `isCorsOriginRejected` when it is
  // an OWN property so a polluted `Object.prototype` cannot forge CORS errors.
  const isCorsOriginRejected = _safeProp(error, 'isCorsOriginRejected', false);
  // Body-parser error flags are also own properties on the thrown SyntaxError
  // subclass that express-json sets.
  const type = _safeProp(error, 'type', true);
  const details = _safeProp(error, 'details', true);

  const isAppError =
    (error instanceof AppError) || name === 'AppError';

  return {
    isObject: true,
    isAppError,
    name,
    status,
    code,
    message,
    detail,
    retryable,
    retryHint,
    isCorsOriginRejected,
    type,
    details,
  };
}

/**
 * Map framework and application errors into a stable HTTP error contract.
 *
 * ### Concurrent-execution safety
 *
 * All mutable properties of `error` are snapshot at the top of this function
 * via `_snapshotError`.  No property is read twice from the original object,
 * so concurrent mutation of the input cannot cause different branches to
 * observe different values for the same field (TOCTOU).
 *
 * ### Prototype-pollution safety
 *
 * `isCorsOriginRejected` is only honoured when it is an own property of the
 * thrown value.  A polluted `Object.prototype.isCorsOriginRejected = true`
 * will NOT match unrelated errors.
 *
 * ### Getter-side-effect safety
 *
 * All property reads are wrapped in try/catch inside `_safeProp`.  An
 * adversarial error object whose getter throws cannot cause `mapError` itself
 * to throw.
 *
 * ### Output immutability
 *
 * The returned object is frozen so callers cannot accidentally mutate it and
 * create a shared-state hazard if the same result is cached or passed between
 * concurrent request handlers.
 *
 * @param {unknown} error Thrown error value.
 * @returns {Readonly<{status: number, code: string, message: string, retryable: boolean, retryHint: string}>}
 */
function mapError(error) {
  // Snapshot all properties once — downstream logic MUST read from `s`, not
  // from `error` directly.
  const s = _snapshotError(error);

  // ── 1. AppError (or duck-typed equivalent) ─────────────────────────────────
  if (s.isAppError) {
    const status = typeof s.status === 'number' ? s.status : 500;
    return Object.freeze({
      status,
      code: (typeof s.code === 'string' && s.code) || httpStatusToCode(status),
      message: (typeof s.detail === 'string' && s.detail)
        || (typeof s.message === 'string' && s.message)
        || 'An internal server error occurred.',
      retryable: s.retryable === true,
      retryHint: typeof s.retryHint === 'string' ? s.retryHint : '',
    });
  }

  // ── 2. CORS origin rejection ───────────────────────────────────────────────
  // Guard: isCorsOriginRejected must be an OWN boolean `true` on `error` to
  // prevent prototype-pollution from forging CORS rejections.
  if (s.isCorsOriginRejected === true) {
    return Object.freeze({
      status: 403,
      code: 'FORBIDDEN',
      message: (typeof s.message === 'string' && s.message) || 'CORS policy: origin is not allowed.',
      retryable: false,
      retryHint: '',
    });
  }

  // ── 3. Express JSON body-parser SyntaxError ────────────────────────────────
  if (_isBodyParserSyntaxError(s)) {
    return Object.freeze({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Malformed JSON request body.',
      retryable: false,
      retryHint: 'Fix the JSON payload and try again.',
    });
  }

  // ── 4. ECONNREFUSED (upstream dependency down) ────────────────────────────
  if (s.code === 'ECONNREFUSED') {
    return Object.freeze({
      status: 503,
      code: 'UPSTREAM_ERROR',
      message: 'A dependent service is temporarily unavailable.',
      retryable: true,
      retryHint: 'Retry the request in a few moments.',
    });
  }

  // ── 5. Circuit-breaker OPEN ────────────────────────────────────────────────
  if (s.code === 'CIRCUIT_OPEN') {
    return Object.freeze({
      status: 503,
      code: 'CIRCUIT_OPEN',
      message: 'Service temporarily unavailable due to upstream outage. Circuit breaker is OPEN.',
      retryable: true,
      retryHint: 'Retry the request in a few moments.',
    });
  }

  // ── 6. Generic fallback (status-aware) ────────────────────────────────────
  // Use the snapshotted status — never re-read from `error.status`.
  // Only accept finite, positive integers as valid HTTP status codes.  Zero,
  // NaN, Infinity, and negative values fall back to 500 rather than producing
  // nonsensical responses.
  const rawStatus = s.isObject ? s.status : undefined;
  const status =
    typeof rawStatus === 'number' && Number.isFinite(rawStatus) && rawStatus > 0
      ? rawStatus
      : 500;
  const retryableStatuses = [429, 503];
  const retryable = retryableStatuses.includes(status);

  let retryHint = 'Do not retry until the issue is resolved or support is contacted.';
  if (status === 429) {
    retryHint = 'Wait for the rate limit window to reset before retrying.';
  } else if (status === 503) {
    retryHint = 'Retry the request in a few moments.';
  }

  // Hard rule: a 500 MUST NOT leak the original error message to callers,
  // regardless of what any branch or property says.  Apply this unconditionally
  // using the already-snapshotted status.
  const message = status === 500
    ? 'An internal server error occurred.'
    : (typeof s.message === 'string' && s.message) || 'An internal server error occurred.';

  return Object.freeze({
    status,
    code: httpStatusToCode(status),
    message,
    retryable,
    retryHint,
  });
}

/**
 * Detect Express JSON parser syntax errors using the pre-snapshotted fields.
 * This is an internal helper that receives the snapshot object.
 *
 * @param {{ type: unknown, status: unknown }} snapshot
 * @returns {boolean}
 */
function _isBodyParserSyntaxError(snapshot) {
  return snapshot.type === 'entity.parse.failed' && snapshot.status === 400;
}

/**
 * Detect Express JSON parser syntax errors.
 *
 * Public API: accepts the raw thrown value and inspects it safely.
 *
 * @param {unknown} error Thrown error value.
 * @returns {boolean}
 */
function isBodyParserSyntaxError(error) {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  // Intentionally allow inherited `type` here (SyntaxError subclass may put
  // it on the instance) but guard against getter exceptions.
  const type = _safeProp(error, 'type', /* allowInherited */ true);
  const status = _safeProp(error, 'status', true);
  return type === 'entity.parse.failed' && status === 400;
}

module.exports = {
  mapError,
  isBodyParserSyntaxError,
};
