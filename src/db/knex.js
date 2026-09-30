'use strict';

/**
 * @file src/db/knex.js
 * @description Knex connection factory with lifecycle state invariants.
 *
 * Connection selection rules
 * --------------------------
 * - NODE_ENV=test       → always uses the `test` config block (in-memory SQLite).
 *                         Never falls back to development or production config.
 * - NODE_ENV=production → uses the `production` config block. Throws if the
 *                         `DATABASE_URL` env var is absent. Enforces TLS via
 *                         `ssl: { rejectUnauthorized: true }` unless explicitly
 *                         overridden by DATABASE_SSL=false (not recommended).
 * - anything else       → uses the `development` config block.
 *
 * State invariants
 * ----------------
 * The module tracks three lifecycle states:
 *
 *   READY       – the pool is healthy and ready to serve queries.
 *   DESTROYING  – db.destroy() has been called; no new queries may be issued.
 *   DESTROYED   – the pool has been fully torn down.
 *
 * Any attempt to call a query method (db(table), db.raw, db.transaction, etc.)
 * while in DESTROYING or DESTROYED state throws a `DatabaseLifecycleError`
 * with code `DB_ALREADY_DESTROYED`.  This makes query-after-shutdown bugs
 * immediately visible instead of silently hanging or producing cryptic errors.
 *
 * Pool error handling
 * -------------------
 * Knex exposes pool-level events through the underlying `tarn` pool. We attach
 * `createTimeoutMillis` / `acquireTimeoutMillis` at the config level and log
 * pool errors so they surface in application logs without crashing the process.
 *
 * Pool config bounds
 * ------------------
 * Pool min/max/timeout values provided by the knexfile or environment are
 * clamped to safe operating bounds before being passed to Knex:
 *
 *   pool.min  → clamped to [0, 50]
 *   pool.max  → clamped to [1, 100]
 *   pool.min  → further ensured ≤ pool.max after clamping
 *   createTimeoutMillis  → clamped to [1 000, 120 000] ms
 *   acquireTimeoutMillis → clamped to [1 000, 120 000] ms
 *   idleTimeoutMillis    → clamped to [1 000, 3 600 000] ms
 *
 * Test mock
 * ---------
 * Jest resolves `src/db/__mocks__/knex.js` automatically when
 * `jest.mock('../../src/db/knex')` is called, so this file is never executed
 * during unit tests that use the manual mock.
 *
 * Config selection logic
 * ----------------------
 * The config-selection logic lives in `src/db/resolveConfig.js` so it can be
 * unit-tested independently without loading knex or pino.
 *
 * @module src/db/knex
 */

const knex = require('knex');
const logger = require('../logger');
const resolveConfig = require('./resolveConfig');

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

/**
 * Possible lifecycle states for the database connection pool.
 * @enum {string}
 */
const DB_STATE = Object.freeze({
  READY: 'READY',
  DESTROYING: 'DESTROYING',
  DESTROYED: 'DESTROYED',
});

/**
 * Current lifecycle state of the db singleton.
 * Mutated only by `patchForLifecycle`.
 * @type {string}
 */
let _dbState = DB_STATE.READY;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a query is attempted against a pool that is being torn down or
 * has already been destroyed.
 */
class DatabaseLifecycleError extends Error {
  /**
   * @param {string} message - Human-readable message.
   * @param {string} [state] - The DB_STATE value at the time of the error.
   */
  constructor(message, state) {
    super(message);
    this.name = 'DatabaseLifecycleError';
    /** Stable machine-readable code for programmatic handling. */
    this.code = 'DB_ALREADY_DESTROYED';
    /** The lifecycle state that caused this error (DESTROYING or DESTROYED). */
    this.dbState = state || _dbState;
  }
}

// ---------------------------------------------------------------------------
// Pool configuration bounds
// ---------------------------------------------------------------------------

/**
 * Hard limits for pool configuration values. Values outside these ranges
 * are clamped silently – no exception is thrown, but a warning is logged so
 * operators can correct misconfigured knexfiles.
 *
 * @type {Readonly<Record<string, {min: number, max: number}>>}
 */
const POOL_BOUNDS = Object.freeze({
  min:                  { min: 0,     max: 50        },
  max:                  { min: 1,     max: 100       },
  createTimeoutMillis:  { min: 1_000, max: 120_000   },
  acquireTimeoutMillis: { min: 1_000, max: 120_000   },
  idleTimeoutMillis:    { min: 1_000, max: 3_600_000 },
  reapIntervalMillis:   { min: 100,   max: 60_000    },
  createRetryIntervalMillis: { min: 50, max: 10_000  },
});

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

/**
 * Clamp a numeric value to [lo, hi], returning the original value when it is
 * already within bounds and returning the bound when it is outside.
 *
 * @param {number} value - Value to clamp.
 * @param {number} lo    - Minimum (inclusive).
 * @param {number} hi    - Maximum (inclusive).
 * @returns {number} Clamped value.
 */
