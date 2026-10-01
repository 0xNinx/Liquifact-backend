'use strict';

/**
 * @fileoverview Process entry point for the LiquiFact API.
 *
 * This module re-exports the Express app built by ./app and owns process
 * lifecycle: boot configuration validation, the HTTP listen boundary,
 * background workers, and graceful-shutdown registration.
 *
 * ## The listen boundary
 * The port is the only operator-controlled value that reaches this file, and it
 * is the one that must never be passed to `app.listen()` unchecked: `net`
 * treats an unparsable string as a Unix socket path, so a typo would bind the
 * wrong kind of socket with no error at all. ./config/listenPort.js defines the
 * accepted ranges and this module enforces them, fail-closed, before any side
 * effect. See docs/entrypoint-validation-boundaries.md for the full invariant
 * list and the operational failure modes.
 *
 * @module index
 */

require('dotenv').config();

const crypto = require('crypto');
const app = require('./app');
const { validate, logRedactedSummary } = require('./config');
const {
  PortValidationError,
  resolvePortFromEnv,
  validatePortArgument,
} = require('./config/listenPort');
const logger = require('./logger');
const shutdownCoordinator = require('./utils/shutdownCoordinator');

/**
 * The single HTTP listener owned by this process, or `null` when nothing is
 * bound.
 *
 * Invariant: at most one live listener per process. The slot is claimed
 * synchronously before `app.listen` is awaited anywhere and is released when
 * the server closes, so a repeated or concurrent {@link startServer} call can
 * never produce two listeners (the second bind would fail asynchronously with
 * EADDRINUSE) and can never orphan a listener (which would leak the socket
 * past graceful shutdown, because the coordinator tracks a single server).
 *
 * @type {import('http').Server|null}
 */
let httpServer = null;

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
  } catch (_err) {
    // Best-effort: a probe failure must not abort startup.
  }
}

/**
 * Validates the application configuration at startup before the server starts listening.
 * In test environment, the validation is skipped to preserve lazy loading behavior.
 * Fails fast by logging a redacted summary of errors and exiting with a non-zero code.
 *
 * The return value is the fail-closed signal for the caller: `process.exit()`
 * is documented to never return, but it *is* replaced by a no-op in tests and
 * by some APM/hook wrappers. Returning `false` guarantees a rejected
 * configuration cannot reach `app.listen()` on those code paths either.
 *
 * @returns {boolean} True when the process may continue booting.
 */
function runBootConfigValidation() {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  try {
    validate();

    // Boot-time dependency validation phase
    const { validateDependencies } = require('./config/dependencyValidator');
    validateDependencies();
    return true;
  } catch (error) {
    logRedactedSummary(error);
    process.exit(1);
    return false;
  }
}

/**
 * Resolves which port the process should bind.
 *
 * An explicit argument is authoritative and short-circuits the environment, so
 * an in-process caller (tests, an embedding harness) is never blocked by a
 * `PORT` value meant for a different deployment. With no argument the
 * environment is validated at the moment of binding rather than read from the
 * cached config object, so the value that is bound is the value that was
 * checked even when boot validation was skipped.
 *
 * @param {unknown} [portOverride] - Explicit port from the caller.
 * @returns {{ port: number, source: string }} The port and where it came from.
 * @throws {PortValidationError} If the port is present but not usable.
 */
function resolveListenPort(portOverride) {
  const override = validatePortArgument(portOverride);

  if (override !== null) {
    return { port: override, source: 'argument' };
  }

  return { port: resolvePortFromEnv(process.env.PORT), source: 'env' };
}

/**
 * Wires the observability and cleanup hooks of a bound server.
 *
 * Every call is feature-detected because tests substitute duck-typed stand-ins
 * for the HTTP server; a plain object has no event API and must not make
 * startup fail.
 *
 * @param {import('http').Server} server - The server returned by `app.listen`.
 * @param {number} port - The port it was bound to, for log correlation.
 * @returns {void}
 */
