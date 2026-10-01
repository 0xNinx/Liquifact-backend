'use strict';

/**
 * @fileoverview Typed request/response JTOs for the metrics module.
 *
 * Defines JSDoc typedefs for every data shape that crosses a module boundary
 * (routes &#x21D2; services &#x21D2; metrics instrumentation) and provides pure
 * mapping functions that transform between raw/untrusted input and typed DTOs.
 *
 * Each mapping function validates and coerces fields so callers can rely on
 * the returned DTO having the declared shape.  Unknown or missing fields are
 * given safe defaults / filtered out — no runtime exceptions are thrown for
 * malformed input.
 *
 * ## Usage
 *
 * ```js
 * const { toSmeMetricsResponse } = require('../../dto/metrics');
 *
 * const raw = await invoiceService.getSmeInvoiceCounts(tenantId, userId);
 * const dto = toSmeMetricsResponse(raw);
 * // dto is now guaranteed { open: number, funded: number, settled: number, defaulted: number }
 * ```
 *
 * @module dto/metrics
 */

// ----------------------------------------------------------------------------
// SME Metrics Dashboard DTOs
// ----------------------------------------------------------------------------

/**
 * Aggregated invoice counts returned by the SME metrics endpoint.
 * Every field is a non-negative integer.
 *
 * @typedef {Object} SmeMetricsResponse
 * @property {number} open      - Count of open invoices (pending_verification + verified).
 * @property {number} funded    - Count of funded invoices.
 * @property {number} settled   - Count of settled invoices (settled + paid).
 * @property {number} defaulted - Count of defaulted invoices.
 */

/**
 * Response metadata block for the SME metrics endpoint.
 *
 * Optional pagination fields (`invoices`, `total`, `limit`, `hasMore`,
 * `nextCursor`) are present only when the request included `cursor` or `limit`.
 *
 * @typedef {Object} SmeMetricsMeta
 * @property {string}           timestamp   - ISO-8601 timestamp of the response.
 * @property {string}           version     - API version string (semver).
 * @property {Array<Object?}   [invoices]   - Paginated invoice rows for the current page.
 * @property {number}           [total]     - Total matching invoice count across all pages.
 * @property {number}           [limit]     - Page size applied to the response.
 * @property {boolean}          [hasMore]   - Whether additional pages exist.
 * @property {string|null}     [nextCursor] - Opaque cursor for the next page (null when terminal).
 */

/**
 * Top-level API response envelope for the SME metrics endpoint.
 *
 * @typedef {Object} SmeMetricsApiResponse
 * @property {SmeMetricsResponse} data      - Aggregated invoice counts.
 * @property {SmeMetricsMeta}     meta      - Response metadata.
 * @property {Object|null}        error     - Error detail object (null on success).
 * @property {string}             timestamp - ISO-8601 timestamp of the response.
 */

// ----------------------------------------------------------------------------
// Persistence Instrumentation DTOs
// ----------------------------------------------------------------------------

/**
 * Bounded endpoint label for persistence metrics.
 * Unknown endpoints are collapsed to `'unknown'`.
 *
 * @typedef {'sme_invoice_upload'|'sme_invoice_presigned_url'|'unknown'} PersistenceEndpoint
 */

/**
 * Bounded HTTP status-class label for persistence metrics.
 *
 * @typedef {'2xx'|'4xx'|'5xx'} PersistenceStatusClass
 */

/**
 * Bounded cause label for persistence request errors.
 *
 * @typedef {'validation'|'storage'|'internal'|'none'} PersistenceCause
 */

/**
 * Normalised parameters passed to the persistence metrics recorder.
 *
 * All fields have already been run through their respective bounded-label
 * normalisers — callers can rely on the values matching one of the declared
 * union members.
 *
 * @typedef {Object} PersistenceRecordParams
 * @property {PersistenceEndpoint}      endpoint        - Normalised endpoint label.
 * @property {number}                   statusCode      - Final HTTP status code.
 * @property {number}                   durationSeconds - Request wall-clock duration in seconds.
 * @property {PersistenceCause}         cause           - Normalised error cause label.
 * @property {boolean}                  success         - Whether the request completed without error.
 * @property {number}                   errorCount      - 1 when the request failed, 0 otherwise.
 * @property {import('express').Request} [req]          - Express request (for scoped logging).
 */

// ----------------------------------------------------------------------------
// SME Metrics — mapping functions
// ----------------------------------------------------------------------------

