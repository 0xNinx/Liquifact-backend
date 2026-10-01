'use strict';

/**
 * @fileoverview Runtime configuration service: applies admin-supplied config
 * changes, persists them via the soft-delete store, and manages short-lived
 * API-Key rotation state in memory.
 *
 * This file was previously stored as a minified blob with several defects
 * (`crypto.randomUUId`, a stray quote in the `retiring` label, and a broken
 * template literal in the acceptance message). It is restored here as clean,
 * readable source with the same external contract.
 *
 * @module services/configService
 */

const crypto = require('crypto');
const { reloadCorsOrigins, reloadCorsMaxAge } = require('../config/cors');
const { persistConfig } = require('./configSoftDelete');
const logger = require('../logger');

// Per-tenant API-Key rotation state and a serialised queue so rotations for a
// single tenant never interleave.
const keyStates = new Map();
const tenantQueues = new Map();

// Maximum number of attempts for a single persistence operation.
const PERSIST_MAX_ATTEMPTS = 3;
// Base delay between persistence retries (ms).
const PERSIST_RETRY_BASE_DELAY_MS = 25;

/** Stable, non-secret identifier for a key value (SHA-256). */
function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function getState(tenantId) {
  return keyStates.get(tenantId) || { active: null, retiring: null };
}

/**
 * Serialises async operations per tenant so rotations apply in order.
 *
 * @param {string} tenantId - Tenant identifier.
 * @param {Function} op - Async operation to enqueue.
 * @returns {Promise<*>} Result of `op`.
 */
function enqueue(tenantId, op) {
  const previous = tenantQueues.get(tenantId) || Promise.resolve();
  const gate = previous.catch(() => {});
  const run = gate.then(op);
  tenantQueues.set(tenantId, run.catch(() => {}));
  return run;
}

/**
 * Retries an async operation with exponential backoff. The operation is
 * assumed to be idempotent or safe to repeat.
 *
 * @param {Function} op - Async operation to retry.
 * @param {Object} [options] - Retry options.
 * @param {number} [options.maxAttempts] - Maximum attempts.
 * @param {number} [options.baseDelayMs] - Base backoff delay.
 * @returns {Promise<*>} Result of `op`.
 */
