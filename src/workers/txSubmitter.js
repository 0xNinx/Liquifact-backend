'use strict';

const { JobQueue, DurableJobQueue } = require('./jobQueue');
const BackgroundWorker = require('./worker');
const logger = require('../logger');
const db = require('../db/knex');

const DEFAULT_CONFIG = {
  maxRetries: Math.min(parseInt(process.env.SOROBAN_TX_SUBMIT_MAX_RETRIES || '3', 10), 10),
  baseDelayMs: Math.min(parseInt(process.env.SOROBAN_TX_SUBMIT_BASE_DELAY_MS || '500', 10), 10000),
  maxDelayMs: Math.min(parseInt(process.env.SOROBAN_TX_SUBMIT_MAX_DELAY_MS || '20000', 10), 60000),
  feeBumpMultiplier: Math.min(parseFloat(process.env.SOROBAN_TX_FEE_BUMP_MULTIPLIER || '2'), 10),
};

/**
 * Determines if a transaction submission error is transient and retryable.
 *
 * @param {any} err - The error object to inspect.
 * @returns {boolean} True if the error is retryable.
 */
function isRetryableSubmitError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const code = String(err.code || '').toLowerCase();
  if (['etimedout', 'econnreset', 'eai_again', 'enotfound'].includes(code)) {
    return true;
  }

  const message = String(err.message || err).toLowerCase();
  if (message.includes('tx_bad_seq') || message.includes('timeout') || message.includes('timed out') || message.includes('transaction_timeout')) {
    return true;
  }

  const resultCode = err.result?.code || err.result?.result?.code;
  if (typeof resultCode === 'string' && resultCode.toLowerCase().includes('tx_bad_seq')) {
    return true;
  }

  return false;
}

/**
 * Computes exponential backoff for transaction retries.
 *
 * @param {number} attempt - Current attempt number.
 * @param {number} baseDelay - Initial delay in milliseconds.
 * @param {number} maxDelay - Maximum delay in milliseconds.
 * @returns {number} Delay in milliseconds.
 */
function computeTxBackoff(attempt, baseDelay, maxDelay) {
  const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
  return Math.max(0, delay);
}

/**
 * Executes a transaction operation with automatic retries on transient errors.
 *
 * @param {Function} operation - The operation to execute.
 * @param {object} [config={}] - Optional retry configuration overrides.
 * @returns {Promise<any>} Result of the operation.
 */
async function submitWithRetry(operation, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    try {
      return await operation({ attempt, feeBumpMultiplier: cfg.feeBumpMultiplier });
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === cfg.maxRetries;
      if (isLastAttempt || !isRetryableSubmitError(err)) {
        throw err;
      }
      const delayMs = computeTxBackoff(attempt, cfg.baseDelayMs, cfg.maxDelayMs);
      logger.warn({ attempt, delayMs, error: err.message || err, retryable: true }, 'Retrying Soroban transaction submission after transient failure');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Job handler for processing transaction submission jobs.
 *
 * @param {object} job - The job object from the queue.
 * @param {Function} submitTransactionFn - The function that performs the submission.
 * @param {object} [config={}] - Optional configuration.
 * @returns {Promise<any>} Result of the submission.
 */
async function handleTxSubmitJob(job, submitTransactionFn, config = {}) {
  if (!job || typeof job.payload !== 'object' || job.payload === null) {
    throw new Error('Invalid tx submit job payload');
  }
  if (typeof submitTransactionFn !== 'function') {
    throw new Error('submitTransactionFn must be supplied');
  }

  const payload = job.payload;
  if (typeof payload.signedTransactionXdr !== 'string' || payload.signedTransactionXdr.trim() === '') {
    throw new Error('signedTransactionXdr is required for transaction submission');
  }

  return submitWithRetry(async (context) => {
    return submitTransactionFn(payload, context);
  }, config);
}

/**
 * Creates a worker for background transaction submission.
 *
 * When `durable` is enabled (default), jobs are persisted to `tx_submissions`
 * and restored on startup so in-flight Soroban submissions survive restarts.
 *
 * @param {Function} submitTransactionFn - Function to submit transactions.
 * @param {object} [options={}] - Worker and retry options.
 * @param {boolean} [options.durable=true] - Persist queued submissions to Postgres.
 * @param {import('knex').Knex} [options.db] - Knex instance for persistence.
 * @param {string} [options.tableName='tx_submissions'] - Persistence table name.
 * @returns {object} The worker controller object.
 */
function createTxSubmitterWorker(submitTransactionFn, options = {}) {
  const durable = options.durable !== false;
  const persistenceDb = options.db || db;
  const txQueue = durable
    ? new DurableJobQueue({
      maxRetries: 0,
      db: persistenceDb,
      tableName: options.tableName || 'tx_submissions',
    })
    : new JobQueue({ maxRetries: 0 });
  const txWorker = new BackgroundWorker({ jobQueue: txQueue, pollIntervalMs: options.pollIntervalMs ?? 100, maxConcurrency: options.maxConcurrency ?? 1 });
  let restored = !durable;

  txWorker.registerHandler('submit_soroban_tx', async (job) => {
    return handleTxSubmitJob(job, submitTransactionFn, options.retryConfig);
  });

  /**
   * Restores durable jobs from the database once per process.
   *
   * @returns {Promise<{restored: number, skipped: number}>} Restore summary.
   */
  async function ensureRestored() {
    if (restored || typeof txQueue.restore !== 'function') {
      return { restored: 0, skipped: 0 };
    }

    const summary = await txQueue.restore();
    restored = true;
    return summary;
  }

  return {
    txQueue,
    txWorker,
    restore: ensureRestored,
    enqueueTxSubmission: async (payload, enqueueOptions = {}) => {
      await ensureRestored();
      return txQueue.enqueue('submit_soroban_tx', payload, enqueueOptions);
    },
    start: async () => {
      await ensureRestored();
      txWorker.start();
    },
    stop: (timeoutMs) => txWorker.stop(timeoutMs),
  };
}

module.exports = {
  createTxSubmitterWorker,
  submitWithRetry,
  isRetryableSubmitError,
  computeTxBackoff,
  handleTxSubmitJob,
  DEFAULT_CONFIG,
};