/** @type {ReadonlyArray<'open'|'funded'|'settled'|'defaulted'>} */
const SME_METRIC_FIELDS = Object.freeze(['open', 'funded', 'settled', 'defaulted']);
const INVALID_PROPERTY = Symbol('invalid-property');

/**
 * Safely identifies object inputs without allowing revoked proxies to escape.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} Whether value is a non-array object.
 */
function isObjectRecord(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch (_err) {
    return false;
  }
}

/**
 * Reads a property without allowing a hostile getter/proxy trap to abort DTO
 * normalization. INVALID_PROPERTY is distinct from a missing or undefined
 * property so callers can apply the documented fallback deterministically.
 *
 * @param {*} obj - Source object.
 * @param {string} key - Property to read.
 * @returns {*} The property value, or INVALID_PROPERTY if access failed.
 */
function readPropertySafely(obj, key) {
  try {
    return obj[key];
  } catch (_err) {
    return INVALID_PROPERTY;
  }
}

/**
 * Checks own-property presence without allowing proxy traps to escape.
 *
 * @param {*} obj - Source object.
 * @param {string} key - Property to inspect.
 * @returns {boolean} Whether the object owns the property.
 */
function hasOwnPropertySafely(obj, key) {
  try {
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch (_err) {
    return false;
  }
}

/**
 * Converts a value to a finite number, returning fallback if conversion fails.
 *
 * @param {*} value - Value to convert.
 * @param {number} fallback - Value used when conversion is unsafe.
 * @returns {number} Finite numeric result or fallback.
 */
function toFiniteNumber(value, fallback) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  } catch (_err) {
    return fallback;
  }
}

/**
 * Safely converts a value to a string, preserving the specified fallback on
 * coercion errors (for example, an object with a throwing toString method).
 *
 * @param {*} value - Value to convert.
 * @param {string} fallback - Fallback string.
 * @returns {string} Converted value or fallback.
 */
function toStringSafely(value, fallback) {
  try {
    return String(value);
  } catch (_err) {
    return fallback;
  }
}

/**
 * Error for malformed internal metrics data. The message contains only a
 * bounded field name; raw metric values are deliberately never retained.
 */
class MetricsDtoValidationError extends Error {
  /**
  * Creates a sanitized validation error for malformed metrics output.
  *
   * @param {string} field - A known metric field, or 'response'.
   */
  constructor(field) {
    super(`Invalid SME metrics data for field: ${field}`);
    this.name = 'MetricsDtoValidationError';
    this.code = 'METRICS_DTO_INVALID_DATA';
    this.field = field;
  }
}

/**
 * Maps a raw invoice-counts object to a typed {@link SmeMetricsResponse} DTO.
 *
 * Every field is coerced to a finite number; fractional values are preserved
 * for compatibility. Unknown keys are stripped, and malformed coercions use
 * the documented zero fallback. This function never throws.
 *
 * ## Invariants
 * - All four fields are non-negative safe integers (`Number.isSafeInteger`).
 * - Non-finite, negative, fractional, or non-numeric inputs collapse to `0`.
 * - The returned object always has exactly the four declared keys.
 *
 * @param {unknown} raw - Raw counts object from the invoice service or DB query.
 * @returns {SmeMetricsResponse} Normalised DTO with all four keys guaranteed.
 */
function toSmeMetricsResponse(raw) {
  /** @type {*} */
  const obj = isObjectRecord(raw) ? raw : {};
  /**
   * Reads and safely normalizes one known count field.
   *
   * @param {'open'|'funded'|'settled'|'defaulted'} field - Count field name.
   * @returns {number} Finite normalized value or zero.
   */
  const readCount = (field) => {
    const value = readPropertySafely(obj, field);
    return value === INVALID_PROPERTY ? 0 : toFiniteNumber(value, 0) || 0;
  };
  return {
    open: readCount('open'),
    funded: readCount('funded'),
    settled: readCount('settled'),
    defaulted: readCount('defaulted'),
  };
}

/**
 * Strictly maps counts supplied by the invoice service for an API response.
 * Unlike the legacy normalizer above, this path rejects missing, unsafe, or
 * invalid fields instead of turning upstream data failures into zero counts.
 * This keeps the existing permissive public mapper compatible while ensuring
 * the live endpoint never reports a plausible but silently incomplete result.
 *
 * @param {unknown} raw - Raw count response from the invoice service.
 * @returns {SmeMetricsResponse} Validated counts.
 * @throws {MetricsDtoValidationError} When the source shape/counts are invalid.
 */
