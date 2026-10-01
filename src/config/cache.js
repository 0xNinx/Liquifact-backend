const DEFAULT_ESCROW_TTL_SECONDS = 30;
const DEFAULT_ESCROW_MAX_ENTRIES = 500;
const DEFAULT_INDEXER_TTL_SECONDS = 10;
const DEFAULT_INDEXER_MAX_ENTRIES = 200;

const DEFAULT_INVOICE_STATE_TTL_SECONDS = 30;
const DEFAULT_INVOICE_STATE_MAX_ENTRIES = 500;

const MAX_SAPE_TTL_SECONDS = 86400; // 24 hours
const MAX_SAPE_MAX_ENTRIES = 100000;

/**
 * Parses a positive integer environment value with bounds and a default.
 *
 * The cache configuration is part of the cache state invariants:
 *   - TTL must be a positive integer and must not exceed MAX_SAPE_TTL_SECONDS.
 *   - Max entries must be a positive integer and must not exceed MAX_SAPE_MAX_ENTRIES.
 *   - Invalid, missing, or out-of-bounds values fall back to the documented default.
 *
 * @param {unknown} raw - Raw environment value.
 * @param {number} defaultValue - Value to use when raw is invalid or missing.
 * @param {number} maxValue - Upper bound (inclusive).
 * @returns {number} Validated integer.
 */
function parsePositiveInteger(raw, defaultValue, maxValue) {
  if (typeof raw === 'undefined' || raw === null) {
    return defaultValue;
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  if (parsed > maxValue) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Maximum acceptable cache TTL in seconds. Larger values are clamped to
 * prevent accidental configuration from effectively disabling cache expiry.
 */
const MAX_CACHE_TTL_SECONDS = 86400; // 24 hours

/**
 * Maximum acceptable cache entry count. Larger values are clamped to bound
 * memory usage and avoid unbounded growth from misconfiguration.
 */
const MAX_CACHE_ENTRIES = 100000;

/**
 * Parses a positive integer environment value with default and clamping.
 *
 * Behavior:
 * - missing / empty / whitespace -> default
 * - non-numeric / NaN / non-integer -> default
 * - zero / negative / Infinity -> default
 * - valid positive integer -> clamped to [min, max]
 *
 * @param {unknown} raw - Raw environment value.
 * @param {number} defaultValue - Value used when input is invalid or missing.
 * @param {number} maxValue - Upper bound applied to valid inputs.
 * @returns {number} Validated integer.
 */
function parsePositiveInteger(raw, defaultValue, maxValue) {
  if (raw === undefined || raw === null) {
    return defaultValue;
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(parsed, maxValue);
}

/**
 * Parses cache configuration from environment variables.
 * Falls back to defaults when values are missing or invalid.
 *
 * Invariants:
 * - Returned TTLs are positive integer milliseconds within [1000, MAX_CACHE_TTL_SECONDS*1000].
 * - Returned max entries are positive integers within [1, MAX_CACHE_ENTRIES].
 * - Invalid input never produces NaN or negative values.
 *
 * @param {NodeJS.ProcessEnv} env - Environment variables to read from.
 * @returns {{ escrowTtl: number, escrowMaxEntries: number, invoiceStateTtl: number, invoiceStateMaxEntries: number }} Cache configuration.
 */
function parseCacheConfig(env = process.env) {
  const escrowSeconds = parsePositiveInteger(env.ESCROW_CACHE_TTL_SECONDS, DEFAULT_ESCROW_TTL_SECONDS, MAX_SAPE_TTL_SECONDS);
  const escrowMaxEntries = parsePositiveInteger(env.ESCROW_CACHE_MAX_ENTRIES, DEFAULT_ESCROW_MAX_ENTRIES, MAX_SAPE_MAX_ENTRIES);

  const invoiceStateSeconds = parsePositiveInteger(env.INVOICE_STATE_CACHE_TTL_SECONDS, DEFAULT_INVOICE_STATE_TTL_SECONDS, MAX_SAPE_TTL_SECONDS);
  const invoiceStateMaxEntries = parsePositiveInteger(env.INVOICE_STATE_CACHE_MAX_ENTRIES, DEFAULT_INVOICE_STATE_MAX_ENTRIES, MAX_SAPE_MAX_ENTRIES);

  return {
    escrowTtl: escrowSeconds * 1000,
    escrowMaxEntries,
    invoiceStateTtl: invoiceStateSeconds * 1000,
    invoiceStateMaxEntries,
  };
}

const cacheConfig = parseCacheConfig();

module.exports = {
  cacheConfig,
  parseCacheConfig,
  parsePositiveInteger,
  DEFAULT_ESCROW_TTL_SECONDS,
  DEFAULT_ESCROW_MAX_ENTRIES,
  DEFAULT_INVOICE_STATE_TTL_SECONDS,
  DEFAULT_INVOICE_STATE_MAX_ENTRIES,
  MAX_SAPE_TTL_SECONDS,
  MAX_SAPE_MAX_ENTRIES,
};