function attachServerLifecycleHandlers(server, port) {
  if (!server || typeof server.once !== 'function') {
    return;
  }

  server.once('error', (err) => {
    // A listener that emitted an error never reached (or has left) the serving
    // state. Releasing the slot keeps the singleton honest even when the exit
    // below is stubbed out.
    if (httpServer === server) {
      httpServer = null;
    }
    logger.error(
      {
        component: 'entrypoint',
        event: 'http_server_error',
        port,
        errorCode: err && err.code,
        errorName: err && err.name,
      },
      'HTTP server reported an unrecoverable error; exiting so the orchestrator can restart the process.'
    );
    process.exit(1);
  });

  server.once('close', () => {
    if (httpServer === server) {
      httpServer = null;
    }
    logger.info(
      { component: 'entrypoint', event: 'http_server_closed', port },
      'HTTP server closed; the listen slot is free for a new listener.'
    );
  });
}

/**
 * Starts the HTTP server on the configured port.
 *
 * Validation boundaries enforced here, in order, before any side effect:
 * 1. Boot configuration - a rejected configuration stops the boot (fail-closed).
 * 2. Listen port - rejected before the storage probe, the socket, or any log
 *    line that could be mistaken for a successful start.
 * 3. Duplicate start - a second call returns the running server instead of
 *    binding a second listener and orphaning the first.
 *
 * @param {number} [portOverride] - Port to bind. `0` requests an ephemeral port.
 *   Omit to use the validated `PORT` environment variable, defaulting to 3001.
 * @returns {import('http').Server|undefined} The HTTP server instance, or
 *   `undefined` when boot validation rejected the configuration.
 * @throws {PortValidationError} If the resolved port is not a usable port.
 */
function startServer(portOverride) {
  if (!runBootConfigValidation()) {
    return undefined;
  }

  const { port, source } = resolveListenPort(portOverride);

  if (httpServer) {
    logger.warn(
      { component: 'entrypoint', event: 'http_server_start_ignored', port, source },
      'startServer() called while a listener is already running; returning the running server.'
    );
    return httpServer;
  }

  logger.info(
    { component: 'entrypoint', event: 'http_server_starting', port, source },
    'Starting HTTP server.'
  );

  let server;
  try {
    server = app.listen(port);
  } catch (err) {
    // The slot is only claimed after a successful bind, so a synchronous
    // failure leaves the process able to retry rather than wedged on a server
    // that was never created.
    logger.error(
      {
        component: 'entrypoint',
        event: 'http_server_bind_failed',
        port,
        source,
        errorCode: err && err.code,
        errorName: err && err.name,
      },
      'app.listen() threw while binding the HTTP server.'
    );
    throw err;
  }

  httpServer = server;
  attachServerLifecycleHandlers(server, port);
  shutdownCoordinator.register({ server });
  shutdownCoordinator.setupSignalListeners();

  // Only after the socket exists: a rejected port must leave no background
  // work behind, and storage misconfiguration belongs in the readiness probe
  // rather than in a half-started process.
  scheduleStartupStorageProbe();

  return server;
}

/**
 * Reports the server this process is currently listening with, if any.
 *
 * @returns {import('http').Server|null} The live server, or `null`.
 */
function getHttpServer() {
  return httpServer;
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
  // Start the idempotency purge worker. A unique fencing token is generated
  // per process at boot time and validated by startPurgeWorker — a missing or
  // malformed token fails loudly rather than silently in non-test environments.
  // Each job module owns its own start/stop guard, so this call is idempotent.
  const { startPurgeWorker } = require('./jobs/idempotencyPurge');
  startPurgeWorker({ fencingToken: crypto.randomUUID() });

  // Start the invoice-state retention purge worker (issue #866). It keeps its
  // own lifecycle state, independent of the idempotency worker. The same
  // fencing-token invariant applies.
  const { startPurgeWorker: startInvoiceStatePurgeWorker } = require('./jobs/invoiceStatePurge');
  startInvoiceStatePurgeWorker({ fencingToken: crypto.randomUUID() });

  startServer();
}

module.exports = app;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
module.exports.resetStore = resetStore;
module.exports.getHttpServer = getHttpServer;
module.exports.PortValidationError = PortValidationError;
