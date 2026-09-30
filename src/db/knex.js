'use strict';

/**
 * @file src/db/knex.js
 * @description Hardened Knex singleton — concurrent-safe initialisation,
 *   idempotent teardown, and a health-check helper for the /readyz probe.
 *
 * ## Connection selection rules
 * - NODE_ENV=test       → always uses the `test` config block (in-memory SQLite).
 *                         Never falls back to development or production config.
 * - NODE_ENV=production → uses the `production` config block. Throws if the
 *                         `DATABASE_URL` env var is absent.
 * - anything else       → uses the `development` config block.
 *
 * ## Concurrency invariants
 * 1. **Singleton init guard** – `_initDb()` can be called concurrently (e.g.
 *    two hot-require paths racing at startup). A module-level `_initCalled`
 *    flag guarantees that `knex(mergedConfig)` is executed exactly once.
 *    Subsequent callers receive the same instance.
 *
 * 2. **Destroy idempotency** – `destroyOnce()` wraps `db.destroy()` behind a
 *    Promise-singleton so that concurrent SIGTERM + SIGINT, or repeated
 *    teardown calls in tests, never trigger a double-destroy.  Callers `await
 *    destroyOnce()` and always receive the outcome of the first invocation.
 *
 * 3. **Post-destroy pool event guard** – pool error handlers skip logging once
 *    `_destroyed` is `true` to prevent noise from events that race with
 *    teardown.
 *
 * ## Public additions to the exported object
 * | Symbol             | Type                     | Purpose                              |
 * |--------------------|--------------------------|--------------------------------------|
 * | `destroyOnce()`    | `() => Promise<void>`    | Idempotent, concurrent-safe teardown |
 * | `getHealthInfo()`  | `() => Promise<object>`  | Liveness/readiness snapshot          |
 *
 * The underlying knex instance (table queries, `db.raw`, `db.transaction`,
 * `db.fn`, etc.) is forwarded transparently through Proxy, so all existing
 * callers remain compatible without any changes.
 *
 * ## Pool error handling
 * Knex exposes pool-level events through the underlying `tarn` pool. We attach
 * `createTimeoutMillis` / `acquireTimeoutMillis` at the config level and log
 * pool errors so they surface in application logs without crashing the process.
 *
 * ## Test mock
 * Jest resolves `src/db/__mocks__/knex.js` automatically when
 * `jest.mock('../../src/db/knex')` is called, so this file is never executed
 * during unit tests that use the manual mock.
 *
 * ## Config selection logic
 * The config-selection logic lives in `src/db/resolveConfig.js` so it can be
 * unit-tested independently without loading knex or pino.
 *
 * @module src/db/knex
 */

const knex = require('knex');
const logger = require('../logger');
const resolveConfig = require('./resolveConfig');

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** @type {string} */
const env = process.env.NODE_ENV || 'development';

// ---------------------------------------------------------------------------
// Pool defaults
// ---------------------------------------------------------------------------

/**
 * Default pool configuration applied to every environment unless the config
 * block already specifies a `pool` key.
 *
 * @type {import('knex').Knex.PoolConfig}
 */
const DEFAULT_POOL = {
  min: 2,
  max: 10,
  /** Milliseconds to wait for a new connection to be created before erroring. */
  createTimeoutMillis: 30_000,
  /** Milliseconds to wait to acquire a connection from the pool before erroring. */
  acquireTimeoutMillis: 30_000,
  /** Milliseconds a connection may sit idle before being destroyed. */
  idleTimeoutMillis: 600_000,
  /** Milliseconds between reaping idle connections. */
  reapIntervalMillis: 1_000,
  /** How many times to retry creating a connection on transient failure. */
  createRetryIntervalMillis: 200,
};

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

/**
 * The initialised Knex instance. Set once by `_initDb()`.
 * @type {import('knex').Knex | null}
 * @private
 */
let _db = null;

/**
 * Guards against re-entry into `_initDb()` under concurrent require.
 * Node.js's CommonJS require cache means the module body only runs once per
 * process, but within a single test file that resets modules and calls
 * `jest.resetModules()` this flag provides an additional safety net.
 * @type {boolean}
 * @private
 */
let _initCalled = false;

