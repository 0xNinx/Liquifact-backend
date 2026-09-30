'use strict';

const { cacheConfig } = require('../config/cache');
const {
  escrowReadCacheHitsTotal,
  escrowReadCacheMissesTotal,
  escrowReadCacheEvictionsTotal,
} = require('../metrics');

/**
 * Bounded in-process TTL cache. Map insertion order provides LRU eviction:
 * every hit is reinserted at the newest position.
 *
 * Failure recovery invariants:
 * - A cache failure must never propagate to callers as a data-loss event; all
 *   public methods swallow internal errors and degrade to a miss/no-op.
 * - Metric emission failures are isolated so a broken metrics pipeline cannot
 *   corrupt cache state or break request handling.
 * - Concurrent access is safe because JS execution is single-threaded and each
 *   mutation is atomic within a turn.
 */
class EscrowReadCache {
  /**
   * Creates a bounded escrow response cache.
   * @param {object} [options] Cache options.
   * @param {number} [options.ttlMs] Entry lifetime in milliseconds.
   * @param {number} [options.maxEntries] Maximum retained responses.
   * @param {Function} [options.now] Clock used for deterministic tests.
   * @param {Function} [options.onError] Optional error reporter for observability.
   */
  constructor({
    ttlMs = cacheConfig.escrowTtl,
    maxEntries = cacheConfig.escrowMaxEntries,
    now = Date.now,
    onError = () => {},
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.onError = onError;
    this.entries = new Map();
  }

  /**
   * Safely emits a metric without letting observability failures affect callers.
   * @param {Function} fn Metric operation.
   * @returns {void}
   * @private
   */
  _safeMetric(fn) {
    try {
      fn();
    } catch (err) {
      this._reportError(err);
    }
  }

  /**
   * Reports an internal error without exposing sensitive data.
   * @param {Error} err Error to report.
   * @returns {void}
   * @private
   */
  _reportError(err) {
    try {
      this.onError(err);
    } catch (_) {
      // Never let error reporting break cache operations.
    }
  }

  /**
   * Reads and refreshes the recency of a cached response.
   * @param {string} invoiceId Cache key.
   * @returns {object|undefined} Cached response, or undefined on a miss.
   */
  get(invoiceId) {
    try {
      const entry = this.entries.get(invoiceId);
      if (!entry) {
        this._safeMetric(() => escrowReadCacheMissesTotal.inc());
        return undefined;
      }

      if (entry.expiresAt <= this.now()) {
        this.entries.delete(invoiceId);
        this._safeMetric(() => escrowReadCacheMissesTotal.inc());
        this._safeMetric(() =>
          escrowReadCacheEvictionsTotal.labels('expired').inc(),
        );
        return undefined;
      }

      this.entries.delete(invoiceId);
      this.entries.set(invoiceId, entry);
      this._safeMetric(() => escrowReadCacheHitsTotal.inc());
      return entry.value;
    } catch (err) {
      // A cache read failure must degrade to a miss, never break the caller.
      this._reportError(err);
      this._safeMetric(() => escrowReadCacheMissesTotal.inc());
      return undefined;
    }
  }

  /**
   * Stores a response and evicts least-recent entries beyond the bound.
   * @param {string} invoiceId Cache key.
   * @param {object} value Escrow read response.
   * @returns {void}
   */
  set(invoiceId, value) {
    try {
      if (this.entries.has(invoiceId)) {
        this.entries.delete(invoiceId);
      }
      this.entries.set(invoiceId, {
        value,
        expiresAt: this.now() + this.ttlMs,
      });

      while (this.entries.size > this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        this.entries.delete(oldestKey);
        this._safeMetric(() =>
          escrowReadCacheEvictionsTotal.labels('capacity').inc(),
        );
      }
    } catch (err) {
      // A cache write failure must not corrupt existing state or break the caller.
      this._reportError(err);
    }
  }

  /**
   * Removes one invoice response.
   * @param {string} invoiceId Cache key.
   * @returns {boolean} Whether an entry existed.
   */
  invalidate(invoiceId) {
    try {
      return this.entries.delete(invoiceId);
    } catch (err) {
      this._reportError(err);
      return false;
    }
  }

  /**
   * Removes every entry. Intended for lifecycle and test cleanup.
   * @returns {void}
   */
  clear() {
    try {
      this.entries.clear();
    } catch (err) {
      this._reportError(err);
    }
  }
}

const escrowReadCache = new EscrowReadCache();

module.exports = {
  EscrowReadCache,
  escrowReadCache,
};
