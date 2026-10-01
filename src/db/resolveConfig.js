'use strict';

/**
 * @file src/db/resolveConfig.js
 * @description Select the Knex config block that corresponds to NODE_ENV.
 *              Extracted into a separate module to enable isolated unit testing.
 *
 *              This module is deterministic and side-effect free with respect to
 *              the process environment: the knexfile is loaded exactly once and
 *              cached, so repeated calls return the same config object and
 *              failures are reproducible and observable.
 * @module src/db/resolveConfig
 */

/**
 * Error codes emitted by this module. These are stable contracts that
 * callers (operational tooling, migration scripts, tests) may rely on.
 * @enum {string}
 */
const ERROR_CODES = Object.freeze({
  MISSING_TEST_CONFIG: 'DB_MISSING_TEST_CONFIG',
  MISSING_PRODUCTION_CONFIG: 'DB_MISSING_PRODUCTION_CONFIG',
  MISSING_DATABASE_URL: 'DB_MISSING_DATABASE_URL',
  MISSING_CONFIG: 'DB_MISSING_CONFIG',
  INVALID_ENVIRONMENT: 'DB_INVALID_ENVIRONMENT',
});

/**
 * The canonical environment names that this module recognises. Any other
 * non-empty string is treated as a development-like environment and falls
 * back to the development config block.
 * @type {ReadonlyArray<string>}
 */
const KNOWN_ENVIRONMENTS = Object.freeze(['development', 'test', 'production']);

/**
 * Cached knexfile module. Loading is lazy and memoised so that:
 *   1. Requiring this module never touches the filesystem until needed.
 *   2. Repeated calls are deterministic (same object reference).
 *   3. A failure to load the knexfile is not silently retried with different
 *      results.
 * @type {Object|null}
 */
let cachedAllConfigs = null;

/**
 * Reset the internal knexfile cache. Exposed only for tests that need to
 * simulate a cold start or a changed knexfile. Production code should not
 * call this.
 *
 * @returns {void}
 */
function __resetCacheForTests() {
  cachedAllConfigs = null;
}

/**
 * Load and cache the knexfile config blocks.
 *
 * The knexfile is required lazily and cached on first use. If the require
 * throws (e.g. a syntax error or a missing module), the failure is not
 * cached: the next call retries the load. This keeps transient dependency
 * failures recoverable while keeping successful loads deterministic.
 *
 * @returns {Object} The knexfile config blocks.
 * @throws {Error} When the knexfile cannot be loaded or does not export
 *   an object.
 */
function loadAllConfigs() {
  if (cachedAllConfigs !== null) {
    return cachedAllConfigs;
  }

  let loaded;
  try {
    loaded = require('../../knexfile');
  } catch (cause) {
    const err = new Error(
      '[db] Failed to load knexfile.js. Ensure the file exists and is valid JavaScript.'
    );
    err.code = ERROR_CODES.MISSING_CONFIG;
    err.cause = cause;
    throw err;
  }

  if (!loaded || typeof loaded !== 'object') {
    const err = new Error(
      '[db] knexfile.js must export a config object.'
    );
    err.code = ERROR_CODES.MISSING_CONFIG;
    throw err;
  }

  cachedAllConfigs = loaded;
  return cachedAllConfigs;
}

/**
 * Build a consistent, observable error for a missing or invalid config.
 *
 * Every error carries a stable `code` and a `context` object with non-secret
 * details so failures can be diagnosed without leaking credentials.
 *
 * @param {string} code - Stable error code.
 * @param {string} message - Human-readable message.
 * @param {Object} [context] - Non-secret diagnostic context.
 * @returns {Error}
 */
function configError(code, message, context) {
  const err = new Error(message);
  err.code = code;
  if (context && typeof context === 'object') {
    err.context = context;
  }
  return err;
}

