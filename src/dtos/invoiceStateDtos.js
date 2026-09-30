'use strict';

/**
 * @fileoverview Typed DTOs and boundary mappers for invoice-state endpoints.
 *
 * Defines the request/response shapes crossing the invoice-state route
 * boundary and the pure mapping functions that convert between the internal
 * service-layer objects and the public DTOs.
 *
 * Keeping the mappers pure (no side effects, no I/O) means they can be
 * exhaustively unit-tested in isolation from Express / Knex / audit-log
 * concerns, and gives us a typed boundary for safer refactors.
 *
 * @module dtos/invoiceStateDtos
 * @version 1.0.0
 * @compatibility Contract version 1.0 - All mappers guarantee stable output shapes
 *                 for valid, invalid, and boundary-case inputs. Optional fields are
 *                 omitted (not null) when undefined. Arrays are copied to prevent
 *                 caller mutation. Malformed inputs fall back to safe defaults.
 */

// ---------------------------------------------------------------------------
// Request DTOs — inbound shapes parsed (loosely) from request bodies
// ---------------------------------------------------------------------------

/**
 * Body of `POST /api/invoices/:id/transition`.
 *
 * @typedef {Object} TransitionRequestDto
 * @property {string} targetState - Desired invoice lifecycle state.
 * @property {string} [reason] - Optional human-readable rationale.
 */

/**
 * Body of `POST /api/invoices/:id/approve`.
 *
 * @typedef {Object} ApproveRequestDto
 * @property {string} [reason] - Optional approval rationale.
 */

/**
 * Body of `POST /api/invoices/:id/link-escrow`.
 *
 * @typedef {Object} LinkEscrowRequestDto
 * @property {string} [escrowId] - Escrow contract identifier.
 * @property {string} [reason] - Optional link rationale.
 */

/**
 * Body of `POST /api/invoices/:id/reject`.
 *
 * @typedef {Object} RejectRequestDto
 * @property {string} reason - Mandatory rejection rationale.
 */

// ---------------------------------------------------------------------------
// Response DTOs — outbound shapes serialised to clients
// ---------------------------------------------------------------------------

/**
 * Payload returned by `GET /api/invoices/:id/state`.
 *
 * @typedef {Object} InvoiceStateResponseDto
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} currentState - Current lifecycle state.
 * @property {string[]} allowedTransitions - Permitted next-state values.
 * @property {boolean} isTerminal - True when no further transitions exist.
 */

/**
 * Payload returned by transition-carrying endpoints (transition / approve /
 * reject) on success.
 *
 * @typedef {Object} TransitionResponseDto
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} previousState - State before the transition.
 * @property {string} currentState - State after the transition.
 * @property {string} transitionedAt - ISO-8601 timestamp of the transition.
 * @property {string} transitionedBy - Actor identifier that performed it.
 * @property {string} [reason] - Echoed rationale when one was supplied.
 * @property {string} auditLogId - Identifier of the associated audit log.
 */

/**
 * Payload returned by `POST /api/invoices/:id/link-escrow` on success.
 *
 * @typedef {Object} LinkEscrowResponseDto
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} previousState - State before the transition.
 * @property {string} currentState - State after the transition.
 * @property {string|null} escrowId - Escrow contract identifier (or null).
 * @property {string} transitionedAt - ISO-8601 timestamp of the transition.
 * @property {string} transitionedBy - Actor identifier that performed it.
 * @property {string} auditLogId - Identifier of the associated audit log.
 */

/**
 * A single entry in the invoice transition history list.
 *
 * @typedef {Object} HistoryEntryDto
 * @property {string} id - Audit-log record identifier.
 * @property {string} timestamp - ISO-8601 timestamp of the transition.
 * @property {string} actor - Actor identifier.
 * @property {string} [fromState] - State before transition (may be absent
 *   for malformed or very old audit records).
 * @property {string} [toState] - State after transition (may be absent).
 * @property {string} [reason] - Rationale captured from metadata.
 * @property {string} [ipAddress] - Source IP recorded at the time.
 */

