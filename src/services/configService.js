'use strict';

/**
 * @fileoverview Runtime configuration service: applies admin-supplied config
 * changes, persists them via the soft-delete store, and manages short-lived
 * API-key rotation state in memory.
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

// Per-tenant API-key rotation state and a serialised queue so rotations for a
// single tenant never interleave.
const keyStates = new Map();
const tenantQueues = new Map();

// Maximum overlap window (30 days) in seconds. Guards against accidentally
// indefinite retiring keys that would never expire.
const MAX_OVERLAP_SECONDS = 30 * 24 * 60 * 60;

// Maximum length for a key value before hashing. Prevents unbounded memory
// use from malicious input.
const MAX_KEY_LENGTH = 4096;

// Maximum length for a tenant identifier.
const MAX_TENANT_ID_LENGTH = 256;

/** Stable, non-secret identifier for a key value (SHA-256). */
function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Returns the in-memory rotation state for a tenant, or an empty state.
 *
 * @param {string} tenantId - Tenant identifier.
 * @returns {{active: Object|null, retiring: Object|null}}
 */
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
  if (
    typeof tenantId !== 'string' ||
    tenantId.length === 0 ||
    tenantId.length > MAX_TENANT_ID_LENGTH
  ) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (typeof currentKey !== 'string' || currentKey.length === 0 || currentKey.length > MAX_KEY_LENGTH) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (typeof newKey !== 'string' || newKey.length === 0 || newKey.length > MAX_KEY_LENGTH) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (currentKey === newKey) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // nonsecret
    throw err;
  }
  if (
    !Number.isInteger(overlapSeconds) ||
    overlapSeconds <= 0 ||
    overlapSeconds > MAX_OVERLAP_SECONDS
  ) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // noson-secret
    throw err;
  }
  if (activationTime !== undefined && !Number.isFinite(activationTime)) {
    const err = new Error('Invalid rotation parameters');
    err.code = 'INVALID_ROTATION_PARAMS'; // nonsecret
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

    const newFingerprint = keyFingerprint(newKey);
    if (state.active.keyHash === newFingerprint) {
      const err = new Error('New key must differ from the current active key');
      err.code = 'KEY_ALREADY_ACTIVE';
      throw err;
    }

    const notBefore = activationTime !== undefined ? activationTime : now;
    const next = {
      active: {
        keyId: crypto.randomUUID(),
        keyHash: newFingerprint,
        notBefore,
        createdAt: now,
      },
      retiring: {
        keyId: state.active.keyId,
        keyHash: state.active.keyHash,
        expiresAt: now + overlapSeconds * 1000,
      },
    };

    // Persist first; only mutate in-memory state after the write succeeds so a
    // failed persist never leaves the runtime state ahead of the durable store.
    await persistConfig({ section: 'apiKeyState', config: next, tenantId, actor: actor || null });
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
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > MAX_TENANT_ID_LENGTH) {
    return { valid: false, reason: 'Key is not valid or has expired' };
  }
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
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
 * @param {string} section - Configuration section name.
 * @param {Object} config - Section configuration payload.
 * @param {Object} context - Request context (`tenantId`, `adminClient`).
 * @returns {Promise<{id?: string, section: string, config: Object, message: string}>}
 */
async function applyConfig(section, config, context) {
  if (typeof section !== 'string' || section.length === 0) {
    const err = new Error('Config section is required');
    err.code = 'INVALID_CONFIG_SECTION';
    throw err;
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    const err = new Error('Config payload must be a plain object');
    err.code = 'INVALID_CONFIG_PAYLOAD';
    throw err;
  }
  if (context === null || typeof context !== 'object') {
    const err = new Error('Config context is required');
    err.code = 'INVALID_CONFIG_CONTEXT';
    throw err;
  }

  const { tenantId, adminClient } = context;

  if (section === 'cors') {
    applyCorsConfig(config);
  }

  let persisted;
  try {
    persisted = await persistConfig({
      section,
      config,
      tenantId: tenantId || '',
      actor: adminClient || null,
    });
  } catch (err) {
    logger.error({ err, section, tenantId }, 'configService: failed to persist config');
  }

  const logPayload = { tenantId, section, adminClient };
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
  if (config.origins !== undefined) {
    if (!Array.isArray(config.origins)) {
      const err = new Error('CORS origins must be an array of strings');
      err.code = 'INVALID_CORS_ORIGINS'; // nosecret
      throw err;
    }
    const origins = config.origins.map((origin) => {
      if (typeof origin !== 'string' || origin.length === 0) {
        const err = new Error('CORS origins must be an array of non-empty strings');
        err.code = 'INVALID_CORS_ORIGIN'; // nonsecret
        throw err;
      }
      return origin.trim();
    });
    process.env.CORS_ALLOWED_ORIGINS = origins.join(',');
    reloadCorsOrigins();
  }
  if (config.maxAge !== undefined) {
    if (!Number.isInteger(config.maxAge) || config.maxAge < 0) {
      const err = new Error('CORS maxAge must be a non-negative integer');
      err.code = 'INVALID_CORS_MAX_AGE'; // nonsecret
      throw err;
    }
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

/**
 * Resets the in-memory rotation state for a tenant. Intended for tests and
 * operational recovery tooling; not part of the public API contract.
 *
 * @param {string} tenantId - Tenant identifier.
 */
function _resetState(tenantId) {
  if (tenantId === undefined) {
    keyStates.clear();
    tenantQueues.clear();
    return;
  }
  keyStates.delete(tenantId);
  tenantQueues.delete(tenantId);
}

module.exports = {
  applyConfig,
  applyCorsConfig,
  getConfigSections,
  rotateApiKey,
  validateApiKey,
  _resetState,
};
