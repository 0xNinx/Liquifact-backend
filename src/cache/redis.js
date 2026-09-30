'use strict';

const { CircuitBreaker } = require('../utils/circuitBreaker');
const { redisCacheFailOpenTotal } = require('../metrics');

const DEFAULT_TTL_SECONDS = 30;
const MIN_TTL_SECONDS = 5;
const MAX_TTL_SECONDS = 300;

const DEFAULT_LEDGER_GAP_THRESHOLD = 3;
const MAX_LEDGER_GAP_THRESHOLD = 1000;

const DEFAULT_TIMEOUT_MS = 500;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 5000;

let redis;
try {
  redis = require('redis');
} catch (_e) {
  redis = null;
}

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
let redisClient = null;
let isRedisConnected = false;

if (redis && (process.env.NODE_ENV !== 'test' || process.env.USE_REDIS_TEST === 'true')) {
  redisClient = redis.createClient({ url: REDIS_URL });

  redisClient.on('connect', () => {
    isRedisConnected = true;
    console.log('Redis client linked securely.');
  });

  redisClient.on('error', (err) => {
    isRedisConnected = false;
    console.warn('tedis connection degraded or broken:', err.message);
  });

  redisClient.connect().catch((err) => {
    console.warn('Initial Redis connection handshake failed:', err.message);
  });
}

/**
 * Returns the active Redis client context along with its real-time health availability flag.
 *
 * Used by [`src/middleware/rateLimit.js`](../middleware/rateLimit.js) to share
 * the cache-layer Redis client for distributed counters when the operator has
 * not passed an explicit `redisClient` to createRateLimiter(...)
 *
 * @returns {{client: object|null, isAvailable: boolean}} Active client + liveness.
 */
function getRedisClient() {
  return { client: redisClient, isAvailable: isRedisConnected };
}

/**
 * Parses a raw value into a positive integer within a specified range.
 * @param {any} rawValue The value to parse.
 * @param {number} fallback The fallback value if parsing fails.
 * @param {number} min The minimum allowed value.
 * @param {number} max The maximum allowed value.
 * @returns {number} The parsed integer or fallback.
 */
