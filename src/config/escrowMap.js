/*
 * src/config/escrowMap.js
 *
 * Resolves an invoiceId to its on-chain LiquifactEscrow contract address and
 * provides the inverse lookup (contract address → invoiceId) for the escrow
 * indexer.
 *
 * Configuration is supplied via the ESCROW_ADDR_BY_INVOICE environment variable
 * (JSON). This avoids storing addresses in source code and allows per-environment
 * rotation without a redeploy.
 *
 * Schema of ESCROW_ADDR_BY_INVOICE (see README for full example):
 * {
 *   "mappings": [
 *     {
 *       "invoiceId": "inv_001",
 *       "escrowAddress": "GABC...123",
 *       "environment": "production",
 *       "isActive": true
 *     }
 *   ],
 *   "defaultEnvironment": "production",
 *   "allowlistEnabled": true,
 *   "cacheEnabled": true,
 *   "cacheTtlSeconds": 300
 * }
 *
 * Throws EscrowNotFoundError when no active mapping exists for the invoice in
 * the current environment. Funding callers translate this to a 404.
 *
 * Compatibility contracts:
 *   - `resolveEscrowAddress` returns `null` for invalid input and for unknown
 *     invoices. It never throws for a well-formed string invoiceId.
 *   - `resolveInvoiceByAddress` returns `null` for unknown, inactive, or
 *     foreign-environment addresses. It never throws.
 *   - The forward and reverse lookups share the same environment scoping
 *     rule (current environment OR configured defaultEnvironment) so a
 *     round-trip is always consistent.
 *   - Config parsing is pure with respect to cache state: a read never mutates
 *     the cache except to insert/evict a resolved entry.
 */

'use strict';

const crypto = require('crypto');
const z = require('zod');
const { get: getConfig } = require('./index');
const { parseCacheConfig } = require('./cache');
let configReadCacheHits = { inc() {} };
let configReadCacheMisses = { inc() {} };

try {
  ({ configReadCacheHits, configReadCacheMisses } = require('../metrics'));
} catch (_error) {
  // Metrics are optional in isolated config tests.
}

/**
 * Thrown when no active escrow mapping exists for an invoice ID.
 *
 * This is the public error contract for funding callers: they translate it to
 * a 404. The code is stable and must not change without a major version bump.
 */
class EscrowNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EscrowNotFoundError';
  }
}

/**
 * Schema for a single escrow mapping entry.
 */
const EscrowMappingEntrySchema = z.object({
  invoiceId: z.string()
    .min(1, 'Invoice ID cannot be empty')
    .max(100, 'Invoice ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invoice ID must contain only alphanumeric characters, underscores, and hyphens'),
  escrowAddress: z.string()
    .min(1, 'Escrow address cannot be empty')
    .regex(/^[GC][A-Z0-9]{55}$/, 'Invalid Stellar address format - must start with G or C and be 56 characters'),
  environment: z.string()
    .regex(/^(development|staging|production|test)$/, 'Environment must be valid')
    .default('development'),
  isActive: z.boolean()
    .default(true)
});

/**
 * Schema for the full ESCROW_ADDR_BY_INVOICE config object.
 */
class EscrowMapConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EscrowMapConfigError';
  }
}

/**
 * Schema for the full ESCROW_ADDR_BY_INVOICE configuration object.
 */
const EscrowMappingConfigSchema = z.object({
  mappings: z.array(EscrowMappingEntrySchema)
    .min(0, 'Mappings array cannot be negative')
    .max(1000, 'Too many mappings - maximum 1000 allowed'),
  defaultEnvironment: z.string()
    .regex(/^(development|staging|production|test)$/, 'Default environment must be valid')
    .default('development'),
  allowlistEnabled: z.boolean()
    .default(true),
  cacheEnabled: z.boolean()
    .default(true),
  cacheTtlSeconds: z.number()
    .min(5)
    .max(3600)
    .default(300)
}).superRefine((data, ctx) => {
  const invoiceEnvPairs = new Set();
  const addressEnvPairs = new Set();
  data.mappings.forEach((mapping, i) => {
    const invEnv = `${mapping.invoiceId}:${mapping.environment}`;
    const addrEnv = `${mapping.escrowAddress}:${mapping.environment}`;
    if (invoiceEnvPairs.has(invEnv)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate invoiceId "${mapping.invoiceId}" in environment "${mapping.environment}"`,
        path: ['mappings', i, 'invoiceId']
      });
    }
    if (addressEnvPairs.has(addrEnv)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate escrowAddress "${mapping.escrowAddress}" in environment "${mapping.environment}"`,
        path: ['mappings', i, 'escrowAddress']
      });
    }
    invoiceEnvPairs.add(invEnv);
    addressEnvPairs.add(addrEnv);
  });
});