/**
 * Log a redacted diagnostic line for a config resolution failure.
 *
 * Only non-secret metadata is emitted: the error code, the requested
 * environment, and whether the expected config block was present. Values
 * such as `DATABASE_URL` are never included.
 *
 * @param {Error} err - The error being reported.
 * @param {string} environment - The requested environment.
 * @returns {void}
 */
function logFailure(err, environment) {
  const payload = {
    code: err && err.code ? err.code : 'DB_UNKNOWN_ERROR',
    environment,
  };
  if (err && err.context) {
    Object.assign(payload, err.context);
  }
  // eslint-disable-next-line no-console
  console.error('[db] resolveConfig failure', payload);
}

/**
 * Load the knexfile config block that corresponds to `environment`.
 *
 * This function is deterministic and idempotent:
 *   - Valid inputs always resolve to the same config block for a given
 *     knexfile and process environment.
 *   - Invalid inputs always throw the same error code and message.
 *   - No module-level mutable state is changed except the lazy knexfile
 *     cache, which is write-once and then read-only.
 *
 * Throws an explicit error when NODE_ENV=test but the `test` block is missing,
 * or when NODE_ENV=production and DATABASE_URL is not set.
 *
 * @param {string} environment - The resolved NODE_ENV value.
 * @returns {import('knex').Knex.Config} Knex configuration object.
 * @throws {Error} When the environment is invalid or the required config
 *   block is missing.
 */
function resolveConfig(environment) {
  if (typeof environment !== 'string' || environment.trim() === '') {
    const err = configError(
      ERROR_CODES.INVALID_ENVIRONMENT,
      '[db] NODE_ENV must be a non-empty string.',
      { environment: String(environment) }
    );
    logFailure(err, environment);
    throw err;
  }

  const normalized = environment.trim().toLowerCase();
  const allConfigs = loadAllConfigs();

  if (normalized === 'test') {
    const testConfig = allConfigs.test;
    if (!testConfig) {
      const err = configError(
        ERROR_CODES.MISSING_TEST_CONFIG,
        '[db] No "test" config block found in knexfile.js. ' +
          'The test environment must use an isolated database configuration.',
        { environment: normalized, hasTestBlock: false }
      );
      logFailure(err, normalized);
      throw err;
    }
    validateConfigStructure(testConfig, environment);
    return testConfig;
  }

  if (normalized === 'production') {
    if (!process.env.DATABASE_URL) {
      const err = configError(
        ERROR_CODES.MISSING_DATABASE_URL,
        '[db] DATABASE_URL must be set when NODE_ENV=production.',
        { environment: normalized, hasDatabaseUrl: false }
      );
      logFailure(err, normalized);
      throw err;
    }
    const prodConfig = allConfigs.production;
    if (!prodConfig) {
      const err = configError(
        ERROR_CODES.MISSING_PRODUCTION_CONFIG,
        '[db] No "production" config block found in knexfile.js.',
        { environment: normalized, hasProductionBlock: false }
      );
      logFailure(err, normalized);
      throw err;
    }
    validateConfigStructure(prodConfig, environment);
    return prodConfig;
  }

  // Development-like environments: prefer an exact block match, then fall
  // back to the development block. This is the documented behaviour for
  // any non-test, non-production NODE_ENV value.
  const devConfig = allConfigs.development;
  const exactConfig = allConfigs[normalized];
  const resolved = exactConfig || devConfig;
  if (!resolved) {
    const err = configError(
      ERROR_CODES.MISSING_CONFIG,
      `+db] No config block found for NODE_ENV="${normalized}" in knexfile.js.`,
      {
        environment: normalized,
        knownEnvironments: KNOWN_ENVIRONMENTS.slice(),
        hasDevelopmentBlock: Boolean(devConfig),
      }
    );
    logFailure(err, normalized);
    throw err;
  }
  return resolved;
}

resolveConfig.ERROR_CODES = ERROR_CODES;
resolveConfig.KNOWN_ENVIRONMENTS = KNOWN_ENVIRONMENTS;
resolveConfig.__resetCacheForTests = __resetCacheForTests;

module.exports = resolveConfig;
