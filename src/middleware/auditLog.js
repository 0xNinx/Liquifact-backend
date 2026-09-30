'use strict';

const { appendAuditEvent, redactValue } = require('../services/auditLogStore');
const logger = require('../logger');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Determines the actor (user or API client) from the request.
 * @param {import("express").Request} req The Express request object.
 * @returns {{actorType: string, actorId: string}} The actor's type and ID.
 */
function getActor(req) {
  if (req.user && typeof req.user === 'object') {
    if (req.user.id) {
      return { actorType: 'user', actorId: String(req.user.id) };
    }
    if (req.user.sub) {
      return { actorType: 'user', actorId: String(req.user.sub) };
    }
  }

  if (req.apiClient && req.apiClient.clientId) {
    return { actorType: 'api_client', actorId: String(req.apiClient.clientId) };
  }

  return { actorType: 'system', actorId: req.ip || 'unknown' };
}

/**
 * Checks if the request path is an admin action.
 * @param {import("express").Request} req The Express request object.
 * @returns {boolean} True if the request is for an admin action.
 */
function isAdminAction(req) {
  return req.path.startsWith('/api/admin/');
}

/**
 * Builds a base audit event object from the request.
 * @param {import("express").Request} req The Express request object.
 * @returns {object} The base audit event object.
 */
function buildBaseEvent(req) {
  const actor = getActor(req);
  return {
    ...actor,
    requestId: req.id || (req.headers && req.headers['x-correlation-id']),
    route: req.originalUrl || req.path,
    method: req.method,
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || null,
  };
}

/**
 * Creates an audit context object for the given request.
 * @param {import("express").Request} req The Express request object.
 * @returns {{logAdminAction: Function, logWebhookDelivery: Function}} The audit context with logging functions.
 */
function createAuditContext(req) {
  const baseEvent = buildBaseEvent(req);

  return {
    async logAdminAction(action, options = {}) {
      await appendAuditEvent({
        ...baseEvent,
        eventType: 'admin_action',
        action,
        targetType: options.targetType || null,
        targetId: options.targetId || null,
        statusCode: options.statusCode,
        metadata: {
          before: redactValue(options.before || null),
          after: redactValue(options.after || null),
          ...options.metadata,
        },
      });
    },
    async logWebhookDelivery(options = {}) {
      await appendAuditEvent({
        ...baseEvent,
        eventType: 'webhook_delivery',
        action: options.action || 'webhook.dispatch',
        targetType: 'webhook_endpoint',
        targetId: options.endpointId || options.endpoint || null,
        statusCode: options.statusCode,
        metadata: redactValue({
          endpoint: options.endpoint,
          deliveryId: options.deliveryId,
          outcome: options.outcome,
          requestPayload: options.requestPayload,
          responseBody: options.responseBody,
          errorCode: options.errorCode,
          errorMessage: options.errorMessage,
          ...options.metadata,
        }),
      });
    },
    /**
     * Persists an append-only audit record for retention policy or legal-hold mutations.
     *
     * @param {string} action - Semantic action (e.g. `retention.policy.create`).
     * @param {object} [options={}] - Target and change snapshots.
     * @param {string} [options.targetType] - Audit target resource type.
     * @param {string} [options.targetId] - Audit target identifier.
     * @param {number} [options.statusCode] - HTTP status of the mutation.
     * @param {*} [options.before] - Pre-mutation snapshot (redacted before persistence).
     * @param {*} [options.after] - Post-mutation snapshot (redacted before persistence).
     * @param {object} [options.metadata] - Additional metadata; should include `tenantId`.
     * @returns {Promise<void>}
     */
    async logRetentionMutation(action, options = {}) {
      const tenantId = options.metadata?.tenantId || req.tenantId || null;
      await appendAuditEvent({
        ...baseEvent,
        eventType: 'retention_mutation',
        action,
        targetType: options.targetType || null,
        targetId: options.targetId || null,
        statusCode: options.statusCode,
        metadata: {
          tenantId,
          before: redactValue(options.before || null),
          after: redactValue(options.after || null),
          ...options.metadata,
        },
      });
    },
  };
}

/**
 * Emits a retention mutation audit event without failing the primary mutation.
 * Reuses {@link createAuditContext} for consistent actor, route, and redaction metadata.
 *
 * @param {import('express').Request} req - Express request carrying actor and route context.
 * @param {string} action - Retention action identifier (e.g. `retention.policy.create`).
 * @param {object} [options={}] - Passed through to {@link createAuditContext#logRetentionMutation}.
 * @returns {Promise<void>}
 */
async function emitRetentionAuditSafely(req, action, options = {}) {
  const audit = createAuditContext(req);
  try {
    await audit.logRetentionMutation(action, options);
  } catch (error) {
    logger.error(
      {
        err: error,
        action,
        tenantId: options.metadata?.tenantId || req.tenantId,
        targetId: options.targetId,
      },
      'failed to persist retention mutation audit event',
    );
  }
}

function auditLogMiddleware(req, res, next) {
  req.audit = createAuditContext(req);

  if (!MUTATION_METHODS.has(req.method.toUpperCase()) || !isAdminAction(req)) {
    return next();
  }

  const action = req.headers['x-admin-action'] || `${req.method.toLowerCase()}.admin`;
  const targetType = req.headers['x-audit-target-type'] || 'admin_resource';
  const targetId = req.headers['x-audit-target-id'] || req.params.id || null;
  const beforeSnapshot = req.body ? redactValue(req.body) : null;

  res.on('finish', () => {
    const statusCode = res.statusCode;
    if (statusCode < 200 || statusCode >= 300) {
      return;
    }

    req.audit
      .logAdminAction(action, {
        targetType,
        targetId,
        statusCode,
        before: beforeSnapshot,
        metadata: {
          source: 'http',
          autoLogged: true,
        },
      })
      .catch((error) => {
        req.log?.warn?.({ err: error }, 'failed to persist admin audit event');
      });
  });

  return next();
}

module.exports = {
  auditLogMiddleware,
  createAuditContext,
  emitRetentionAuditSafely,
};
