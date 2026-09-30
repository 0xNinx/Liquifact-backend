'use strict';

/**
 * Minimal entry-point shim.
 *
 * The original src/index.js was structurally invalid (duplicated bodies and
 * unbalanced braces) and broke both `node --check` and Jest parsing. To unblock
 * the CI pipeline this file now simply re-exports the working Express app
 * factory from ./app and provides a no-op startServer helper for the legacy
 * tests that reference it.
 */

require('dotenv').config();

const app = require('./app');
const { validate, logRedactedSummary } = require('./config');
const shutdownCoordinator = require('./utils/shutdownCoordinator');
const logger = require('./logger');

/**
 * Runs the S3 connectivity probe at startup. Failures are logged but never
 * block process start - the readiness probe (`/readyz`) surfaces storage
 * misconfiguration to orchestrators once the HTTP server is listening.
 *
 * @returns { Promise<void> }
 */
async function scheduleStartupStorageProbe() {
  try {
    const storage = require('./services/storage');
    await storage.runStartupStorageProbe();
  } catch (error) {
    logger.warn(
      { component: 's3-healthcheck', event: 'startup_probe', errorName: error && error.name },
      'S3 startup probe could not complete; readiness checks will report storage status'
    );
  }
}

/**
 * Validates the application configuration at startup before the server starts listening.
 * In test environment, the validation is skipped to preserve lazy loading behavior.
 * Fails fast by logging a redacted summary of errors and exiting with a non-zero code.
 * @returns { void }
 */
function runBootConfigValidation() {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  try {
    validate();
    
    // Boot-time dependency validation phase
    const { validateDependencies } = require('./config/dependencyValidator');
    validateDependencies();
  } catch (error) {
    logRedactedSummary(error);
    process.exit(1);
  }
}

/**
 * Starts the HTTP server on the configured port.
 *
 * @returns {$import('http').Server} The HTTP server instance.
 */
function listenServer() {
  const port = process.env.PORT || 3001;
  // Fire-and-forget probe -- do not await, so startup is not blocked.
  scheduleStartupStorageProbe();
  const server = app.listen(port);
  shutdownCoordinator.register({ server });
  shutdownCoordinator.setupSignalListeners();
  return server;
}

function startServer() {
  runBootConfigValidation();
  return listenServer();
}

let backgroundWorkersStartPromise = null;

/**
 * Starts all process-owned workers as one startup operation.
 * Successful starts are rolled back in reverse order if a later worker fails.
 *
 * @returns {Promise<void>}
 */
function startBackgroundWorkers() {
  if (!backgroundWorkersStartPromise) {
    backgroundWorkersStartPromise = startBackgroundWorkersOnce().catch((error) => {
      backgroundWorkersStartPromise = null;
      throw error;
    });
  }
  return backgroundWorkersStartPromise;
}

async function startBackgroundWorkersOnce() {
  const startedWorkers = [];
  try {
    const idempotencyPurge = require('./jobs/idempotencyPurge');
    await idempotencyPurge.startPurgeWorker();
    startedWorkers.push(idempotencyPurge);

    const invoiceStatePurge = require('./jobs/invoiceStatePurge');
    await invoiceStatePurge.startPurgeWorker();
    startedWorkers.push(invoiceStatePurge);

    for (const job of startedWorkers) {
      shutdownCoordinator.register({ worker: job.purgeWorker });
    }
  } catch (error) {
    for (const job of startedWorkers.reverse()) {
      try {
        await job.stopPurgeWorker();
      } catch (stopError) {
        logger.error(
          { component: job.JOB_TYPE || 'idempotency_purge', errorName: stopError && stopError.name },
          'Background worker rollback failed'
        );
      }
    }
    throw error;
  }
}

async function stopBackgroundWorkers() {
  const jobs = [
    require('./jobs/invoiceStatePurge'),
    require('./jobs/idempotencyPurge'),
  ];
  for (const job of jobs) {
    try {
      await job.stopPurgeWorker();
    } catch (error) {
      logger.error(
        { component: job.JOB_TYPE || 'idempotency_purge', errorName: error && error.name },
        'Background worker shutdown failed during startup recovery'
      );
    }
  }
}

async function startApplication() {
  runBootConfigValidation();
  let workersStarted = false;
  try {
    await startBackgroundWorkers();
    workersStarted = true;
    listenServer();
  } catch (error) {
    if (workersStarted) {
      await stopBackgroundWorkers();
    }
    logger.error(
      { component: 'startup', errorName: error && error.name, errorCode: error && error.code },
      'Application startup failed'
    );
    process.exitCode = 1;
  }
}

/**
 * Resets in-memory state (clears shared cache stores for test isolation).
 *
 * @returns { void }
 */
function resetStore() {
  try {
    const { getSharedStore } = require('./services/cacheStore');
    getSharedStore().clear();
  } catch (_) {
    // intentional no-op in environments where cacheStore is unavailable
  }

  try {
    const { getMetricsCacheStore } = require('./services/metricsCacheStore');
    getMetricsCacheStore().clear();
  } catch (_) {
    // intentional no-op in environments where metricsCacheStore is unavailable
  }
}

const originalCreateApp = app.createApp;

/**
 * Returns the underlying Express app factory.
 *
 * @returns { import('express').Express} Configured Express app.
 */
function createApp() {
  return typeof originalCreateApp === 'function' ? originalCreateApp() : app;
}

// Start background workers when running as main module (not in tests)
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  startApplication();
}

module.exports = app;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
module.exports.startBackgroundWorkers = startBackgroundWorkers;
module.exports.resetStore = resetStore;
