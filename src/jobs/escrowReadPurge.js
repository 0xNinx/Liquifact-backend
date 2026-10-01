'use strict';

/**
 * @fileoverview Maintenance task that hard-deletes escrow-read records whose
 * soft-delete retention window has elapsed (issue #31).
 *
 * Soft-deleting a record (see {@link module:services/escrowReadSoftDelete}) leaves a tombstoned `escrow_event_projection` row behind. Without a purge,
 * tombstones accumulate forever — the exact unbounded-growth problem the
 * idempotency purge job solves for `idempotency_keys`.
 *
 * This job runs the purge on a schedule through the shared job queue/worker
 * infrastructure, emits Prometheus counters, and exposes a manual trigger for
 * the admin API.
 *
 * ## Configuration
 * - `ESCROW_READ_SOFT_DELETE_RETENTION_DAYS` — restore/retention window (default 30).
 * - `ESCROW_READ_PURGE_BATCH_SIZE` — rows deleted per batch (default 500).
 * - `ESCROW_READ_PURGE_MAX_BATCHES` — batch cap per run (default 100).
 * - `ESCROW_READ_PURGE_INTERVAL_NS` — cadence between runs (default 6 h, min 1 min).
 *
 * ## Failure recovery invariants
 * The purge is designed to be deterministic and recoverable:
 * 1. Every run is idempotent — deleting the same expired tombstones twice
 *    produces the same final state (rows are already gone); a retry after a
 *    partial failure never deletes non-expired rows.
 * 2. A partial failure is observable — the counters and logs record how
 *    many rows were already deleted before the failure, so operators can
 *    confirm progress and resume safely.
 * 3. Retries are bounded and backoff-aware to avoid hot-looping on a
 *    persistent dependency failure.
 * 4. Concurrent execution is serialised by the worker (`maxConcurrency: 1`)
 *    and guarded by an in-process mutex so a manual trigger cannot overlap a
 *    scheduled run.
 *
 * @module jobs/escrowReadPurge
 */

const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter } = require('prom-client');
const { getRegistry } = require('../metrics');
const {
  purgeExpiredSoftDeletes,
  getRetentionDays,
  getPurgeBatchSize,
  getPurgeMaxBatches,
} = require('../services/escrowReadSoftDelete');