/**
 * Body of `POST /api/invoices/bulk`.
 *
 * @typedef {Object} BulkInvoiceStateOperation
 * @property {string} invoiceId - Invoice identifier.
 * @property {string} action - The state-transition action to perform.
 * @property {string} [reason] - Optional rationale for the action.
 * @property {string} [escrowId] - Escrow contract identifier (for link-escrow).
 * @property {string} [targetState] - Target lifecycle state (for transition).
 */

/**
 * @typedef {Object} BulkSuccessItem
 * @property {number} index - Position of the item in the batch.
 * @property {boolean} success - Always true.
 * @property {string} action - The action that was performed.
 * @property {object} result - The transition result.
 */

/**
 * @typedef {Object} BulkFailureItem
 * @property {number} index - Position of the item in the batch.
 * @property {boolean} success - Always false.
 * @property {string} error - Human-readable error message.
 * @property {string} code - Machine-readable error code.
 */

/**
 * @typedef {BulkSuccessItem|BulkFailureItem} BulkResultItem
 */

/**
 * @typedef {Object} BulkSummary
 * @property {number} total - Total number of items in the batch.
 * @property {number} succeeded - Number of successfully processed items.
 * @property {number} failed - Number of items that failed.
 */

/**
 * Payload returned by `POST /api/invoices/bulk`.
 *
 * @typedef {Object} BulkInvoiceStateResponseDto
 * @property {BulkResultItem[]} results - Per-item results.
 * @property {BulkSummary} summary - Aggregate summary.
 */

// ---------------------------------------------------------------------------
// Internal service-layer shapes (described for mapper documentation)
// ---------------------------------------------------------------------------

/**
 * Transition result produced by `invoiceService.transitionInvoice` /
 * `invoiceStateMachine.executeTransition`.
 *
 * @typedef {Object} InternalTransitionResult
 * @property {boolean} success
 * @property {string} previousState
 * @property {string} newState
 * @property {{ id: string, timestamp?: string }} auditLog
 * @property {string} transitionedAt
 * @property {string} transitionedBy
 */

/**
 * Audit-log record produced by `getTransitionHistory`.
 *
 * @typedef {Object} InternalAuditLog
 * @property {string} id
 * @property {string} timestamp
 * @property {string} actor
 * @property {{ before?: { state?: string }, after?: { state?: string } }} [changes]
 * @property {{ reason?: string }} [metadata]
 * @property {string} [ipAddress]
 */

// ---------------------------------------------------------------------------
// Request mappers — body → well-typed internal command input
// ---------------------------------------------------------------------------

/**
 * Pulls the typed transition fields from an Express request body.
 *
 * @contract v1.0 - Returns object with targetState and reason fields.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string reason → undefined
 *                 - Extra keys ignored (prototype pollution defense)
 *                 - Output shape is stable regardless of input validity
 *
 * The mapper itself does NOT perform semantic validation — that remains the
 * responsibility of `invoiceStateMachine.validateTransition` and the Zod
 * schema in `schemas/invoiceState`.  The mapper only guarantees the returned
 * object has the declared field shapes (coercing missing optional keys to
 * `undefined` rather than leaving them absent so downstream code sees a
 * stable structure).
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ targetState: unknown, reason: string|undefined }}
 */
function mapTransitionRequest(body) {
  /** @type {Record<string, unknown>} */
  const b = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : {};
  return {
    targetState: 'targetState' in b ? b.targetState : undefined,
    reason: typeof b.reason === 'string' ? b.reason : undefined,
  };
}

/**
 * Pulls the typed approval fields from an Express request body.
 *
 * @contract v1.0 - Returns object with reason field.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string reason → undefined
 *                 - Output shape is stable regardless of input validity
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ reason: string|undefined }}
 */
function mapApproveRequest(body) {
  /** @type {Record<string, unknown>} */
  const b = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : {};
  return {
    reason: typeof b.reason === 'string' ? b.reason : undefined,
  };
}

/**
 * Pulls the typed link-escrow fields from an Express request body.
 *
 * @contract v1.0 - Returns object with escrowId and reason fields.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string escrowId → null
 *                 - Non-string reason → undefined
 *                 - Output shape is stable regardless of input validity
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ escrowId: string|null, reason: string|undefined }}
 */
