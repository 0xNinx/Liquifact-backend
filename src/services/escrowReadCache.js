'use strict';

const { cacheConfig } = require('../config/cache');
const {
  escrowReadCacheHitsTotal,
  escrowReadCacheMissesTotal,
  escrowReadCacheEvictionsTotal,
} = require('../metrics');

/**
 * Validation boundaries for the escrow read cache.
 *
 * Invariants:
 * - Cache keys are non-empty strings of bounded length.
 * - TTL and maxEntries are positive integers.
 * - Cached values are non-null objects.
 * - Invalid inputs are rejected with a TypeError or RangeError before any state mutation.
 */

const MAX_KEY_LENGTH = 512;
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 100000;
const MAX_VALUE_BYTES = 1024 * 1024; // 1 MiB serialized payload bound

/**
 * Validates a cache key.
 * @param {unknown} key Candidate key.
 * @param {string} name Parameter name for error messages.
 * @returns {string} The validated key.
 * @throws {TypeError} When the key is not a non-empty string.
 * @throws {RangeError} When the key exceeds the maximum length.
 */
function validateKey(key, name = 'invoiceId') {
  if (typeof key !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  if (key.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  if (key.trim().length === 0) {
    throw new TypeError(`${name} must not be blank`);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new RangeError(`${name} must not exceed ${MAX_KEY_LENGTH} characters`);
  }
  return key;
}

/**
 * Validates a cache value.
 * @param {unknown} value Candidate value.
 * @returns {object} The validated value.
 * @throws {TypeError} When the value is not a non-null object.
 * @throws {RangeError} When the serialized value exceeds the size bound.
 */
function validateValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('cache value must be a non-null object');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new TypeError('cache value must be JSON-serializable');
  }
  if (typeof serialized !== 'string') {
    throw new TypeError('cache value must be JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
    throw new RangeError(`cache value must not exceed ${MAX_VALUE_BYTES} bytes`);
  }
  return value;
}

/**
 * Validates a positive integer option.
 * @param {unknown} value Candidate value.
 * @param {string} name Parameter name for error messages.
 * @param {number} max Maximum allowed value.
 * @returns {number} The validated integer.
 * @throws {TypeError} When the value is not a positive integer.
 * @throws {RangeError} When the value exceeds the maximum.
 */
function validatePositiveInteger(value, name, max) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  if (value > max) {
    throw new RangeError(`${name} must not exceed ${max}`);
  }
  return value;
}

/**
 * Bounded in-process TTL cache. Map insertion order provides LRU eviction:
 * every hit is reinserted at the newest position.
 */
class EscrowReadCache {
  /**
   * Creates a bounded escrow response cache.
   * @param {object} [options] Cache options.
   * @param {number} [options.ttlMs] Entry lifetime in milliseconds.
   * @param {number} [options.maxEntries] Maximum retained responses.
   * @param {Function} [options.now] Clock used for deterministic tests.
   * @throws {TypeError|RangeError} When options are invalid.
   */
  constructor({
    ttlMs = cacheConfig.escrowTtl,
    maxEntries = cacheConfig.escrowMaxEntries,
    now = Date.now,
  } = {}) {
    this.ttlMs = validatePositiveInteger(ttlMs, 'ttlMs', MAX_TTL_MS);
    this.maxEntries = validatePositiveInteger(maxEntries, 'maxEntries', MAX_ENTRIES);
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  /**
   * Reads and refreshes the recency of a cached response.
   * @param {string} invoiceId Cache key.
   * @returns {object|undefined} Cached response, or undefined on a miss.
   * @throws {TypeError|RangeError} When the key is invalid.
   */
  get(invoiceId) {
    const key = validateKey(invoiceId);
    const entry = this.entries.get(key);
    if (!entry) {
      escrowReadCacheMissesTotal.inc();
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      escrowReadCacheMissesTotal.inc();
      escrowReadCacheEvictionsTotal.labels('expired').inc();
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    escrowReadCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a response and evicts least-recent entries beyond the bound.
   * @param {string} invoiceId Cache key.
   * @param {object} value Escrow read response.
   * @returns {void}
   * @throws {TypeError|RangeError} When the key or value is invalid.
   */
  set(invoiceId, value) {
    const key = validateKey(invoiceId);
    const safeValue = validateValue(value);
    const expiresAt = this.now() + this.ttlMs;

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, {
      value: safeValue,
      expiresAt,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      escrowReadCacheEvictionsTotal.labels('capacity').inc();
    }
  }

  /**
   * Removes one invoice response.
   * @param {string} invoiceId Cache key.
   * @returns {boolean} Whether an entry existed.
   * @throws {TypeError|RangeError} When the key is invalid.
   */
  invalidate(invoiceId) {
    const key = validateKey(invoiceId);
    return this.entries.delete(key);
  }

  /**
   * Removes every entry. Intended for lifecycle and test cleanup.
   * @returns {void}
   */
  clear() {
    this.entries.clear();
    this.inflight.clear();
  }
}

const escrowReadCache = new EscrowReadCache();

module.exports = {
  EscrowReadCache,
  escrowReadCache,
  validateKey,
  validateValue,
  MAX_KEY_LENGTH,
  MAX_VALUE_BYTES,
};