/** @constant {string} */
const JOB_TYPE = 'escrow_read_purge';
/** @constant {number} */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** @constant {number} */
const MIN_INTERVAL_MS = 60_000; // 1 minute
/** @constant {number} */
const DEFAULT_MAX_RETRIES = 3;
/** @constant {number} */
const BASE_RETRY_DELAY_MS = 250;
/** @constant {number} */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Registers a counter idempotently. Jest resets the module registry between
 * suites while `prom-client 's registry is process-global, so a bare
 * `new Counter(...)` would throw "already registered" on the second load.
 *
 * @param {object} config - `prom-client` counter configuration.
 * @returns {import('prom-client').Counter} New or previously registered counter.
 */
function _counter(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Counter({ ...config, registers: [registry] });
}

const escrowReadPurgeRowsDeletedTotal = _counter({
  name: 'liquifact_escrow_read_purge_rows_deleted_total',
  help: 'Total escrow-read tombstones hard-deleted after their retention window',
});

const escrowReadPurgeRunsTotal = _counter({
  name: 'liquifact_escrow_read_purge_runs_total',
  help: 'Total escrow-read purge job runs by outcome',
  labelNames: ['status'],
});

const escrowReadPurgeRetriesTotal = _counter({
  name: 'liquifact_escrow_read_purge_retries_total',
  help: 'Total escrow-read purge retry attempts',
});

const escrowReadPurgeRowsDeletedOnRetryTotal = _counter({
  name: 'liquifact_escrow_read_purge_rows_deleted_on_retry_total',
  help: 'Total escrow-read tombstones deleted by retried runs',
});

/**
 * Reads the purge cadence.
 *
 * @returns {number} Interval in ms (minimum 60000; default 6 h).
 */
function getIntervalMs() {
  const parsed = parseInt(process.env.ESCROW_READ_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Reads the maximum number of retries for a failed purge run.
 *
 * @param {object} [options={}]
 * @param {number} [options.maxRetries] - Override for tests/callers.
 * @returns {number} Non-negative integer.
 */
function getMaxRetries(options = {}) {
  if (Number.isInteger(options.maxRetries) && options.maxRetries >= 0) {
    return options.maxRetries;
  }
  const parsed = parseInt(process.env.ESCROW_READ_PURGE_MAX_RETRIES, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_RETRIES;
  }
  return parsed;
}

/**
 * Computes a deterministic exponential backoff delay for a retry attempt.
 *
 * @param {number} attempt - 1-based retry attempt number.
 * @returns {number} Delay in ms, capped at 30 s.
 */
function getRetryDelayMs(attempt) {
  const delay = BASE_RETRY_DELAY_MS * 2 ** (Math.max(1, attempt) - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Sleeps for the given duration. Exposed for testability via the options
 * bag so tests can inject a no-op sleep.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-process mutex guard for the purge handler. */
let purgeInFlight = null;

/**
 * Resets the in-flight guard. Test-only hook to keep suites isolated.
 *
 * @returns {void}
 */
function _resetInFlight() {
  purgeInFlight = null;
}

/**
 * Runs a single purge attempt with metrics and structured logging.
 *
 * @param {object} job
 * @param {object} options
 * @param {number} attempt
 * @returns {Promise<object>}
 */
async function _attemptPurge(job, options, attempt) {
  const startedAt = Date.now();
  const summary = await purgeExpiredSoftDeletes(options);

  escrowReadPurgeRowsDeletedTotal.inc(summary.purged);
  if (attempt > 1) {
    escrowReadPurgeRowsDeletedOnRetryTotal.inc(summary.purged);
  }
  escrowReadPurgeRunsTotal.inc({ status: 'success' });

  logger.info(
    {
      jobId: job.id,
      attempt,
      purged: summary.purged,
      batches: summary.batches,
      cutoff: summary.cutoff,
      retentionDays: summary.retentionDays,
      maxBatchesReached: summary.maxBatchesReached,
      durationMs: Date.now() - startedAt,
    },
    'escrowReadPurge: run completed'
  );

  return { success: true, attempts: attempt, ...summary };
}

/**
 * Job handler: purges expired escrow-read tombstones and records metrics.
 *
 * Retries are bounded and backoff-aware. A failure that occurs after some
 * batches have already been deleted is safe to retry: the next attempt recomputes
 * the cutoff and only targets remaining expired tombstones. The counters and
 * logs report the partial progress of each attempt so operators can diagnose
 * and resume without guessing.
 *
 * Concurrent invocations of this handler are serialised via an in-process
 * mutex; a second caller awaits the in-flight run rather than contending on the
 * same rows. This keeps the worker configuration (maxConcurrency: 1) and the
 * manual trigger path consistent.
 *
 * @param {object} [job={}] - Job envelope from the queue (`id` used for logs).
 * @param {object} [options={}] - Forwarded to
 *   {@link module:services/escrowReadSoftDelete.purgeExpiredSoftDeletes}
 *   (`dbClient`, `now`, `batchSize`, `maxBatches`) — used by tests.
 * @param {number} [options.maxRetries]
 * @param {function} [options.sleep]
 * @returns {Promise<object>} Purge summary plus `success: true`.
 * @throws {Error} Re-throws the underlying failure after recording metrics and
 *   exhausting retries so the worker's retry policy applies.
 */
async function runEscrowReadPurge(job = {}, options = {}) {
  if (purgeInFlight) {
    logger.debug(
      { jobId: job.id },
      'escrowReadPurge: awaiting in-flight run'
    );
    return purgeInFlight;
  }

  const maxRetries = getMaxRetries(options);
  const sleep = typeof options.sleep === 'function' ? options.sleep : _sleep;

  const run = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        return await _attemptPurge(job, options, attempt);
      } catch (error) {
        lastError = error;
        escrowReadPurgeRunsTotal.inc({ status: 'error' });
        logger.error(
          {
            jobId: job.id,
            attempt,
            maxAttempts: maxRetries + 1,
            errorName: error.name,
            err: error.message,
          },
          'escrowReadPurge: attempt failed'
        );

        if (attempt > maxRetries) {
          break;
        }

        escrowReadPurgeRetriesTotal.inc();
        const delayMs = getRetryDelayMs(attempt);
        logger.warn(
          { jobId: job.id, attempt, delayMs },
          'escrowReadPurge: retrying after backoff'
        );
        await sleep(delayMs);
      }
    }

    throw lastError;
  })();

  purgeInFlight = run;
  try {
    return await run;
  } finally {
    if (purgeInFlight === run) {
      purgeInFlight = null;
    }
  }
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1, // Serialised: concurrent purges would contend on the same rows.
  pollIntervalMs: 5000,
});

purgeWorker.registerHandler(JOB_TYPE, (job) => runEscrowReadPurge(job));

/**
 * Enqueues a purge run.
 *
 * @param {object} [options={}]
 * @param {number} [options.delayMs=getIntervalMs()] - Delay before execution.
 * @returns {string} Job ID.
 */
function schedulePurge(options = {}) {
  const delayMs = options.delayMs ?? getIntervalMs();
  const jobId = purgeQueue.enqueue(JOB_TYPE, {}, { delayMs });
  logger.debug({ jobId, delayMs }, 'escrowReadPurge: scheduled run');
  return jobId;
}

/**
 * Starts the worker and schedules the first run. Safe to call twice.
 *
 * @returns {void}
 */
function startPurgeWorker() {
  if (!purgeWorker.isRunning) {
    purgeWorker.start();
    schedulePurge();
    logger.info(
      { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
      'escrowReadPurge: worker started'
    );
  }
}

/**
 * Stops the worker, allowing in-flight runs to finish.
 *
 * @param {number} [timeoutMs=10000] - Grace period.
 * @returns {Promise<void>}
 */
async function stopPurgeWorker(timeoutMs = 10000) {
  await purgeWorker.stop(timeoutMs);
  logger.info('escrowReadPurge: worker stopped');
}

/**
 * Triggers a purge immediately (admin endpoint / operational runbooks).
 *
 * @returns {string} Job ID.
 */
function triggerPurge() {
  return schedulePurge({ delayMs: 0 });
}

/**
 * Worker/queue/config snapshot for monitoring.
 *
 * @returns {object} `{ worker, queue, config }`.
 */
function getStats() {
  return {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    config: {
      retentionDays: getRetentionDays(),
      batchSize: getPurgeBatchSize(),
      maxBatches: getPurgeMaxBatches(),
      intervalMs: getIntervalMs(),
      maxRetries: getMaxRetries(),
    },
  };
}

module.exports = {
  JOB_TYPE, 
  runEscrowReadPurge,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  getMaxRetries,
  getRetryDelayMs,
  _resetInFlight,
  purgeQueue,
  purgeWorker,
};
