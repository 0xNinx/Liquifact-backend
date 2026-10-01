// src/services/cacheStore.js
const {
  footprintCacheHitsTotal,
  footprintCacheMissesTotal,
  footprintCacheEvictionsTotal,
} = require('../metrics');

/**
 * Maximum allowed key length in characters. Keys longer than this are
 * rejected to avoid unbounded memory use and to keep metrics/logs safe.
 */
const MAX_KEY_LENGTH = 1024;

/**
 * Maximum allowed TVL in milliseconds (7 days). Prevents accidentally
 * caching entries effectively forever.
 */
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Error thrown when a cache input fails validation. Callers can catch this
 * to distinguish invalid input from other failures.
 */
class CacheValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CacheValidationError';
    this.code = code || 'CACHE_INVALID_INPUT';
  }
}

/**
 * Validates a cache key. Keys must be non-empty strings and must not
 * exceed MAX_KEY_LENGTH. Returns the key on success and throws a
 * CacheValidationError otherwise.
 *
 * @param {*} key - Candidate key.
 * @returns {string} The validated key.
 * @throws {CacheValidationError}
 */
function validateKey(key) {
  if (typeof key !== 'string') {
    throw new CacheValidationError(
      'Cache key must be a string',
      'CACHE_INVALID_KEY'
    );
  }
  if (key.length === 0) {
    throw new CacheValidationError(
      'Cache key must not be empty',
      'CACHE_EMPTY_KEY'
    );
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new CacheValidationError(
      `Cache key exceeds ${MAX_KEY_LENGTH} characters`,
      'CACHE_KEY_TOO_LONG'
    );
  }
  return key;
}

/**
 * Validates a TTL in milliseconds. TTLs must be finite numbers greater
 * than zero and must not exceed MAX_TTL_MS. Returns the TTL on success
 * and throws a CacheValidationError otherwise.
 *
 * @param {*} ttlMs - Candidate TTL in milliseconds.
 * @returns {number} The validated TTL.
 * @throws {CacheValidationError}
 */
function validateTtl(ttlMs) {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
    throw new CacheValidationError(
      'TTL must be a finite number in milliseconds',
      'CACHE_INVALID_TTL'
    );
  }
  if (ttlMs <= 0) {
    throw new CacheValidationError(
      'TTL must be greater than zero',
      'CACHE_INVALID_TTL'
    );
  }
  if (ttlMs > MAX_TTL_MS) {
    throw new CacheValidationError(
      `TTL exceeds maximum of ${MAX_TTL_MS}ms`,
      'CACHE_TTL_TOO_LONG'
    );
  }
  return ttlMs;
}

/**
 * Validates a key prefix used by delByPrefix. Prefixes must be strings
 * and must not exceed MAX_KEY_LENGTH. Empty prefixes are rejected because
 * they would match every key and silently wipe the entire cache.
 *
 * @param {*} prefix - Candidate prefix.
 * @returns {string} The validated prefix.
 * @throws {CacheValidationError}
 */
function validatePrefix(prefix) {
  if (typeof prefix !== 'string') {
    throw new CacheValidationError(
      'Cache prefix must be a string',
      'CACHE_INVALID_PREFIX'
    );
  }
  if (prefix.length === 0) {
    throw new CacheValidationError(
      'Cache prefix must not be empty',
      'CACHE_EMPTY_PREFIX'
    );
  }
  if (prefix.length > MAX_KEY_LENGTH) {
    throw new CacheValidationError(
      `Cache prefix exceeds ${MAX_KEY_LENGTH} characters`,
      'CACHE_PREFIX_TOO_LONG'
    );
  }
  return prefix;
}

/**
 * In-memory cache store backed by a native Map.
 * Each entry is stored with an expiry timestamp for TTL-based eviction.
 * Supports a configurable maximum number of entries with LRU eviction.
 * Metrics for hits, misses, and evictions are emitted via the metrics module.
 *
 * Validation invariants:
 *   - Keys must be non-empty strings of at most MAX_KEY_LENGTH characters.
 *   - TTLs must be finite numbers in (0, MAX_TTL_MS].
 *   - Prefixes must be non-empty strings of at most MAX_KEY_LENGTH characters.
 *   - Invalid inputs are rejected with CacheValidationError and do not
 *     mutate the cache or emit hit/miss/eviction metrics.
 *
 * @class
 */
class MemoryCacheStore {
  /**
   * Creates a new MemoryCacheStore instance with optional bounds.
   *
   * @param {object} [options] - Options for the cache store.
   * @param {number} [options.maxEntries] - Maximum number of entries before LRU eviction. Defaults to 5000.
   * @throws {CacheValidationError} If maxEntries is not a non-negative finite number.
   */
  constructor(options = {}) {
    const { maxEntries = 5000 } = options;
    if (
      typeof maxEntries !== 'number' ||
      !Number.isFinite(maxEntries) ||
      maxEntries < 0
    ) {
      throw new CacheValidationError(
        'maxEntries must be a non-negative finite number',
        'CACHE_INVALID_MAX_ENTRIES'
      );
    }
    // treat non-positive values as unlimited (Infinity) to preserve backward compatibility
    this._maxEntries = maxEntries > 0 ? maxEntries : Infinity;
    // Map preserves insertion order – ye will delete/re‑insert on access to maintain LRU ordering
    this._cache = new Map();
  }

  /**
   * Retrieves a cached value by key. Returns undefined if the key is missing
   * or expired. Expired entries are lazily evicted. Updates LRU order on hit.
   *
   * @param {string} key - The cache key to look up.
   * @returns {*} The cached value, or undefined if missing/expired.
   * @throws {CacheValidationError} If the key is invalid.
   */
  get(key) {
    validateKey(key);
    const entry = this._cache.get(key);
    if (!entry) {
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      // TTL expiry – treat as miss and clean up
      this._cache.delete(key);
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    // Cache hit – move entry to the end to mark it as most—recently used
    this._cache.delete(key);
    this._cache.set(key, entry);
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
   * @throws {CacheValidationError} If the key or TTL is invalid.
   */
  set(key, value, ttlMs) {
    validateKey(key);
    validateTtl(ttlMs);
    // If key already exists, delete it first so that insertion order reflects recency
    if (this._cache.has(key)) {
      this._cache.delete(key);
    }
    const entry = { value, expiresAt: Date.now() + ttlMs };
    this._cache.set(key, entry);
    // Evict least‐recently used entries while we exceed the bound
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
   * @throws {CacheValidationError} If the key is invalid.
   */
  del(key) {
    validateKey(key);
    this._cache.delete(key);
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
      if (now <= entry.expiresAt) {
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
   * @throws {CacheValidationError} If the prefix is invalid.
   */
  delByPrefix(prefix) {
    validatePrefix(prefix);
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (now > entry.expiresAt) {
        this._cache.delete(key);
      } else if (key.startsWith(prefix)) {
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

let _sharedInstance = null;

module.exports = {
  MemoryCacheStore,
  CacheValidationError,
  createCacheStore,
  getSharedStore,
  MAX_KEY_LENGTH,
  MAX_TTL_MS,
};