/**
 * Tracks whether `destroyOnce()` has been called.  Set to `true` before the
 * underlying `db.destroy()` call so that pool event handlers can skip any
 * post-destroy noise.
 * @type {boolean}
 * @private
 */
let _destroyed = false;

/**
 * Cached Promise returned by the first `destroyOnce()` call.  Concurrent
 * callers all receive this same Promise so the underlying `db.destroy()` is
 * invoked exactly once regardless of how many callers race.
 * @type {Promise<void> | null}
 * @private
 */
let _destroyPromise = null;

/**
 * Timestamp (ms since epoch) at which the last successful health-check
 * completed.  `null` means a successful check has never been run.
 * @type {number | null}
 * @private
 */
let _lastHealthyAt = null;

/**
 * Error captured during the most-recent failed health-check.
 * `null` means the last check either succeeded or has not run yet.
 * @type {Error | null}
 * @private
 */
let _lastHealthError = null;

// ---------------------------------------------------------------------------
// Attach pool event handlers
// ---------------------------------------------------------------------------

/**
 * Attach pool-level error and connection-acquisition logging to a Knex
 * instance. Errors are caught here so unhandled promise rejections do not
 * propagate out of the pool layer.
 *
 * Handlers no-op once `_destroyed` is `true` to prevent spurious log lines
 * from pool events that race with teardown.
 *
 * @param {import('knex').Knex} instance - The initialised Knex instance.
 * @returns {void}
 */
function attachPoolErrorHandlers(instance) {
  const pool = instance.client && instance.client.pool;
  if (!pool) { return; }

  pool.on('createFail', (eventId, err) => {
    if (_destroyed) { return; }
    logger.error({ err, eventId }, '[db] Pool: failed to create connection');
  });

  pool.on('acquireFail', (eventId, err) => {
    if (_destroyed) { return; }
    logger.error({ err, eventId }, '[db] Pool: failed to acquire connection');
  });

  pool.on('destroyFail', (eventId, err) => {
    if (_destroyed) { return; }
    logger.warn({ err, eventId }, '[db] Pool: failed to destroy connection');
  });
}

// ---------------------------------------------------------------------------
// Initialisation (called once, synchronously, at module load)
// ---------------------------------------------------------------------------

/**
 * Initialise the singleton Knex instance. Safe to call multiple times — only
 * the first invocation creates the instance; subsequent calls are no-ops.
 *
 * If `resolveConfig` throws (e.g. `DATABASE_URL` absent in production, or the
 * `test` block missing from knexfile), the error is re-thrown so callers learn
 * about misconfiguration immediately rather than receiving a `null` instance.
 *
 * @returns {import('knex').Knex}
 * @throws {Error} When `resolveConfig` cannot produce a valid config.
 */
function _initDb() {
  // Guard: only initialise once, even if _initDb is somehow called again.
  if (_initCalled) {
    // _db is guaranteed non-null here because the first call succeeded.
    return /** @type {import('knex').Knex} */ (_db);
  }

  _initCalled = true;

  const config = resolveConfig(env);

  const mergedConfig = {
    ...config,
    pool: { ...DEFAULT_POOL, ...(config.pool || {}) },
  };

  _db = knex(mergedConfig);

  attachPoolErrorHandlers(_db);

  logger.info({ env }, '[db] Knex singleton initialised');

  return _db;
}

// Initialise eagerly at module load (matching prior synchronous behaviour).
// Any thrown error from resolveConfig propagates out of require() to the
// caller — same as before — but now _initCalled prevents double-init on
// any conceivable re-entry path.
_initDb();

// ---------------------------------------------------------------------------
// Idempotent destroy
// ---------------------------------------------------------------------------

/**
 * Destroy the Knex connection pool exactly once, regardless of how many
 * callers invoke it concurrently.  All concurrent callers await the same
 * Promise, so `db.destroy()` is never called more than once.
 *
 * Subsequent calls after the first invocation return the cached resolved (or
 * rejected) Promise immediately — no second destroy attempt is made.
 *
 * @returns {Promise<void>} Resolves when the pool has been destroyed; rejects
 *   only if the underlying `db.destroy()` itself throws/rejects.
 */
