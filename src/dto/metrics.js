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
 * @property {import('express').Request} [req]          - Express request (for scoped logging).
 */

// ----------------------------------------------------------------------------
// SME Metrics — mapping functions
// ----------------------------------------------------------------------------

/**
 * Maps a raw invoice-counts object to a typed {@link SmeMetricsResponse} DTO.
 *
 * Every field is coerced to a safe integer.  Unknown keys on the raw object
 * are silently stripped.  This function never throws.
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
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    open: toNonNegativeInt(obj.open),
    funded: toNonNegativeInt(obj.funded),
    settled: toNonNegativeInt(obj.settled),
    defaulted: toNonNegativeInt(obj.defaulted),
  };
}

/**
 * Coerces an arbitrary value to a non-negative safe integer.
 *
 * Returns `0` for `NaN`, `Infinity`, `-Infinity`, negatives, non-numbers,
 * and values outside the safe-integer range.  Fractional values are floored.
 *
 * @param {unknown} value - Value to coerce.
 * @returns {number} A non-negative safe integer.
 */
function toNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  const floored = Math.floor(n);
  return Number.isSafeInteger(floored) ? floored : 0;
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
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  // Mandatory fields with defaults.
  const meta = {
    timestamp: (typeof obj.timestamp === 'string' && obj.timestamp.length > 0)
      ? obj.timestamp
      : new Date().toISOString(),
    version: (typeof obj.version === 'string' && obj.version.length > 0)
      ? obj.version
      : '0.1.0',
  };

  // Optional pagination fields — only include when the source had them.
  if (Array.isArray(obj.invoices)) {
    meta.invoices = obj.invoices;
  }
  if (typeof obj.total === 'number' && Number.isFinite(obj.total) && obj.total >= 0) {
    const total = Math.floor(obj.total);
    if (Number.isSafeInteger(total)) {
      meta.total = total;
    }
  }
  if (typeof obj.limit === 'number' && Number.isFinite(obj.limit) && obj.limit >= 0) {
    const limit = Math.floor(obj.limit);
    if (Number.isSafeInteger(limit)) {
      meta.limit = limit;
    }
  }
  if (typeof obj.hasMore === 'boolean') {
    meta.hasMore = obj.hasMore;
  }
  // Explicitly handle nextCursor — null is a valid terminal value.
  if (Object.prototype.hasOwnProperty.call(obj, 'nextCursor')) {
    meta.nextCursor = (typeof obj.nextCursor === 'string' || obj.nextCursor === null)
      ? obj.nextCursor
      : null;
  }

  return /** @type {SmeMetricsMeta} */ (meta);
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
 * @param {import('express').Request} [raw.req] - Express request for scoped logging.
 * @returns {PersistenceRecordParams} Normalised DTO.
 */
function toPersistenceRecordParams(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};

  const endpoint = (typeof obj.endpoint === 'string' && obj.endpoint.length > 0)
    ? obj.endpoint
    : 'unknown';

  const statusCode = (() => {
    const n = Number(obj.statusCode);
    if (!Number.isFinite(n)) return 200;
    const i = Math.floor(n);
    return (Number.isSafeInteger(i) && i >= 100 && i <= 599) ? i : 200;
  })();

  const durationSeconds = (() => {
    const n = Number(obj.durationSeconds);
    return (Number.isFinite(n) && n >= 0) ? n : 0;
  })();

  const cause = (() => {
    const c = typeof obj.cause === 'string' ? obj.cause : 'none';
    return (c === 'validation' || c === 'storage' || c === 'internal' || c === 'none')
      ? c
      : 'none';
  })();

  return {
    endpoint,
    statusCode,
    durationSeconds,
    cause: /** @type {PersistenceCause} */ (cause),
    req: obj.req || undefined,
  };
}

// ----------------------------------------------------------------------------
// Validation helpers (primarily for tests / guards)
// ----------------------------------------------------------------------------

/**
 * Checks whether a value is a conformant {@link SmeMetricsResponse} DTO.
 *
 * Enforces the full invariant set: non-negative safe integers for every
 * count field, and no unexpected own enumerable keys.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} `true` when the value has the expected shape.
 */
function isSmeMetricsResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 4) {
    return false;
  }
  const required = ['open', 'funded', 'settled', 'defaulted'];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
    const num = value[key];
    if (!Number.isSafeInteger(num) || num < 0) {
      return false;
    }
  }
  return true;
}

module.exports = {
  toSmeMetricsResponse,
  toSmeMetricsMeta,
  toSmeMetricsApiResponse,
  toPersistenceRecordParams,
  toNonNegativeInt,
  isSmeMetricsResponse,
};
