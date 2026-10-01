'use strict';

/**
 * @fileoverview Maintenance task that hard-deletes invoice records whose
 * soft-delete retention window has elapsed (issue #866).
 *
 * Soft-deleting an invoice (see {@link module:services/invoiceStateSoftDelete})
 * leaves a tombstoned `invoices` row behind. Without a purge, tombstones
 * accumulate forever — the same unbounded-growth problem the idempotency
 * purge job solves for `idempotency_keys`, and the escrow-read purge job
 * solves for `escrow_event_projection`.
 *
 * This job runs the purge on a schedule through the shared job queue/worker
 * infrastructure, emits Prometheus counters, and exposes a manual trigger for
 * the admin API.
 *
 * ## Determinism
 * The purge is serialised through a single-concurrency worker and a per-job
 * mutex so two runs can never interleave batches. Every run is idempotent:
 * deleting a tombstone twice is a no-op, and a partial failure leaves the
 * remaining tombstones in place for the next retry to consume. The cutoff
 * is computed once per run and forwarded to the service so all batches in
 * a run observe the same retention window.
 *
 * ## Configuration
 * - `INVOICE_STATE_SOFT_DELETE_RETENTION_DAYS` — restore/retention window (default 30).
 * - `INVOICE_STATE_PURGE_BATCH_SIZE` — rows deleted per batch (default 500).
 * - `INVOICE_STATE_PURGE_MAX_BATCHES` — batch cap per run (default 100).
 * - `INVOICE_STATE_PURGE_INTERVAL_MS` — cadence between runs (default 6 h, min 1 min).
 *
 * @module jobs/invoiceStatePurge
 */

const JobQueue = require('../workers/jobQueue');
const BackgroundWorker = require('../workers/worker');
const logger = require('../logger');
const { Counter } = require('prom-client');
const { getRegistry } = require('../metrics');
const {
  purgeExpiredInvoiceStateSoftDeletes,
  getRetentionDays,
  getPurgeBatchSize,
  getPurgeMaxBatches,
} = require('../services/invoiceStateSoftDelete');

/** @constant {string} */
const JOB_TYPE = 'invoice_state_purge';
/** @constant {number} */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** @constant {number} */
const MIN_INTERVAL_MS = 60_000; // 1 minute

/**
 * Registers a counter idempotently. Jest resets the module registry between
 * suites while `prom-client`'s registry is process-global, so a bare
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

const invoiceStatePurgeRowsDeletedTotal = _counter( {
  name: 'liquifact_invoice_state_purge_rows_deleted_total',
  help: 'Total invoice tombstones hard-deleted after their retention window',
});

const invoiceStatePurgeRunsTotal = _counter({
  name: 'liquifact_invoice_state_purge_runs_total',
  help: 'Total invoice-state purge job runs by outcome',
  labelNames: ['status'],
});

/**
 * Reads the purge cadence.
 *
 * @returns {number} Interval in ms (minimum 60000; default 6 h).
 */
function getIntervalMs() {
  const parsed = parseInt(process.env.INVOICE_STATE_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Serialises purge runs within this process. The worker is already
 * single-concurrency, but the admin trigger and the scheduled run can both
 * be enqueued and the mutex guarantees they never interleave batches.
 *
 * @returns {Promise<void>} Resolves once the mutex is held.
 */
let _purgeChain = Promise.resolve();

function _withPurgeMutex(fn) {
  const run = _purgeChain.then(fn, fn);
  // Keep the chain alive even if the run rejects.
  _purgeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Job handler: purges expired invoice tombstones and records metrics.
 *
 * The cutoff is computed once and forwarded to the service so every batch
 * in the run observes the same retention window. Runs are serialised by a
 * per-process mutex so concurrent triggers cannot contend on the same rows.
 *
 * @param {object} [job={}] - Job envelope from the queue (`id` used for logs).
 * @param {object} [options={}] - Forwarded to
 *   {@link module:services/invoiceStateSoftDelete.purgeExpiredInvoiceStateSoftDeletes}
 *   (`dbClient`, `now`, `batchSize`, `maxBatches`) -- used by tests.
 * @returns {Promise<object>} Purge summary plus `success: true`.
 * @throws {Error} Re-throws the underlying failure after recording metrics so
 *   the worker's retry policy applies.
 */
async function runInvoiceStatePurge(job = {}, options = {}) {
  const startedAt = Date.now();

  return _withPurgeMutex(async () => {
    try {
      const summary = await purgeExpiredInvoiceStateSoftDeletes(options);

      invoiceStatePurgeRowsDeletedTotal.inc(summary.purged);
      invoiceStatePurgeRunsTotal.inc({ status: 'success' });

      logger.info(
        {
          jobId: job.id,
          purged: summary.purged,
          batches: summary.batches,
          cutoff: summary.cutoff,
          retentionDays: summary.retentionDays,
          maxBatchesReached: summary.maxBatchesReached,
          durationMs: Date.now() - startedAt,
        },
        'invoiceStatePurge: run completed'
      );

      return { success: true, ...summary };
    } catch (error) {
      invoiceStatePurgeRunsTotal.inc({ status: 'error' });
      logger.error(
        { jobId: job.id, err: error.message, durationMs: Date.now() - startedAt },
        'invoiceStatePurge: run failed'
      );
      throw error;
    }
  });
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: 1, // Serialised: concurrent purges would contend on the same rows.
});

purgeWorker.registerHandler(JOB_TYPE, (job) => runInvoiceStatePurge(job));

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
  logger.debug({ jobId, delayMs }, 'invoiceStatePurge: scheduled run');
  return jobId;
}

/**
 * Stable UUID v4 pattern used to validate the fencing token.
 *
 * @type {RegExp}
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates the fencing token supplied at worker start.
 *
 * Skipped in test environments where `crypto.randomUUID()` may not be
 * available and the token provides no useful safety invariant.
 *
 * @param {unknown} token - Value passed as `fencingToken` by the caller.
 * @returns {void}
 * @throws {TypeError} When called outside of the test environment with a
 *   missing or malformed token.
 */
function validateFencingToken(token) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  if (typeof token !== 'string' || !UUID_V4_RE.test(token)) {
    throw new TypeError(
      'startPurgeWorker: fencingToken must be a UUID v4 string. ' +
      'Pass `{ fencingToken: crypto.randomUUID() }` from src/index.js.'
    );
  }
}

/**
 * Starts the worker and schedules the first run. Safe to call twice.
 *
 * @param {object} [options={}] - Start options.
 * @param {string} [options.fencingToken] - A UUID v4 token generated by the
 *   caller at boot time.  Required in non-test environments so that a
 *   misconfigured or missing token fails loudly rather than silently.
 * @returns {void}
 * @throws {TypeError} When `fencingToken` is absent or not a valid UUID v4
 *   (non-test environments only).
 */
function startPurgeWorker(options = {}) {
  validateFencingToken(options.fencingToken);

  if (!purgeWorker.isRunning) {
    purgeWorker.start();
    schedulePurge();
    logger.info(
      {
        retentionDays: getRetentionDays(),
        intervalMs: getIntervalMs(),
        fencingToken: options.fencingToken ? '[present]' : '[absent]',
      },
      'invoiceStatePurge: worker started'
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
  logger.info('invoiceStatePurge: worker stopped');
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
    },
  };
}

module.exports = {
  JOB_TYPE,
  runInvoiceStatePurge,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  purgeQueue,
  purgeWorker,
  validateFencingToken,
};