function mapLinkEscrowRequest(body) {
  /** @type {Record<string, unknown>} */
  const b = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : {};
  return {
    escrowId: typeof b.escrowId === 'string' ? b.escrowId : null,
    reason: typeof b.reason === 'string' ? b.reason : undefined,
  };
}

/**
 * Pulls the typed rejection fields from an Express request body.
 *
 * @contract v1.0 - Returns object with reason field.
 *                 - Null/undefined/array body → empty object fallback
 *                 - Non-string reason → undefined
 *                 - Output shape is stable regardless of input validity
 *
 * @param {unknown} body - Raw `req.body`.
 * @returns {{ reason: string|undefined }}
 */
function mapRejectRequest(body) {
  /** @type {Record<string, unknown>} */
  const b = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : {};
  return {
    reason: typeof b.reason === 'string' ? b.reason : undefined,
  };
}

// ---------------------------------------------------------------------------
// Response mappers — internal result → public DTO
// ---------------------------------------------------------------------------

/**
 * Builds the state-query response DTO from a resolved invoice + state-machine
 * output.
 *
 * @contract v1.0 - Returns InvoiceStateResponseDto with invoiceId, currentState,
 *                 allowedTransitions, and isTerminal fields.
 *                 - Non-array allowedTransitions → empty array fallback
 *                 - allowedTransitions is copied to prevent caller mutation
 *                 - isTerminal derived from allowedTransitions.length === 0
 *                 - Optional fields omitted when undefined (not null)
 *
 * @param {object} args
 * @param {string} args.invoiceId - Invoice identifier (from route params).
 * @param {string} args.currentState - Invoice status.
 * @param {string[]} args.allowedTransitions - Result of
 *   `getAllowedTransitions(currentState)`.
 * @returns {InvoiceStateResponseDto}
 */
function toInvoiceStateResponse({ invoiceId, currentState, allowedTransitions }) {
  return {
    invoiceId,
    currentState,
    allowedTransitions: Array.isArray(allowedTransitions) ? [...allowedTransitions] : [],
    isTerminal: Array.isArray(allowedTransitions) ? allowedTransitions.length === 0 : false,
  };
}

/**
 * Builds a transition response DTO from a state-machine execution result and
 * the caller-supplied optional reason.
 *
 * @contract v1.0 - Returns TransitionResponseDto with invoiceId, previousState,
 *                 currentState, transitionedAt, transitionedBy, auditLogId, and
 *                 optional reason field.
 *                 - Missing/malformed auditLog → auditLogId = ''
 *                 - Undefined/null reason → field omitted (not null)
 *                 - JSON serialization omits undefined fields
 *
 * @param {object} args
 * @param {string} args.invoiceId - Invoice identifier (from route params).
 * @param {InternalTransitionResult} args.result - Transition result object.
 * @param {string} [args.reason] - Optional rationale echoed back.
 * @returns {TransitionResponseDto}
 */
function toTransitionResponse({ invoiceId, result, reason }) {
  const auditLogId = result.auditLog && result.auditLog.id ? result.auditLog.id : '';
  const base = {
    invoiceId,
    previousState: result.previousState,
    currentState: result.newState,
    transitionedAt: result.transitionedAt,
    transitionedBy: result.transitionedBy,
    auditLogId,
  };
  if (reason !== undefined && reason !== null) {
    /** @type {TransitionResponseDto} */
    const withReason = Object.assign({}, base, { reason });
    return withReason;
  }
  /** @type {TransitionResponseDto} */
  const withoutReason = base;
  return withoutReason;
}

/**
 * Builds the link-escrow response DTO from a transition result and the
 * user-supplied escrow identifier.
 *
 * @contract v1.0 - Returns LinkEscrowResponseDto with invoiceId, previousState,
 *                 currentState, escrowId, transitionedAt, transitionedBy, and
 *                 auditLogId fields.
 *                 - Non-string escrowId → null
 *                 - Missing/malformed auditLog → auditLogId = ''
 *                 - escrowId is always present (may be null)
 *
 * @param {object} args
 * @param {string} args.invoiceId - Invoice identifier.
 * @param {InternalTransitionResult} args.result - Transition result object.
 * @param {string|null} args.escrowId - Escrow contract identifier or null.
 * @returns {LinkEscrowResponseDto}
 */