async function retryWithBackoff(op, { maxAttempts = PERSIST_MAX_ATTEMPTS, baseDelayMs = PERSIST_RETRY_BASE_DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) {
        break;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Rotates a tenant's active API key with an overlap window so already-issued
 * keys keep working while the new key is rolled out.
 *
 * @param {Object} params - Rotation parameters.
 * @param {string} params.tenantId - Owning tenant.
 * @param {string} params.currentKey - The currently-active key to authorise the rotation.
 * @param {string} params.newKey - The replacement key.
 * @param {number} params.overlapSeconds - Time the old key stays valid after activation.
 * @param {number} [params.activationTime] - Optional override for activation timestamp (ms).
 * @param {string|null} [params.actor] - Actor performing the rotation.
 * @returns {Promise<{tenantId: string, oldKeyId: string, newKey: string, expiresAt: number}>}
 */
async function rotateApiKey({ tenantId, currentKey, newKey, overlapSeconds, activationTime, actor }) {
  if (!tenantId || !currentKey || !newKey || !Number.isInteger(overlapSeconds) || overlapSeconds <= 0) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS';
    throw err;
  }

  return enqueue(tenantId, async () => {
    const state = getState(tenantId);
    const now = Date.now();
    const currentFingerprint = keyFingerprint(currentKey);

    if (!state.active || state.active.keyHash !== currentFingerprint) {
      const err = new Error('Active API key not found');
      err.code = 'KEY_NOT_FOUND';
      throw err;
    }

    const notBefore = activationTime || now;
    const next = {
      active: {
        keyId: crypto.randomUUID(),
        keyHash: keyFingerprint(newKey),
        notBefore,
        createdAt: now,
      },
      retiring: {
        keyId: state.active.keyId,
        keyHash: state.active.keyHash,
        expiresAt: now + overlapSeconds * 1000,
      },
    };

    // Persist before mutating in-memory state. If persistence fails after
    // retries, the in-memory state remains unchanged so the caller can
    // retry the rotation deterministically without losing the old key.
    try {
      await retryWithBackoff(() =>
        persistConfig({ section: 'apiKeyState', config: next, tenantId, actor: actor || null })
      );
    } catch (err) {
      logger.error(
        { err, tenantId, actor: actor || null },
        'configService: failed to persist API key rotation'
      );
      const wrapped = new Error('Failed to persist API key rotation');
      wrapped.code = 'ROTATION_PERSIST_FAILED';
      wrapped.cause = err;
      throw wrapped;
    }

    keyStates.set(tenantId, next);

    return {
      tenantId,
      oldKeyId: state.active.keyId,
      newKey: next.active.keyId,
      expiresAt: next.retiring.expiresAt,
    };
  });
}

/**
 * Validates a presented API key against the tenant's in-memory rotation state.
 *
 * @param {Object} params - Lookup parameters.
 * @param {string} params.tenantId - Owning tenant.
 * @param {string} params.key - Presented key.
 * @returns {{valid: true, state: string, keyId: string, expiresAt?: number} | {valid: false, reason: string}}
 */
function validateApiKey({ tenantId, key }) {
  if (!tenantId || typeof key !== 'string' || key.length === 0) {
    return { valid: false, reason: 'Key is not valid or has expired' };
  }

  const state = getState(tenantId);
  const now = Date.now();
  const fingerprint = keyFingerprint(key);

  if (state.active && state.active.keyHash === fingerprint && now >= state.active.notBefore) {
    return { valid: true, state: 'active', keyId: state.active.keyId };
  }
  if (state.retiring && state.retiring.keyHash === fingerprint && now <= state.retiring.expiresAt) {
    return { valid: true, state: 'retiring', keyId: state.retiring.keyId, expiresAt: state.retiring.expiresAt };
  }
  return { valid: false, reason: 'Key is not valid or has expired' };
}

/**
 * Applies + persists an admin configuration change.
 *
 * CORS mutations are applied only after the config is successfully
 * persisted, so a persistence failure cannot leave the runtime allowlist in
 * an unpersisted state. If persistence fails after retries the call rejects
 * with a stable error code so the admin can retry deterministically.
 *
 * @param {string} section - Configuration section name.
 * @param {Object} config - Section configuration payload.
 * @param {Object} context - Request context (`tenantId`, `adminClient`).
 * @returns {Promise<{id?: string, section: string, config: Object, message: string}>}
 */
async function applyConfig(section, config, context) {
  const { tenantId, adminClient } = context || {};

  let persisted;
  try {
    persisted = await retryWithBackoff(() =>
      persistConfig({
        section,
        config,
        tenantId: tenantId || '',
        actor: adminClient || null,
      })
    );
  } catch (err) {
    logger.error(
      { err, section, tenantId: tenantId || '', adminClient: adminClient || null },
      'configService: failed to persist config'
    );
    const wrapped = new Error('Failed to persist configuration change');
    wrapped.code = 'CONFIG_PERSIST_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  // Only apply runtime side effects after the change is durably persisted.
  if (section === 'cors') {
    applyCorsConfig(config);
  }

  const logPayload = { tenantId: tenantId || '', section, adminClient: adminClient || null };
  if (persisted && persisted.id) {
    logPayload.recordId = persisted.id;
  }
  logger.info(logPayload, 'Admin runtime config update accepted');

  return {
    id: persisted ? persisted.id : undefined,
    section,
    config,
    message: `Configuration section '${section}' validated and accepted.`,
  };
}

/**
 * Applies CORS-specific runtime configuration (origins / max-age) and reloads
 * the allowlist.
 *
 * @param {Object} config - CORS section config.
 */
function applyCorsConfig(config) {
  if (config.origins) {
    process.env.CORS_ALLOWED_ORIGINS = config.origins.join(',');
    reloadCorsOrigins();
  }
  if (config.maxAge !== undefined) {
    process.env.CORS_MAX_AGE = String(config.maxAge);
    reloadCorsMaxAge();
  }
}

/**
 * Returns the allowed configuration section names.
 *
 * @returns {string[]}
 */
function getConfigSections() {
  const { CONFIG_SECTIONS } = require('../schemas/config');
  return CONFIG_SECTIONS;
}

module.exports = {
  applyConfig,
  applyCorsConfig,
  getConfigSections,
  rotateApiKey,
  validateApiKey,
};
