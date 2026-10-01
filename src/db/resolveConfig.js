'use strict';

/**
 * @file src/db/resolveConfig.js
 * @description Select the Knex config block that corresponds to NODE_ENV.
 *              Extracted into a separate module to enable isolated unit testing.
 * @module src/db/resolveConfig
 */

/**
 * Validate the environment parameter.
 *
 * @param {unknown} environment - The environment value to validate.
 * @throws {Error} If environment is invalid.
 */
function validateEnvironment(environment) {
  if (typeof environment !== 'string') {
    throw new Error(
      '[db] NODE_ENV must be a string. Received: ' + typeof environment
    );
  }

  if (environment.trim() === '') {
    throw new Error('[db] NODE_ENV cannot be empty or whitespace-only.');
  }

  if (environment.length > 100) {
    throw new Error(
      '[db] NODE_ENV exceeds maximum length of 100 characters.'
    );
  }

  // Allow only alphanumeric, underscore, and hyphen to prevent injection or parsing issues
  if (!/^[a-zA-Z0-9_-]+$/.test(environment)) {
    throw new Error(
      '[db] NODE_ENV contains invalid characters. Only alphanumeric, underscore, and hyphen are allowed.'
    );
  }
}

/**
 * Validate the returned config structure.
 *
 * @param {unknown} config - The config object to validate.
 * @param {string} environment - The environment name for error messages.
 * @throws {Error} If config structure is invalid.
 */
function validateConfigStructure(config, environment) {
  if (!config || typeof config !== 'object') {
    throw new Error(
      `[db] Config for NODE_ENV="${environment}" is not a valid object.`
    );
  }

  if (!config.client) {
    throw new Error(
      `[db] Config for NODE_ENV="${environment}" is missing required "client" field.`
    );
  }

  if (!config.connection) {
    throw new Error(
      `[db] Config for NODE_ENV="${environment}" is missing required "connection" field.`
    );
  }
}

/**
 * Load the knexfile config block that corresponds to `environment`.
 *
 * Throws an explicit error when NODE_ENV=test but the `test` block is missing,
 * or when NODE_ENV=production and DATABASE_URL is not set.
 *
 * @param {string} environment - The resolved NODE_ENV value.
 * @returns {import('knex').Knex.Config} Knex configuration object.
 */
function resolveConfig(environment) {
  validateEnvironment(environment);

  const allConfigs = require('../../knexfile');

  if (environment === 'test') {
    const testConfig = allConfigs.test;
    if (!testConfig) {
      throw new Error(
        '[db] No "test" config block found in knexfile.js. ' +
          'The test environment must use an isolated database configuration.'
      );
    }
    validateConfigStructure(testConfig, environment);
    return testConfig;
  }

  if (environment === 'production') {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        '[db] DATABASE_URL must be set when NODE_ENV=production.'
      );
    }
    const prodConfig = allConfigs.production;
    if (!prodConfig) {
      throw new Error('[db] No "production" config block found in knexfile.js.');
    }
    validateConfigStructure(prodConfig, environment);
    return prodConfig;
  }

  const devConfig = allConfigs[environment] || allConfigs.development;
  if (!devConfig) {
    throw new Error(
      `[db] No config block found for NODE_ENV="${environment}" in knexfile.js.`
    );
  }
  validateConfigStructure(devConfig, environment);
  return devConfig;
}

module.exports = resolveConfig;