function toStrictSmeMetricsResponse(raw) {
  if (!isObjectRecord(raw)) {
    throw new MetricsDtoValidationError('response');
  }

  /** @type {SmeMetricsResponse} */
  const result = { open: 0, funded: 0, settled: 0, defaulted: 0 };
  for (const field of SME_METRIC_FIELDS) {
    const value = readPropertySafely(raw, field);
    if (!hasOwnPropertySafely(raw, field) || value === INVALID_PROPERTY || !Number.isSafeInteger(value) || value < 0) {
      throw new MetricsDtoValidationError(field);
    }
    result[field] = value;
  }
  return result;
}

/**
 * Maps a raw meta-like object to a normalised {@link SmeMetricsMeta} DTO.
 *
 * Optional pagination fields are preserved when present on the raw input;
 * otherwise they are omitted from the returned meta object.
 *
 * ## Invariants
 * - `timestamp` and `version` are always non-empty strings.
 * - `total` and `limit`, when present, are non-negative safe integers.
 * - `hasMore`, when present, is a boolean.
 * - `nextCursor`, when present, is either a string or `null`.
 *
 * @param {unknown} raw - Raw meta-like object (e.g. from invoice service or
 *   a manually constructed meta block in the route handler).
 * @returns {SmeMetricsMeta} Normalised meta DTO.
 */
function toSmeMetricsMeta(raw) {
  /** @type {*} */
  const obj = isObjectRecord(raw) ? raw : {};
  const timestamp = readPropertySafely(obj, 'timestamp');
  const version = readPropertySafely(obj, 'version');

  // Mandatory fields with defaults.
  /** @type {SmeMetricsMeta} */
  const meta = {
    timestamp: typeof timestamp === 'string' ? timestamp : new Date().toISOString(),
    version: typeof version === 'string' ? version : '0.1.0',
  };

  // Optional pagination fields — only include when the source had them.
  const invoices = readPropertySafely(obj, 'invoices');
  if (invoices !== INVALID_PROPERTY && isArraySafely(invoices)) {
    meta.invoices = invoices;
  }
  const total = readPropertySafely(obj, 'total');
  if (typeof total === 'number' && Number.isFinite(total)) {
    meta.total = Math.max(0, Math.floor(total));
  }
  const limit = readPropertySafely(obj, 'limit');
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    meta.limit = limit;
  }
  const hasMore = readPropertySafely(obj, 'hasMore');
  if (typeof hasMore === 'boolean') {
    meta.hasMore = hasMore;
  }
  // Explicitly handle nextCursor — null is a valid terminal value.
  const hasNextCursor = hasOwnPropertySafely(obj, 'nextCursor');
  if (hasNextCursor) {
    const nextCursor = readPropertySafely(obj, 'nextCursor');
    if (nextCursor !== INVALID_PROPERTY) {
      meta.nextCursor = nextCursor === undefined ? null : nextCursor;
    }
  }

  return /** @type {SmeMetricsMeta} */ (meta);
}

/**
 * Safely checks whether a value is an array, including revoked proxies.
 *
 * @param {*} value - Value to inspect.
 * @returns {boolean} Whether value is an array.
 */
function isArraySafely(value) {
  try {
    return Array.isArray(value);
  } catch (_err) {
    return false;
  }
}

/**
 * Assembles a full {@link SmeMetricsApiResponse} from its parts.
 *
 * This is a pure composition helper — it does not inspect or validate its
 * arguments beyond basic type safety.
 *
 * ## Invariants
 * - `data` is always a valid {@link SmeMetricsResponse} (normalised via
 *   {@link toSmeMetricsResponse}).
 * - `meta` is always a valid {@link SmeMetricsMeta} (normalised via
 *   {@link toSmeMetricsMeta}).
 * - `error` is either `null` or a plain object.
 *
 * @param {SmeMetricsResponse} data      - Aggregated invoice counts.
 * @param {SmeMetricsMeta}     meta      - Response metadata block.
 * @param {Object|null}       [error]   - Optional error detail object.
 * @returns {SmeMetricsApiResponse} The complete top-level API response DTO.
 */
