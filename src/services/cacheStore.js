'use strict';

/**
 * In-memory cache store backed by a native Map.
 * Each entry is stored with an expiry timestamp for TTL-based eviction.
 * Supports a configurable maximum number of entries with LRU eviction.
 * Metrics for hits, misses, and evictions are emitted via the metrics module.
 *
 * @class
 */
const { footprintCacheHitsTotal, footprintCacheMissesTotal, footprintCacheEvictionsTotal } = require('../metrics');

const DEFAULT_MAX_ENTRIES = 5000;

/**
 * Validates and normalizes a cache key.
 *
 * Invariant: every key stored in the cache is a non-empty string.
 * This prevents accidental collisions between undefined/null/number keys
 * and ensures that prefix-based invalidation (delByPrefix) is deterministic.
 *
 * @param {*} key - The candidate key.
 * @returns {string} The normalized key.
 * @throws {TypeError} If the key is not a non-empty string.
 */
function normalizeKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('Cache key must be a non-empty string');
  }
  return key;
}

/**
 * Validates and normalizes a TTL value.
 *
 * Invariant: TTLs are finite, non-negative numbers. A negative or
 * non-numeric TTL would produce an already-expired entry or NaN expiry,
 * both of which silently break lookup semantics.
 *
 * @param {*} ttlMs - The candidate TTL.
 * @returns {number} The normalized TTL.
 * @throws {TypeError} If the TT\ is not a finite, non-negative number.
 */
function normalizeTtl(ttlMs) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError('Cache TT\ must be a finite, non-negative number');
  }
  return ttlMs;
}

/**
 * Validates and normalizes the maxEntries option.
 *
 * Invariant: the cache bound is either a positive integer or Infinity.
 * Non-positive, NaN, or non-numeric values are treated as unlimited to
 * preserve backward compatibility with existing callers.
 *
 * @param {*} maxEntries - The candidate bound.
 * @returns {number} The normalized bound.
 */
function normalizeMaxEntries(maxEntries) {
  if (typeof maxEntries === 'number' && Number.isFinite(maxEntries) && maxEntries > 0) {
    return Math.floor(maxEntries);
  }
  return Infinity;
}

class MemoryCacheStore {
  /**
   * Creates a new MemoryCacheStore instance with optional bounds.
   *
   * @param {object} [options] - Options for the cache store.
   * @param {number} [options.maxEntries] - Maximum number of entries before LRU eviction. Defaults to 5000.
   */
  constructor(options = {}) {
    const { maxEntries = DEFAULT_MAX_ENTRIES } = options;
    // treat non-positive values as unlimited (Infinity) to preserve backward compatibility
    this._maxEntries = normalizeMaxEntries(maxEntries);
    // Map preserves insertion order – we will delete/re‑insert on access to maintain LRU ordering
    this._cache = new Map();
  }

  /**
   * Retrieves a cached value by key. Returns undefined if the key is missing
   * or expired. Expired entries are lazily evicted. Updates LRU order on hit.
   *
   * @param {string} key - The cache key to look up.
   * @returns {*} The cached value, or undefined if missing/expired.
   */
  get(key) {
    const normalizedKey = normalizeKey(key);
    const entry = this._cache.get(normalizedKey);
    if (!entry) {
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      // TTL expiry – treat as miss and clean up
      this._cache.delete(normalizedKey);
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    // Cache hit – move entry to the end to mark it as most-recently used
    this._cache.delete(normalizedKey);
    this._cache.set(normalizedKey, entry);
    footprintCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a value in the cache with a TTL in milliseconds.
   * Enforces the LRU bound after insertion.
   *
   * @param {string} key - The cache key.
   * @param {*} value - The value to cache.
   * @param {number} ttlMs - Time-to-live in milliseconds.
   * @returns {void}
   */
  set(key, value, ttlMs) {
    const normalizedKey = normalizeKey(key);
    const normalizedTtl = normalizeTtl(ttlMs);
    // If key already exists, delete it first so that insertion order reflects recency
    if (this._cache.has(normalizedKey)) {
      this._cache.delete(normalizedKey);
    }
    const entry = { value, expiresAt: Date.now() + normalizedTtl };
    this._cache.set(normalizedKey, entry);
    // Evict least‑recently used entries while we exceed the bound
    while (this._cache.size > this._maxEntries) {
      const lruKey = this._cache.keys().next().value;
      this._cache.delete(lruKey);
      footprintCacheEvictionsTotal.inc();
    }
  }

  /**
   * Removes a specific entry from the cache.
   *
   * @param {string} key - The cache key to remove.
   * @returns {void}
   */
  del(key) {
    const normalizedKey = normalizeKey(key);
    this._cache.delete(normalizedKey);
  }

  /**
   * Returns all currently valid (non-expired) cache keys.
   *
   * Expired entries are lazily evicted during iteration.
   *
   * @returns {string[]} Array of active cache keys.
   */
  keys() {
    const now = Date.now();
    const valid = [];
    for (const [key, entry] of this._cache) {
      if (now < entry.expiresAt) {
        valid.push(key);
      } else {
        this._cache.delete(key);
      }
    }
    return valid;
  }

  /**
   * Deletes all cache entries whose key starts with the given prefix.
   * Expired entries are also cleaned up during iteration.
   *
   * @param {string} prefix - The key prefix to match.
   * @returns {void}
   */
  delByPrefix(prefix) {
    const normalizedPrefix = normalizeKey(prefix);
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (now >= entry.expiresAt) {
        this._cache.delete(key);
      } else if (key.startsWith(normalizedPrefix)) {
        this._cache.delete(key);
      }
    }
  }

  /**
   * Removes all entries from the cache.
   *
   * @returns {void}
   */
  clear() {
    this._cache.clear();
  }
}

/**
 * Factory function that creates a cache store instance.
 * Currently returns a MemoryCacheStore. Future implementations can check
 * for REDIS_URL and return a Redis-backed store.
 *
 * @param {object} [options] Options passed to the MemoryCacheStore constructor.
 * @returns {MemoryCacheStore} A cache store instance.
 */
function createCacheStore(options = {}) {
  return new MemoryCacheStore(options);
}

/**
 * Returns a shared singleton cache store instance.
 *
 * All middleware and services that need to read or invalidate cache entries
 * should use this instance to ensure consistency.
 *
 * @returns {MemoryCacheStore} The shared cache store.
 */
function getSharedStore() {
  if (!_sharedInstance) {
    _sharedInstance = new MemoryCacheStore();
  }
  return _sharedInstance;
}

/**
 * Resets the shared singleton instance.
 *
 * Primarily intended for tests and for explicit lifecycle resets (e.g.
 * graceful shutdown or configuration reload). Production code should not
 * call this during normal operation as it drops all cached entries.
 *
 * @returns {void}
 */
function resetSharedStore() {
  _sharedInstance = null;
}

let _sharedInstance = null;

module.exports = {
  MemoryCacheStore,
  createCacheStore,
  getSharedStore,
  resetSharedStore,
  normalizeKey,
  normalizeTtl,
};
