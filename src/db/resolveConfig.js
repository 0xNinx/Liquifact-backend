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
 * Normalise an environment name into a stable lookup key.
 *
 * The key is trimmed and lowercased so that callers passing
 * `"production "`, `"PRODUCTION"`, or `undefined` get deterministic
 * behaviour. Non-string inputs are treated as an empty string so the
 * default development block is selected instead of throwing a TypeError.
 *
 * @param {*} environment - Raw NODE_ENV value.
 * @returns {string} Normalised lookup key.
 */
function normaliseEnvironment(environment) {
  if (typeof environment !== 'string') {
    return '';
  }
  return environment.trim().toLowerCase();
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
  const allConfigs = require('../../knexfile');
  const key = normaliseEnvironment(environment);

  if (key === 'test') {
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

  if (key === 'production') {
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

  // Preserve the historical contract: any non-test, non-production
  // environment falls back to the development block when no exact match
  // exists. This keeps `development`, `staging`, `ci`, and any future
  // custom NODE_ENV values working without a key change.
  const devConfig = allConfigs[key] || allConfigs.development;
  if (!devConfig) {
    throw new Error(
      `[db] No config block found for NODE_ENV="${key}" in knexfile.js.`
    );
    logFailure(err, normalized);
    throw err;
  }
  return resolved;
}

resolveConfig.normaliseEnvironment = normaliseEnvironment;

module.exports = resolveConfig;