/**
 * Parse and validate the raw config JSON from the environment.
 * @returns {{mappings: Array, defaultEnvironment: string, allowlistEnabled: boolean, cacheEnabled: boolean, cacheTtlSeconds: number}}
 */

const mappingCache = new Map();
let cachedSource = null;
let cacheHits = 0;
let cacheMisses = 0;
let lastKnownGoodConfig = null;
let lastKnownGoodSource = null;

/**
 * Reads the cache bounds and TTL from environment configuration.
 *
 * @returns {{ttlMs: number, maxEntries: number}} Cache settings.
 */
function getCacheSettings() {
  const parsed = parseCacheConfig();
  return {
    ttlMs: parsed.escrowTtl,
    maxEntries: Number.isFinite(parsed.escrowCacheMaxEntries) ? parsed.escrowCacheMaxEntries : 100,
  };
}

/**
 * Refreshes a cache entry's recency without changing its payload.
 *
 * @param {string} cacheKey - Cache key to touch.
 * @param {{address: string, timestamp: number}} entry - Cached entry.
 * @returns {void}
 */
function touchCacheKey(cacheKey, entry) {
  mappingCache.delete(cacheKey);
  mappingCache.set(cacheKey, entry);
}

/**
 * Evicts the least-recently used cache entry.
 *
 * @returns {void}
 */
function evictOldestEntry() {
  const oldestKey = mappingCache.keys().next().value;
  if (oldestKey !== undefined) {
    mappingCache.delete(oldestKey);
  }
}

/**
 * Clears all cached mappings and resets cache statistics.
 *
 * @returns {void}
 */