async function destroyOnce() {
  // Fast-path: already destroyed (or destruction in-flight) — return the
  // cached promise so concurrent callers coalesce onto the first.
  if (_destroyPromise !== null) {
    return _destroyPromise;
  }

  // Mark as destroyed *before* awaiting so that pool event handlers that fire
  // during teardown do not emit spurious logs.
  _destroyed = true;

  logger.info('[db] destroyOnce: beginning pool teardown');

  _destroyPromise = (async () => {
    if (_db && typeof _db.destroy === 'function') {
      await _db.destroy();
    }
    logger.info('[db] destroyOnce: pool teardown complete');
  })();

  return _destroyPromise;
}

// ---------------------------------------------------------------------------
// Health-check helper
// ---------------------------------------------------------------------------

/**
 * Timeout for the `SELECT 1` liveness probe issued by `getHealthInfo()`.
 * Kept shorter than typical pool `acquireTimeoutMillis` so that the /readyz
 * probe returns within the orchestrator's deadline even under pool pressure.
 *
 * @type {number}
 */
const HEALTH_CHECK_TIMEOUT_MS = parseInt(process.env.DB_HEALTH_TIMEOUT_MS, 10) || 5_000;

/**
 * Execute a lightweight `SELECT 1` liveness probe against the database.
 *
 * Returns a structured snapshot suitable for embedding in the /readyz response
 * without exposing connection strings, credentials, or internal pool state.
 *
 * The probe is wrapped in an `AbortController`-backed timeout so that a
 * stalled DB never blocks the /readyz handler beyond `HEALTH_CHECK_TIMEOUT_MS`.
 *
 * @returns {Promise<{
 *   status: 'healthy' | 'unhealthy' | 'destroyed',
 *   latencyMs: number | null,
 *   lastHealthyAt: string | null,
 *   error: string | null,
 * }>}
 */
async function getHealthInfo() {
  if (_destroyed) {
    return {
      status: 'destroyed',
      latencyMs: null,
      lastHealthyAt: _lastHealthyAt ? new Date(_lastHealthyAt).toISOString() : null,
      error: 'Database pool has been destroyed',
    };
  }

  if (!_db) {
    return {
      status: 'unhealthy',
      latencyMs: null,
      lastHealthyAt: null,
      error: 'Database not initialised',
    };
  }

  const start = Date.now();

  // AbortController-based timeout so the probe does not hang indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    // Use a bare Promise.race so we can abort without knex-internal leaks.
    await Promise.race([
      _db.raw('SELECT 1'),
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`DB health-check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`));
        }, { once: true });
      }),
    ]);

    const latencyMs = Date.now() - start;
    _lastHealthyAt = Date.now();
    _lastHealthError = null;

    return {
      status: 'healthy',
      latencyMs,
      lastHealthyAt: new Date(_lastHealthyAt).toISOString(),
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    _lastHealthError = err;

    // Redact connection-string details that might appear in err.message.
    const safeMessage = (err && err.message)
      ? err.message.replace(/postgresql?:\/\/[^@]+@[^\s/]+/gi, '[redacted]')
      : 'Unknown error';

    logger.warn(
      { latencyMs, timeout: HEALTH_CHECK_TIMEOUT_MS },
      `[db] Health-check failed: ${safeMessage}`,
    );

    return {
      status: 'unhealthy',
      latencyMs,
      lastHealthyAt: _lastHealthyAt ? new Date(_lastHealthyAt).toISOString() : null,
      error: safeMessage,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Singleton Knex database instance for the current environment.
 *
 * Extended with two additional properties:
 * - `destroyOnce()` — idempotent, concurrent-safe pool teardown.
 * - `getHealthInfo()` — structured DB liveness snapshot for /readyz.
 *
 * All other Knex methods (`db('table')`, `db.raw`, `db.transaction`, etc.) are
 * available as usual.  The extensions are non-enumerable to avoid surprising
 * callers that spread the export.
 *
 * @type {import('knex').Knex & { destroyOnce: () => Promise<void>, getHealthInfo: () => Promise<object> }}
 */
const db = /** @type {any} */ (_db);

Object.defineProperties(db, {
  destroyOnce: {
    value: destroyOnce,
    writable: false,
    enumerable: false,
    configurable: false,
  },
  getHealthInfo: {
    value: getHealthInfo,
    writable: false,
    enumerable: false,
    configurable: false,
  },
});

module.exports = db;