function parsePositiveInt(rawValue, fallback, min, max) {
  const parsed = Number.parseInt(String(rawValue || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Parses Redis escrow cache configuration from environment variables.
 * @param {Object} env The environment variables object.
 * @returns {Object} The parsed configuration object.
 */
function parseRedisEscrowCacheConfig(env = process.env) {
  const enabled = String(env.REDIS_ESCROW_CACHE_ENABLED || '').toLowerCase() === 'true';
  const redisUrl = env.REDIS_URL || '';

  return {
    enabled: enabled && Boolean(redisUrl),
    redisUrl,
    ttlSeconds: parsePositiveInt(
      env.REDIS_ESCROW_CACHE_TTL_SECONDS,
      DEFAULT_TTL_SECONDS,
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS
    ),
    ledgerGapThreshold: parsePositiveInt(
      env.REDIS_ESCROW_LEDGER_GAP_THRESHOLD,
      DEFAULT_LEDGER_GAP_THRESHOLD,
      1,
      MAX_LEDGER_GAP_THRESHOLD
    ),
    timeoutMs: parsePositiveInt(
      env.REDIS_ESCROW_CACHE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
  };
}

/**
 * Creates a Redis client based on the provided configuration.
 * @param {Object} config The configuration object.
 * @param {Function} [RedisCtor] Optional Redis constructor for testing.
 * @returns {Object|null} The Redis client or null if not enabled.
 */
function createRedisClient(config = parseRedisEscrowCacheConfig(), RedisCtor) {
  if (!config.enabled) {
    return null;
  }

  const Redis = RedisCtor || require('ioredis');
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

/**
 * Validates an invoice ID.
 * @param {string} invoiceId The invoice ID to validate.
 * @returns {boolean} True if the invoice ID is valid.
 */
function isValidInvoiceId(invoiceId) {
  return typeof invoiceId === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(invoiceId);
}

/**
 * Races a promise against a timeout. Rejects with a timeout error if the
 * promise does not settle within `ms` milliseconds.
 * @param {Promise<any>} promise The promise to race.
 * @param {number} ms Timeout in milliseconds.
 * @returns {Promise<any>} The result of the promise or a timeout rejection.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Redis operation timed out'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Validates that a summary object is safe to serialize and cache.
 * Rejects primitives, null, arrays, and objects with a circular reference.
 * @param {any} summary The candidate summary.
 * @returns {boolean} True if the summary is a cacheable plain object.
 */
function isCacheableSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return false;
  }
  try {
    JSON.stringify(summary);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the decoded cache envelope. Returns the envelope when it is well
 * formed and null otherwise. Ensures that corrupted or foreign payloads cannot
 * propagate into callers as valid cache hits.
 * @param {string|null|undefined} raw The raw Redis value.
 * @returns {Object|null} The validated envelope or null.
 */
function parseCacheEnvelope(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return null;
  }
  if (!envelope.summary || typeof envelope.summary !== 'object' || Array.isArray(envelope.summary)) {
    return null;
  }
  if (envelope.cachedLedger !== null && !Number.isFinite(envelope.cachedLedger)) {
    return null;
  }
  return envelope;
}

class RedisEscrowSummaryCache {
  /**
   * Initializes the RedisEscrowSummaryCache.
   * @param {Object} root0 Configuration object.
   * @param {Object} root0.client The Redis client.
   * @param {number} [root0.ttlSeconds] Time-to-live in seconds.
   * @param {number} [root0.ledgerGapThreshold] Maximum allowed ledger gap.
   * @param {string} [root0.keyPrefix] Prefix for Redis keys.
   * @param {number} [root0.timeoutMs] Per-operation timeout in milliseconds.
   * @param {Object} [root0.circuitBreaker] Optional CircuitBreaker instance for DI.
   */
  constructor({
    client,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    ledgerGapThreshold = DEFAULT_LEDGER_GAP_THRESHOLD,
    keyPrefix = 'escrow:summary',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    circuitBreaker,
  }) {
    this.client = client;
    this.ttlSeconds = ttlSeconds;
    this.ledgerGapThreshold = ledgerGapThreshold;
    this.keyPrefix = keyPrefix;
    this.timeoutMs = timeoutMs;

    /** @type {CircuitBreaker} Shared breaker — falls back to null so callers never see throws. */
    this.circuitBreaker = circuitBreaker || new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeout: 10000,
      fallbackLogic: () => null,
    });
  }

  /**
   * Generates a Redis key for a given invoice ID.
   * @param {string} invoiceId The invoice ID.
   * @returns {string} The Redis key.
   */
  key(invoiceId) {
    return `${this.keyPrefix}:${invoiceId}`;
  }

  /**
   * Retrieves an escrow summary from the cache.
   * Wraps the Redis GET in a bounded timeout and circuit breaker.
   * On any Redis/timeout/CB failure, fails open by returning a cache miss
   * so the caller falls through to the DB/RPC layer.
   *
   * Invariants:
   * - Only validated invoice IDs reach Redis.
   * - Only well-formed envelopes are returned as hits; corrupt payloads are
   *   treated as misses and best-effort evicted.
   * - Ledger-gap eviction is atomic with respect to the returned result:
   *   we never return a hit for an entry we just decided to invalidate.
   * @param {string} invoiceId The invoice ID.
   * @param {number} [currentLedger] The current ledger sequence.
   * @returns {Promise<Object>} The cache result including hit status and value.
   */
  async getSummary(invoiceId, currentLedger) {
    if (!this.client || !isValidInvoiceId(invoiceId)) {
      return { hit: false, reason: 'invalid_input' };
    }

    const key = this.key(invoiceId);

    try {
      const raw = await this.circuitBreaker.execute(() =>
        withTimeout(this.client.get(key), this.timeoutMs)
      );

      // Circuit breaker fallback returns null — treat as fail-open miss.
      if (raw === null) {
        return { hit: false, reason: 'miss' };
      }

      const envelope = parseCacheEnvelope(raw);
      if (!envelope) {
        // Corrupt or foreign payload — evict best-effort and fail open.
        await this._safeDelete(key);
        return { hit: false, reason: 'corrupt' };
      }

      if (
        Number.isFinite(currentLedger) &&
        Number.isFinite(envelope.cachedLedger) &&
        Math.abs(currentLedger - envelope.cachedLedger) > this.ledgerGapThreshold
      ) {
        await this._safeDelete(key);
        return { hit: false, reason: 'ledger_gap' };
      }

      return { hit: true, value: envelope.summary };
    } catch {
      // Redis error, timeout, or circuit breaker exception — fail open.
      redisCacheFailOpenTotal.inc();
      return { hit: false, reason: 'fail_open' };
    }
  }

  /**
   * Sets an escrow summary in the cache.
   * Wraps the Redis SET in a bounded timeout and circuit breaker.
   * On any failure, fails open by returning false so the caller
   * proceeds without caching. Never throws.
   *
   * Invariants:
   * - Only validated invoice IDs and cacheable summaries are written.
   * - The envelope always contains a stringifiable summary and a numeric
   *   or null cachedLedger, so readers can trust the shape.
   * @param {string} invoiceId The invoice ID.
   * @param {Object} summary The summary object to cache.
   * @param {number} [currentLedger] The current ledger sequence.
   * @returns {Promise<boolean>} True if the summary was successfully cached.
   */
  async setSummary(invoiceId, summary, currentLedger) {
    if (!this.client || !isValidInvoiceId(invoiceId)) {
      return false;
    }
    if (!isCacheableSummary(summary)) {
      return false;
    }

    const key = this.key(invoiceId);
    const payload = JSON.stringify({
      summary,
      cachedLedger: Number.isFinite(currentLedger) ? currentLedger : null,
      cachedAt: new Date().toISOString(),
    });

    try {
      const result = await this.circuitBreaker.execute(() =>
        withTimeout(this.client.set(key, payload, 'EX', this.ttlSeconds), this.timeoutMs)
      );
      // Circuit breaker fallback returns null on trip.
      return result !== null;
    } catch {
      // Redis error, timeout, or circuit breaker exception — fail open.
      redisCacheFailOpenTotal.inc();
      return false;
    }
  }

  /**
   * Deletes an invoice summary after a successful escrow write.
   * Failures are non-fatal because callers can still invalidate their local cache.
   * @param {string} invoiceId The invoice ID.
   * @returns {Promise<boolean}> Whether Redis accepted the deletion.
   */
  async deleteSummary(invoiceId) {
    if (!this.client || !isValidInvoiceId(invoiceId)) {
      return false;
    }
    try {
      const result = await this.circuitBreaker.execute(() =>
        withTimeout(this.client.del(this.key(invoiceId)), this.timeoutMs)
      );
      return result !== null;
    } catch {
      redisCacheFailOpenTotal.inc();
      return false;
    }
  }

  /**
   * Best-effort delete that never throws. Used for invalidating corrupt or stale
   * entries during reads; failures are swallowed because the TTL will eventually
   * clean the key up.
   * @param {string} key The Redis key.
   * @returns {Promise<void>}
   * @private
   */
  async _safeDelete(key) {
    try {
      await withTimeout(this.client.del(key), this.timeoutMs);
    } catch {
      // Best-effort only — TTL will reclaim the key.
    }
  }
}

module.exports = {
  RedisEscrowSummaryCache,
  getRedisClient,
  parseRedisEscrowCacheConfig,
  createRedisClient,
  isValidInvoiceId,
  withTimeout,
  isCacheableSummary,
  parseCacheEnvelope,
};
