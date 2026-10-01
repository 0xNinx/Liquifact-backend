'use strict';

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
} = require('../services/metricsSoftDelete');

const JOB_TYPE = 'metrics_purge';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_PURGES = 1;

function _counter(config) {
  const registry = getRegistry();
  const existing = registry.getSingleMetric(config.name);
  if (existing) {
    return existing;
  }
  return new Counter({ ...config, registers: [registry] });
}

const metricsPurgeRowsDeletedTotal = _counter( {
  name: 'liquifact_metrics_purge_rows_deleted_total',
  help: 'Total metric tombstones hard-deleted after their retention window',
});

const metricsPurgeRunsTotal = _counter({
  name: 'liquifact_metrics_purge_runs_total',
  help: 'Total metrics purge job runs by outcome',
  labelNames: ['status'],
});

function getIntervalMs() {
  const parsed = parseInt(process.env.METRICS_PURGE_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS) {
    return DEFAULT_INTERVAL_MS;
  }
  if (parsed > MAX_INTERVAL_MS) {
    return MAX_INTERVAL_MS;
  }
  return parsed;
}

let _activePurge = null;

async function runMetricsPurge(job = {}, options = {}) {
  if (_activePurge) {
    logger.warn(
      { jobId: job.id },
      'metricsPurge: run skipped, another purge is already in progress'
    );
    metricsPurgeRunsTotal.inc({ status: 'skipped' });
    return { success: false, skipped: true, reason: 'already_running' };
  }

  _activePurge = (async () => {
  const startedAt = Date.now();

  try {
    const summary = await purgeExpiredSoftDeletes(options);

    metricsPurgeRowsDeletedTotal.inc(summary.purged);
    metricsPurgeRunsTotal.inc({ status: 'success' });

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
      'metricsPurge: run completed'
    );

    return { success: true, ...summary };
  } catch (error) {
    metricsPurgeRunsTotal.inc({ status: 'error' });
    logger.error(
      { jobId: job.id, err: error.message, durationMs: Date.now() - startedAt },
      'metricsPurge: run failed'
    );
    throw error;
  }
  })();

  try {
    return await _activePurge;
  } finally {
    _activePurge = null;
  }
}

const purgeQueue = new JobQueue();
const purgeWorker = new BackgroundWorker({
  jobQueue: purgeQueue,
  maxConcurrency: MAX_CONCURRENT_PURGES,
  pollIntervalMs: 5000,
});

purgeWorker.registerHandler(NJOB_TYPE, (job) => runMetricsPurge(job));

function schedulePurge(options = {}) {
  const delayMs = options.delayMs ?? getIntervalMs();
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError('schedulePurge: delayMs must be a non-negative finite number');
  }
  const jobId = purgeQueue.enqueue(JOB_TYPE, {}, { delayMs });
  logger.debug({ jobId, delayMs }, 'metricsPurge: scheduled run');
  return jobId;
}

function startPurgeWorker() {
  if (!purgeWorker.isRunning) {
    purgeWorker.start();
    schedulePurge();
    logger.info(
      { retentionDays: getRetentionDays(), intervalMs: getIntervalMs() },
      'metricsPurge: worker started'
    );
  }
}

async function stopPurgeWorker(timeoutMs = 10000) {
  await purgeWorker.stop(timeoutMs);
  _activePurge = null;
  logger.info('metricsPurge: worker stopped');
}

function triggerPurge() {
  return schedulePurge({ delayMs: 0 });
}

function getStats() {
  return {
    worker: purgeWorker.getStats(),
    queue: purgeQueue.getStats(),
    activePurge: _activePurge !== null,
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
  runMetricsPurge,
  schedulePurge,
  startPurgeWorker,
  stopPurgeWorker,
  triggerPurge,
  getStats,
  getIntervalMs,
  purgeQueue,
  purgeWorker,
  MAX_INTERVAL_MS,
};
