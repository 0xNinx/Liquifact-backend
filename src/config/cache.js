const DEFAULT_ESCROW_TTL_SECONDS = 30;
const DEFAULT_ESCROW_MAX_ENTRIES = 500;
const DEFAULT_INDEXER_TTL_SECONDS = 10;
const DEFAULT_INDEXER_MAX_ENTRIES = 200;

const DEFAULT_INVOICE_STATE_TTL_SECONDS = 30;
const DEFAULT_INVOICE_STATE_MAX_ENTRIES = 500;

const MIN_CACHE_TTL_SECONDS = 1;
const MAX_CACHE_TTL_SECONDS = 86400;
const MIN_CACHE_MAX_ENTRIES = 1;
const MAX_CACHE_MAX_ENTRIES = 1000000;

/**
 * Parses and clamps a positive integer configuration value.
 *
 * Returns the default when the raw value is missing, non-numeric,
 * non-integer, or outside the accepted range. Values that are numeric
 * and in-range are returned as-is, ensuring deterministic behavior
 * for duplicate and boundary inputs.
 *
 * @param {unknown} raw - Raw environment value.
 * @param {number} defaultValue - Fallback value.
 * @param {number} min - Inclusive lower bound.
 * @param {number} max - Inclusive upper bound.
 * @returns {number} Parsed and clamped value.
 */
function parsePositiveInt(raw, defaultValue, min, max) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return defaultValue;
  }

  const trimmed = raw.trim();
  // Reject non-integer formats (e.g. '1.5', '1e'3', '+1', '010' is accepted).
  if (!/^[0-9]+$/.test(trimmed)) {
    return defaultValue;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    return defaultValue;
  }

  if (parsed < min || parsed > max) {
    return defaultValue;
  }

  return parsed;
}

/**
 * Parses cache configuration from environment variables.
 * Falls back to defaults when values are missing or invalid.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variables to read from.
 * @returns {{ escrowTtl: number, escrowMaxEntries: number, invoiceStateTtl: number, invoiceStateMaxEntries: number }} Cache configuration.
 */
function parseCacheConfig(env = process.env) {
  const escrowSeconds = parsePositiveInt(
    env.ESCROW_CACHE_TTL_SECONDS,
    DEFAULT_ESCROW_TTL_SECONDS,
    MIN_CACHE_TTL_SECONDS,
    MAX_CACHE_TTL_SECONDS,
  );
  const escrowMaxEntries = parsePositiveInt(
    env.ESCROW_CACHE_MAX_ENTRIES,
    DEFAULT_ESCROW_MAX_ENTRIES,
    MIN_CACHE_MAX_ENTRIES,
    MAX_CACHE_MAX_ENTRIES,
  );

  const invoiceStateSeconds = parsePositiveInt(
    env.INVOICE_STATE_CACHE_TTL_SECONDS,
    DEFAULT_INVOICE_STATE_TTL_SECONDS,
    MIN_CACHE_TTL_SECONDS,
    MAX_CACHE_TTL_SECONDS,
  );
  const invoiceStateMaxEntries = parsePositiveInt(
    env.INVOICE_STATE_CACHE_MAX_ENTRIES,
    DEFAULT_INVOICE_STATE_MAX_ENTRIES,
    MIN_CACHE_MAX_ENTRIES,
    MAX_CACHE_MAX_ENTRIES,
  );

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
  parsePositiveInt,
  DEFAULT_ESCROW_TTL_SECONDS,
  DEFAULT_ESCROW_MAX_ENTRIES,
  DEFAULT_INVALID_INVOICE_STATE_TTL_SECONDS,
  DEFAULT_INVOICE_STATE_TTL_SECONDS,
  DEFAULT_INVOICE_STATE_MAX_ENTRIES,
  MIN_CACHE_TTL_SECONDS,
  MAX_CACHE_TTL_SECONDS,
  MIN_CACHE_MAX_ENTRIES,
  MAX_CACHE_MAX_ENTRIES,
};
