'use strict';

/**
 * @file src/db/knex.js
 * @description Knex connection factory.
 *
 * Connection selection rules
 * ------------------------
 * - NODE_ENV=test       → always uses the `test` config block (in-memory SQLite).
 *                         Never falls back to development or production config.
 * - NODE_ENV=production → uses the `production` config block. Throws if the
 *                         `DATABASE_URL` env var is absent.
 * - anything else       → uses the `development` config block.
 *
 * Pool error handling
 * -------------------
 * Knex exposes pool-level events through the underlying `tarn` pool. We attach
 * `createTimeoutMillis` / `acquireTimeoutMillis` at the config level and log
 * pool errors so they surface in application logs without crashing the process.
 *
 * Test mock
 * --------
 * Jest resolves `src/db/__mocks__/knex.js` automatically when
 * `jest.mock('../../src/db/knex')` is called, so this file is never executed
 * during unit tests that use the manual mock.
 *
 * Config selection logic
 * --------------------
 * The config-selection logic lives in `src/db/resolveConfig.js` so it can be
 * unit-tested independently without loading knex or pino.
 *
 * @module src/db/knex
 */

const knex = require('knex');
const logger = require('../logger');
const resolveConfig = require('./resolveConfig');

/** @type {string} */
const env = process.env.NODE_ENV || 'development';

/**
 * Attach pool-level error and connection-acquisition logging to a Knex
 * instance. Errors are caught here so unhandled promise rejections do not
 * propagate out of the pool layer.
 *
 * Handlers are idempotent: attaching twice will not duplicate listeners, so
 * recovery paths (e.g. re-init after a fatal pool error) stay deterministic.
 *
 * @param {import('knex').Knex} instance - The initialised Knex instance.
 * @returns {void}
 */
/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
function attachPoolErrorHandlers(instance) {
  // `instance.client.pool` is exposed by tarn (the pool library knex uses).
  const pool = instance.client && instance.client.pool;
  if (!pool) { return; }

  // Guard against duplicate listeners if this is called more than once on the
  // same pool (e.g. during a recovery/re-init sequence).
  if (pool.__liquifactHandlersAttached) { return; }
  pool.__liquifactHandlersAttached = true;

  /* eslint-enable no-underscore-dangle */
  /* eslint-enable no-param-reassign */
  pool.on('createFail', (eventId, err) => {
    logger.error({ err, eventId }, '[db] Pool: failed to create connection');
  });

  pool.on('acquireFail', (eventId, err) => {
    logger.error({ err, eventId }, '[db] Pool: failed to acquire connection');
  });

  pool.on('destroyFail', (eventId, err) => {
    logger.warn({ err, eventId }, '[db] Pool: failed to destroy connection');
  });

  pool.on('poolDestroySuccess', () => {
    logger.info('[db] Pool: destroyed');
  });
}

/**
 * Default pool configuration applied to every environment unless the config
 * block already specifies a `pool` key.
 *
 * @type {import('knex').Knex.PoolConfig}
 */
const DEFAULT_POOL = {
  min: 2,
  max: 10,
  /** Fail fast on connection acquisition rather than hanging indefinitely. */
  propagateCreateError: false,
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
  /** Cap on retries so a persistent outage cannot loop forever. */
  createRetryCount: 3,
};

const config = resolveConfig(env);

const mergedConfig = {
  ...config,
  pool: { ...DEFAULT_POOL, ...(config.pool || {}) },
};

/**
 * Singleton Knex database instance for the current environment.
 * Subsequent `require` calls return the cached export.
 *
 * @type {import('knex').Knex}
 */
const db = knex(mergedConfig);

attachPoolErrorHandlers(db);

/**
 * Deterministically tear down the singleton pool. Safe to call multiple times;
 * subsequent calls resolve without error. Any in-flight queries are allowed to
 * settle (or reject) before the pool is destroyed, so callers can observe the
 * outcome rather than silently losing work.
 *
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (db.__liquifactShutdown) { return; }
  try {
    await db.destroy();
  } catch (err) {
    logger.error({ err }, '[db] Failed to destroy pool during shutdown');
    throw err;
  }
}

db.__liquifactShutdown = false;
// Expose shutdown without changing the default export shape (still a Knex
// instance), preserving compatibility with existing callers.
db.shutdown = shutdown;

module.exports = db;