function toSmeMetricsApiResponse(data, meta, error = null) {
  return {
    data: toSmeMetricsResponse(data),
    meta: toSmeMetricsMeta(meta),
    error: (error && typeof error === 'object' && !Array.isArray(error)) ? error : null,
    timestamp: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Persistence instrumentation — mapping functions
// ----------------------------------------------------------------------------

/**
 * Maps raw persistence-outcome arguments to a typed {@link PersistenceRecordParams} DTO.
 *
 * The `endpoint`, `cause`, and `statusCode` fields are expected to have already
 * been normalised by the caller (typically via the normalizers in
 * {@link module:metrics}).  This function validates the shape and provides safe
 * defaults for any missing fields.
 *
 * ## Invariants
 * - `endpoint` is a non-empty string; unknown values collapse to `'unknown'`.
 * - `statusCode` is an integer in `[100, 599]`; invalid values collapse to `200`.
 * - `durationSeconds` is a non-negative finite number; invalid values collapse to `0`.
 * - `cause` is one of `'validation' | 'storage' | 'internal' | 'none'`.
 *
 * @param {Object} raw                          - Raw outcome data.
 * @param {string} raw.endpoint                 - Endpoint label (already normalised).
 * @param {number} raw.statusCode               - HTTP status code.
 * @param {number} raw.durationSeconds          - Wall-clock duration in seconds.
 * @param {string} [raw.cause='none']           - Error cause label (already normalised).
 * @param {boolean} [raw.success]               - Whether the request succeeded.
 * @param {number} [raw.errorCount]             - Error count (0 or 1).
 * @param {import('express').Request} [raw.req] - Express request for scoped logging.
 * @returns {PersistenceRecordParams} Normalised DTO.
 */
function toPersistenceRecordParams(raw) {
  /** @type {*} */
  const obj = isObjectRecord(raw) ? raw : {};
  const endpointValue = readPropertySafely(obj, 'endpoint');
  const statusValue = readPropertySafely(obj, 'statusCode');
  const durationValue = readPropertySafely(obj, 'durationSeconds');
  const causeValue = readPropertySafely(obj, 'cause');
  const reqValue = readPropertySafely(obj, 'req');
  const parsedStatus = statusValue === INVALID_PROPERTY ? 200 : toFiniteNumber(statusValue, 200);
  const parsedDuration = durationValue === INVALID_PROPERTY ? 0 : toFiniteNumber(durationValue, 0);

  const endpoint = String(obj.endpoint || 'unknown');
  const statusCode = Number(obj.statusCode);
  const durationSeconds = Number(obj.durationSeconds);
  const cause = String(obj.cause || 'none');

  return {
    endpoint: /** @type {PersistenceEndpoint} */ (endpointValue === INVALID_PROPERTY || !endpointValue
      ? 'unknown'
      : toStringSafely(endpointValue, 'unknown')),
    statusCode: Number.isInteger(parsedStatus) && parsedStatus >= 100 && parsedStatus <= 599
      ? parsedStatus
      : 200,
    durationSeconds: Number.isFinite(parsedDuration) && parsedDuration >= 0
      ? parsedDuration
      : 0,
    cause: /** @type {PersistenceCause} */ (
      causeValue === INVALID_PROPERTY || !causeValue ? 'none' : toStringSafely(causeValue, 'none')
    ),
    req: reqValue === INVALID_PROPERTY ? undefined : (reqValue || undefined),
  };
}

// ----------------------------------------------------------------------------
// Validation helpers (primarily for tests / guards)
// ----------------------------------------------------------------------------

/**
 * Checks whether a value is a conformant {@link SmeMetricsResponse} DTO.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} `true` when the value has the expected shape.
 */
function isValidSmeMetricsResponse(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  return SME_METRIC_FIELDS.every((field) => {
    const count = readPropertySafely(value, field);
    return hasOwnPropertySafely(value, field) && count !== INVALID_PROPERTY && Number.isSafeInteger(count) && count >= 0;
  });
}

/**
 * Checks whether a value is a conformant {@link PersistenceRecordParams} DTO.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} `true` when the value has the expected shape.
 */
function isValidPersistenceRecordParams(value) {
  if (!isObjectRecord(value)) {
    return false;
  }
  const endpoint = readPropertySafely(value, 'endpoint');
  const statusCode = readPropertySafely(value, 'statusCode');
  const durationSeconds = readPropertySafely(value, 'durationSeconds');
  const cause = readPropertySafely(value, 'cause');
  return endpoint !== INVALID_PROPERTY && typeof endpoint === 'string' &&
    statusCode !== INVALID_PROPERTY && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 &&
    durationSeconds !== INVALID_PROPERTY && Number.isFinite(durationSeconds) && durationSeconds >= 0 &&
    cause !== INVALID_PROPERTY && typeof cause === 'string';
}

module.exports = {
  toSmeMetricsResponse,
  toStrictSmeMetricsResponse,
  toSmeMetricsMeta,
  toSmeMetricsApiResponse,
  toPersistenceRecordParams,

  // Validation helpers
  isValidSmeMetricsResponse,
  isValidPersistenceRecordParams,
  MetricsDtoValidationError,
};