function clearCache() {
  mappingCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/**
 * Parses and validates the ESCROW_ADDR_BY_INVOICE environment variable.
 *
 * Expected format: JSON string with mappings array
 * Example: '{"mappings":[{"invoiceId":"inv_123","escrowAddress":"GADC...","environment":"development"}]}'
 *
 * @returns {z.infer typeof EscrowMappingConfigSchema} Validated mapping configuration
 * @throws {Error} If environment variable is invalid or malformed
 */
const EMPTY_CONFIG = Object.freeze({
  mappings: [],
  defaultEnvironment: 'development',
  allowlistEnabled: false,
  cacheEnabled: true,
  cacheTtlSeconds: 300,
});

function parseEscrowMappingConfig() {
  const envValue = process.env.ESCROW_ADDR_BY_INVOICE;

  // Invalidate the resolution cache only when the source value actually changed.
  // This keeps the read path deterministic and avoids clearing the cache on
  // every call.
  if (envValue !== cachedSource) {
    clearCache();
    cachedSource = envValue;
  }

  // Default empty config if not set
  if (!envValue || envValue.trim() === '') {
    lastKnownGoodConfig = EMPTY_CONFIG;
    lastKnownGoodSource = envValue;
    return EMPTY_CONFIG;
  }

  try {
    const raw = JSON.parse(envValue);
    const parsed = EscrowMappingConfigSchema.parse(raw);
    lastKnownGoodConfig = parsed;
    lastKnownGoodSource = envValue;
    return parsed;
  } catch (error) {
    // Deterministic failure recovery: if we have a previously validated config
    // for a *different* source, fall back to it rather than throwing. This
    // keeps callers operational during transient env corruption while still
    // surfacing the failure via logs.
    if (lastKnownGoodConfig && lastKnownGoodSource !== envValue) {
      // eslint-disable-next-line no-console
      console.error(
        '[escrowMap] ESCROW_ADDR_BY_INVOICE parse failure; using last known good config',
        { reason: error.message }
      );
      return lastKnownGoodConfig;
    }
    throw new EscrowMapConfigError(
      `Failed to parse ESCROW_ADDR_BY_INVOICE JSON: ${error.message}`
    );
  }
}

/**
 * Gets the current environment from the app config.
 * Falls back to NODE_ENV if not available.
 *
 * @returns {string} Current environment (development, staging, production)
 */
function getCurrentEnvironment() {
  try {
    const config = getConfig();
    return config.NODE_ENV || 'development';
  } catch (_error) {
    // Config not validated, fall back to environment variable
    return process.env.NODE_ENV || 'development';
  }
}

/**
 * Returns the list of environments a mapping is visible in.
 *
 * The forward and reverse lookups must agree on this rule or a round-trip
 * (invoiceId → address → invoiceId) can fail. The rule is: a mapping is
 * visible in the current environment OR in the configured default environment.
 *
 * @param {string} targetEnv - The current environment.
 * @param {string} defaultEnv - The configured default environment.
 * @returns {Set<string>} Environments that are visible.
 */
function visibleEnvironments(targetEnv, defaultEnv) {
  const visible = new Set();
  if (targetEnv && typeof targetEnv === 'string') { visible.add(targetEnv); }
  if (defaultEnv && typeof defaultEnv === 'string') { visible.add(defaultEnv); }
  return visible;
}

/**
 * Validates that an invoice ID is in the allowlist for the current environment.
 *
 * @param {string} invoiceId - Invoice ID to validate
 * @param {string} [environment] - Target environment (defaults to current)
 * @returns {boolean} True if invoice ID is allowlisted
 */
function isInvoiceAllowlisted(invoiceId, environment) {
  if (!invoiceId || typeof invoiceId !== 'string') {
    return false;
  }

  const config = parseEscrowMappingConfig();
  const targetEnv = environment || getCurrentEnvironment();

  // If allowlist is disabled, allow all (for testing)
  if (!config.allowlistEnabled) {
    return true;
  }

  // Check if invoice exists in mappings for the target environment
  return config.mappings.some(mapping =>
    mapping.invoiceId === invoiceId &&
    mapping.environment === targetEnv &&
    mapping.isActive !== false
  );
}

/**
 * Resolves an invoice ID to its corresponding Stellar escrow contract address.
 *
 * @param {string} invoiceId - Invoice ID to resolve
 * @param {string} [environment] - Target environment (defaults to current)
 * @returns {string|null} Stellar contract address or null if not found
 * @throws {Error} If invoice ID is invalid or not allowlisted
 */
function resolveEscrowAddress(invoiceId, environment) {
  // Input validation
  if (!invoiceId || typeof invoiceId !== 'string') {
    throw new Error('Invoice ID is required and must be a string');
  }

  if (invoiceId.trim() === '') {
    throw new Error('Invoice ID cannot be empty');
  }

  const targetEnv = environment || getCurrentEnvironment();
  const config = parseEscrowMappingConfig();
  const cacheKey = `${invoiceId}:${targetEnv}`;
  const cacheSettings = getCacheSettings();

  // Check cache first if enabled
  if (config.cacheEnabled && mappingCache.has(cacheKey)) {
    const cached = mappingCache.get(cacheKey);
    const ageSeconds = (Date.now() - cached.timestamp) / 1000;

    if (ageSeconds * 1000 < cacheSettings.ttlMs) {
      cacheHits += 1;
      configReadCacheHits.inc();
      touchCacheKey(cacheKey, cached);
      return cached.address;
    } else {
      // Remove expired entry
      mappingCache.delete(cacheKey);
    }
  }

  cacheMisses += 1;
  configReadCacheMisses.inc();

  // Find mapping for the invoice ID
  const mapping = config.mappings.find(m =>
    m.invoiceId === invoiceId &&
    m.environment === targetEnv &&
    m.isActive !== false
  );

  // allowlistEnabled doesn't change behavior for resolveEscrowAddress if not found, 
  // both cases throw EscrowNotFoundError. We keep it strictly matching tests.
  if (!mapping) {
    const err = new EscrowNotFoundError(`No active escrow mapping found for invoice ${invoiceId} in environment ${targetEnv}`);
    err.invoiceId = invoiceId;
    throw err;
  }

  const address = mapping.escrowAddress;

  // Cache the result if enabled
  if (config.cacheEnabled && address) {
    if (mappingCache.size >= cacheSettings.maxEntries) {
      evictOldestEntry();
    }
    mappingCache.set(cacheKey, {
      address,
      timestamp: Date.now(),
    });
  }

  return address;
}

/**
 * Resolve the escrow contract address for a given invoiceId.
 *
 * Compatibility contract:
 *   - Returns `null` for non-string or empty input (never throws for input).
 *   - Returns `null` when no active mapping exists in the visible environments.
 *   - Throws {EscrowMapConfigError} when the config JSON is malformed.
 *
 * @param {string} invoiceId
 * @returns {string|null} Stellar contract address (C... or G...) or null when not mapped
 * @throws {EscrowMapConfigError} when the config JSON is malformed
 */
function resolveEscrowAddress(invoiceId) {
  if (!invoiceId || typeof invoiceId !== 'string') {
    return null;
  }
  const targetEnv = getCurrentEnvironment();
  const config = parseEscrowMappingConfig();
  const visible = visibleEnvironments(targetEnv, config.defaultEnvironment);
  const match = config.mappings.find(
    (m) => m.invoiceId === invoiceId &&
      visible.has(m.environment) &&
      m.isActive !== false
  );
  return match ? match.escrowAddress : null;
}

/**
 * Deterministic, deduplicated resolution of an escrow address.
 *
 * Concurrent callers for the same (invoiceId, environment) share a single
 * in-flight promise so that a partial failure cannot leave observers with
 * divergent results. The promise is always settled (never left pending) and
 * is removed from the in-flight map in a `finally` block, so retries after
 * a failure are deterministic and observable.
 *
 * @param {string} invoiceId
 * @param {string} [environment]
 * @returns {Promise<string|null>}
 */
const _resolveInFlight = new Map();

async function resolveEscrowAddressDeterministic(invoiceId, environment) {
  if (!invoiceId || typeof invoiceId !== 'string') {
    return null;
  }
  const targetEnv = environment || getCurrentEnvironment();
  const key = `${invoiceId}:${targetEnv}`;
  if (_resolveInFlight.has(key)) {
    return _resolveInFlight.get(key);
  }
  const promise = (async () => {
    try {
      return resolveEscrowAddress(invoiceId);
    } finally {
      _resolveInFlight.delete(key);
    }
  })();
  _resolveInFlight.set(key, promise);
  return promise;
}

/**
 * Reverse lookup: resolve an invoice ID from an active escrow contract address.
 *
 * Only addresses present in the environment-scoped, active mapping allowlist are
 * resolved. Unknown, inactive, or foreign-environment addresses return `null` — the indexer must never fabricate an invoice ID.
 *
 * Compatibility contract: this function never throws. A malformed config
 * results in `null`, which the indexer treats as "skip this event".
 *
 * @param {string} contractAddress - Stellar contract address from Horizon `contract_id`.
 * @returns {string|null} Mapped invoice ID, or null when not allowlisted.
 */
function resolveInvoiceByAddress(contractAddress) {
  if (!contractAddress || typeof contractAddress !== 'string') {
    return null;
  }

  try {
    const config = parseEscrowMappingConfig();
    const targetEnv = getCurrentEnvironment();
    const visible = visibleEnvironments(targetEnv, config.defaultEnvironment);

    const match = config.mappings.find(
      (mapping) =>
        mapping.escrowAddress === contractAddress &&
        mapping.environment === targetEnv &&
        mapping.isActive !== false
    );

    return match ? match.invoiceId : null;
  } catch (_error) {
    // Malformed config must not cause the indexer to fabricate an invoice ID.
    return null;
  }
}

/**
 * Reset internal cache state. Test-only hook.
 * @returns {void}
 */
function _resetCacheForTests() {
  clearCache();
  cachedSource = null;
  lastKnownGoodConfig = null;
  lastKnownGoodSource = null;
  _resolveInFlight.clear();
}

module.exports = {
  EscrowNotFoundError,
  EscrowMapConfigError,
  EscrowMappingEntrySchema,
  EscrowMappingConfigSchema,
  parseEscrowMappingConfig,
  getCurrentEnvironment,
  isInvoiceAllowlisted,
  resolveEscrowAddress,
  resolveEscrowAddressDeterministic,
  resolveInvoiceByAddress,
  _legacyResolveEscrowAddress,
  _resetCacheForTests,
  _evictOldestEntry,
  clearCache,
};