function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Validate and clamp pool configuration values to safe operating bounds.
 * Logs a warning for each value that was out of range, so configuration
 * mistakes surface in application logs.
 *
 * @param {import('knex').Knex.PoolConfig} pool - Raw pool config (may be partial).
 * @returns {import('knex').Knex.PoolConfig} Clamped pool config.
 */
function validateAndClampPool(pool) {
  const result = { ...pool };

  for (const [key, bounds] of Object.entries(POOL_BOUNDS)) {
    if (!(key in result) || typeof result[key] !== 'number') {
      continue;
    }
    const original = result[key];
    const clamped = clamp(original, bounds.min, bounds.max);
    if (clamped !== original) {
      logger.warn(
        { key, original, clamped, min: bounds.min, max: bounds.max },
        `[db] Pool config value for "${key}" (${original}) is outside safe bounds ` +
        `[${bounds.min}, ${bounds.max}]; clamped to ${clamped}.`
      );
      result[key] = clamped;
    }
  }

  // Enforce min ≤ max after individual clamping.
  if (typeof result.min === 'number' && typeof result.max === 'number') {
    if (result.min > result.max) {
      logger.warn(
        { min: result.min, max: result.max },
        `[db] Pool min (${result.min}) exceeds max (${result.max}) after clamping; ` +
        `setting min = max = ${result.max}.`
      );
      result.min = result.max;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Production TLS enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce TLS for production PostgreSQL connections unless the operator has
 * explicitly opted out via DATABASE_SSL=false.
 *
 * This guard runs at module load time so misconfigurations are detected at
 * startup rather than at the first query.
 *
 * @param {string} env - The current NODE_ENV value.
 * @param {import('knex').Knex.Config} config - The resolved Knex config block.
 * @returns {import('knex').Knex.Config} Config with SSL settings applied.
 */
function applyProductionTls(env, config) {
  if (env !== 'production') {
    return config;
  }
  if (config.client !== 'pg' && config.client !== 'postgres' && config.client !== 'postgresql') {
    // Non-PostgreSQL drivers (e.g. mysql2) handle TLS differently.
    return config;
  }

  const sslDisabled = (process.env.DATABASE_SSL || '').toLowerCase() === 'false';
  if (sslDisabled) {
    logger.warn(
      '[db] DATABASE_SSL=false: TLS enforcement is disabled for production PostgreSQL. ' +
      'This is NOT recommended and may expose connections to eavesdropping.'
    );
    return config;
  }

  // Do not overwrite an explicit ssl config set by the operator in knexfile.
  if (config.connection && typeof config.connection === 'object' && config.connection.ssl) {
    return config;
  }

  // Build the patched connection with TLS enabled.
  const patched = {
    ...config,
    connection: {
      ...(typeof config.connection === 'object' ? config.connection : {}),
      connectionString: typeof config.connection === 'string'
        ? config.connection
        : undefined,
      ssl: { rejectUnauthorized: true },
    },
  };

  // If the original connection was a plain string (URL), keep it as-is and
  // layer on the ssl object separately so Knex can parse the URL.
  if (typeof config.connection === 'string') {
    patched.connection = config.connection;
    patched.pool = patched.pool || {};
    // Attach ssl config via the knex `ssl` option at the top level when
    // the connection is a string — Knex passes it through to pg.
    if (!patched.ssl) {
      patched.ssl = { rejectUnauthorized: true };
    }
  }

  logger.info('[db] Production TLS enforcement active (ssl.rejectUnauthorized=true).');
  return patched;
}

// ---------------------------------------------------------------------------
// Pool error handler attachment
// ---------------------------------------------------------------------------

/**
 * Attach pool-level error and connection-acquisition logging to a Knex
 * instance. Errors are caught here so unhandled promise rejections do not
 * propagate out of the pool layer.
 *
 * @param {import('knex').Knex} instance - The initialised Knex instance.
 * @returns {void}
 */
function attachPoolErrorHandlers(instance) {
  // `instance.client.pool` is exposed by tarn (the pool library knex uses).
  const pool = instance.client && instance.client.pool;
  if (!pool) { return; }

  pool.on('createFail', (eventId, err) => {
    logger.error({ err, eventId }, '[db] Pool: failed to create connection');
  });

  pool.on('acquireFail', (eventId, err) => {
    logger.error({ err, eventId }, '[db] Pool: failed to acquire connection');
  });

  pool.on('destroyFail', (eventId, err) => {
    logger.warn({ err, eventId }, '[db] Pool: failed to destroy connection');
  });
}

// ---------------------------------------------------------------------------
// Lifecycle proxy
// ---------------------------------------------------------------------------

/**
 * Guard that throws a DatabaseLifecycleError when the DB is not READY.
 * Called before any query is dispatched.
 *
 * @param {string} operation - A label for the operation being attempted (for error messages).
 * @throws {DatabaseLifecycleError} When state is DESTROYING or DESTROYED.
 */
function assertReady(operation) {
  if (_dbState !== DB_STATE.READY) {
    throw new DatabaseLifecycleError(
      `[db] Cannot execute "${operation}": database connection pool is ` +
      (_dbState === DB_STATE.DESTROYING
        ? 'being shut down (state: DESTROYING).'
        : 'already destroyed (state: DESTROYED).'),
      _dbState
    );
  }
}

/**
 * Wrap the Knex instance so every query-entry-point guards the lifecycle
 * state.  The original `db.destroy()` is replaced with one that transitions
 * the state atomically and cleans up.
 *
 * Wrapped entry points:
 *   - db(tableName)         – query builder constructor
 *   - db.raw(sql, bindings) – raw SQL execution
 *   - db.transaction(cb)    – transaction wrapper
 *   - db.destroy()          – pool teardown (transitions state, idempotent)
 *
 * @param {import('knex').Knex} instance - The initialised Knex instance.
 * @returns {import('knex').Knex} The same instance, mutated in place.
 */
function patchForLifecycle(instance) {
  // --- db(tableName) query builder ---
  //
  // A Knex instance is a callable object (class instance with __call__ semantics
  // via the underlying QueryInterface constructor), not a plain function.  We
  // cannot use Function.prototype.bind on it.  Instead we create a plain wrapper
  // function that delegates to `instance` via the call operator, and then copy
  // all enumerable own properties from `instance` onto the wrapper so callers
  // who access db.client, db.schema, db.migrate, etc. still work.
  const _patchedCallable = function dbProxy(tableName) {
    assertReady(`db("${tableName}")`);
    return instance(tableName);
  };

  // Copy all own properties from the original instance onto the patched callable
  // so callers using db.raw, db.transaction, db.client, etc. still work.
  Object.setPrototypeOf(_patchedCallable, Object.getPrototypeOf(instance));
  Object.assign(_patchedCallable, instance);

  // --- db.raw ---
  _patchedCallable.raw = function rawProxy(sql, ...bindings) {
    assertReady('db.raw');
    return instance.raw(sql, ...bindings);
  };

  // --- db.transaction ---
  _patchedCallable.transaction = function transactionProxy(callback, config) {
    assertReady('db.transaction');
    return instance.transaction(callback, config);
  };

  // --- db.destroy (lifecycle-aware, idempotent) ---
  _patchedCallable.destroy = async function destroyProxy() {
    // Idempotent: if already destroyed or being destroyed, resolve immediately.
    if (_dbState === DB_STATE.DESTROYED) {
      logger.info('[db] db.destroy() called on an already-destroyed pool; no-op.');
      return;
    }
    if (_dbState === DB_STATE.DESTROYING) {
      logger.info('[db] db.destroy() called while shutdown already in progress; no-op.');
      return;
    }

    _dbState = DB_STATE.DESTROYING;
    logger.info('[db] Pool teardown initiated (state → DESTROYING).');

    try {
      await instance.destroy();
      _dbState = DB_STATE.DESTROYED;
      logger.info('[db] Pool teardown complete (state → DESTROYED).');
    } catch (err) {
      // Even if destroy throws we mark as DESTROYED to prevent further queries
      // from hanging against a half-torn-down pool.
      _dbState = DB_STATE.DESTROYED;
      logger.error({ err }, '[db] Pool teardown error; forcing state → DESTROYED.');
      throw err;
    }
  };

  // Expose the state accessors for observability and testing.
  _patchedCallable._getState = () => _dbState;
  _patchedCallable._DB_STATE = DB_STATE;

  return _patchedCallable;
}

// ---------------------------------------------------------------------------
// Module initialisation
// ---------------------------------------------------------------------------

/** @type {string} */
const env = process.env.NODE_ENV || 'development';

const rawConfig = resolveConfig(env);

// Apply production TLS before merging in pool defaults.
const tlsConfig = applyProductionTls(env, rawConfig);

const mergedPool = validateAndClampPool({
  ...DEFAULT_POOL,
  ...(tlsConfig.pool || {}),
});

const mergedConfig = {
  ...tlsConfig,
  pool: mergedPool,
};

/**
 * Singleton Knex database instance for the current environment.
 * Wrapped with lifecycle guards so query-after-destroy is immediately
 * detectable rather than silently hanging or producing cryptic errors.
 *
 * Subsequent `require` calls return the cached export (Node module cache).
 *
 * @type {import('knex').Knex}
 */
const _rawDb = knex(mergedConfig);

attachPoolErrorHandlers(_rawDb);

const db = patchForLifecycle(_rawDb);

module.exports = db;
module.exports.DatabaseLifecycleError = DatabaseLifecycleError;
module.exports.DB_STATE = DB_STATE;
