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
 *
 * Invariants:
 * - `this.entries.size <= this.maxEntries` after every mutating operation.
 * - Every retained entry has a numeric `key`, a defined `value`, and a
 *   numeric `expiresAt`.
 * - Map iteration order is oldest -> newest, so the first key is the
 *   LRU/expiration candidate.
 * - Only non-expired entries are returned from `get`.
 * - Metrics are emitted only for completed operations (hit, miss,
 *   eviction), never for rejected inputs.
 */
class EscrowReadCache {
  /**
   * Creates a bounded escrow response cache.
   * @param {object} [options] Cache options.
   * @param {number} [options.ttlMs] Entry lifetime in milliseconds.
   * @param {number} [options.maxEntries] Maximum retained responses.
   * @param {Function} [options.now] Clock used for deterministic tests.
   * @throws {TypeError} When ttlMs is not a non-negative finite number.
   * @throws {TypeError} When maxEntries is not a positive integer.
   * @throws {TypeError} When now is not a function.
   */
  constructor({
    ttlMs = cacheConfig.escrowTtl,
    maxEntries = cacheConfig.escrowMaxEntries,
    now = Date.now,
  } = {}) {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError('ttlMs must be a non-negative finite number');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }

    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  /**
   * Reads and refreshes the recency of a cached response.
   * @param {string} invoiceId Cache key.
   * @returns {object|undefined} Cached response, or undefined on a miss.
   * @throws {TypeError} When invoiceId is not a non-empty string.
   */
  get(invoiceId) {
    this._assertKey(invoiceId);

    const entry = this.entries.get(invoiceId);
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

    // Refresh recency: delete then reinsert so the key moves to the end.
    this.entries.delete(invoiceId);
    this.entries.set(invoiceId, entry);
    escrowReadCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a response and evicts least-recent entries beyond the bound.
   * @param {string} invoiceId Cache key.
   * @param {object} value Escrow read response.
   * @returns {void}
   * @throws {TypeError} When invoiceId is not a non-empty string or value is null/undefined.
   */
  set(invoiceId, value) {
    this._assertKey(invoiceId);
    if (value === null || value === undefined) {
      throw new TypeError('value must be defined');
    }

    // Reinserting an existing key must not grow the cache.
    if (this.entries.has(invoiceId)) {
      this.entries.delete(invoiceId);
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
   * @throws {TypeError} When invoiceId is not a non-empty string.
   */
  invalidate(invoiceId) {
    this._assertKey(invoiceId);
    return this.entries.delete(invoiceId);
  }

  /**
   * Removes every entry. Intended for lifecycle and test cleanup.
   * @returns {void}
   */
  clear() {
    this.entries.clear();
    this.inflight.clear();
  }

  /**
   * Number of retained entries. Exposed for observability and tests.
   * @returns {number}
   */
  get size() {
    return this.entries.size;
  }

  /**
   * @param {unknown} key
   * @returns {void}
   * @throws {TypeError}
   * @private
   */
  _assertKey(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('invoiceId must be a non-empty string');
    }
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