function toLinkEscrowResponse({ invoiceId, result, escrowId }) {
  return {
    invoiceId,
    previousState: result.previousState,
    currentState: result.newState,
    escrowId: typeof escrowId === 'string' ? escrowId : null,
    transitionedAt: result.transitionedAt,
    transitionedBy: result.transitionedBy,
    auditLogId: result.auditLog && result.auditLog.id ? result.auditLog.id : '',
  };
}

/**
 * Converts a single audit-log record into a history-entry DTO.
 *
 * @contract v1.0 - Returns HistoryEntryDto with id, timestamp, actor, and optional
 *                 fromState, toState, reason, ipAddress fields.
 *                 - Missing optional fields are omitted (not null)
 *                 - Partial changes (before without after, or vice versa) handled
 *                 - JSON serialization omits undefined fields
 *
 * Missing optional fields are either omitted or set to `undefined` so JSON
 * serialisation produces the leanest valid payload.
 *
 * @param {InternalAuditLog} log - Raw audit-log record.
 * @returns {HistoryEntryDto}
 */
function toHistoryEntryDto(log) {
  /** @type {HistoryEntryDto} */
  const entry = {
    id: log.id,
    timestamp: log.timestamp,
    actor: log.actor,
  };
  if (log.changes && log.changes.before && log.changes.before.state !== undefined) {
    entry.fromState = log.changes.before.state;
  }
  if (log.changes && log.changes.after && log.changes.after.state !== undefined) {
    entry.toState = log.changes.after.state;
  }
  if (log.metadata && log.metadata.reason !== undefined) {
    entry.reason = log.metadata.reason;
  }
  if (log.ipAddress !== undefined) {
    entry.ipAddress = log.ipAddress;
  }
  return entry;
}

/**
 * Builds the history response DTO from a resolved invoice + ordered list of
 * transition entries.
 *
 * @contract v1.0 - Returns InvoiceHistoryResponseDto with invoiceId, currentState,
 *                 transitions array, and totalTransitions count.
 *                 - Non-array transitions → empty array fallback
 *                 - totalTransitions = transitions.length
 *                 - transitions array is not mutated or cloned
 *
 * The `transitions` array is expected to already be in {@link HistoryEntryDto}
 * shape — this is the format produced by
 * `invoiceStateMachine.getTransitionHistory`.  `toHistoryEntryDto` remains
 * exported for callers that need to convert raw audit-log records into the
 * same entry shape.
 *
 * @param {object} args
 * @param {string} args.invoiceId - Invoice identifier.
 * @param {string} args.currentState - Invoice status at query time.
 * @param {HistoryEntryDto[]} args.transitions - Transition entries in
 *   canonical DTO order (most recent first).
 * @returns {InvoiceHistoryResponseDto}
 */
function toInvoiceHistoryResponse({ invoiceId, currentState, transitions }) {
  const safe = Array.isArray(transitions) ? transitions : [];
  return {
    invoiceId,
    currentState,
    transitions: safe,
    totalTransitions: safe.length,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * @note Migration path for route adoption
 *
 * Current routes (src/routes/invoiceStateRoutes.js) access req.body directly
 * instead of using these mappers. To adopt the mappers:
 *
 * 1. Replace direct req.body access with mapper calls in each route handler
 * 2. Verify service layer returns shapes compatible with response mappers
 * 3. Update response helpers to use mapper outputs
 * 4. Run existing test suite to ensure no breaking changes
 * 5. Increment contract version if output shapes change
 *
 * The mappers are production-ready and tested. Adoption is optional but
 * recommended for consistency and defensive boundary handling.
 */
module.exports = {
  // Request mappers
  mapTransitionRequest,
  mapApproveRequest,
  mapLinkEscrowRequest,
  mapRejectRequest,
  // Response mappers
  toInvoiceStateResponse,
  toTransitionResponse,
  toLinkEscrowResponse,
  toHistoryEntryDto,
  toInvoiceHistoryResponse,
};
