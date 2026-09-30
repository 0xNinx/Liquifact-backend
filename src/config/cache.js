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
 * Parses cache configuration from environment variables.
 * Falls back to defaults when values are missing or invalid.
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
