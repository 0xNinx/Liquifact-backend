'use strict';

const crypto = require('crypto');
const db = require('../db/knex');
const logger = require('../logger');
const { resolveInvoiceByAddress } = require('../config/escrowMap');
const { escrowReadCache } = require('../services/escrowReadCache');
const { indexerCache } = require('../services/indexerCache');
const { isIndexerEnabled } = require('../services/indexerService');
const {
  escrowIndexerEventsProcessedTotal,
  escrowIndexerEventsSkippedTotal,
  escrowIndexerCycleFailuresTotal,
  escrowIndexerLastCursorAdvanceTimestampSeconds,
} = require('../metrics');

const { StrKey } = require('@stellar/stellar-sdk');
const { indexerEventSchema } = require('../schemas/indexerEvent');
const { INVOICE_ID_REGEX } = require('../schemas/validationHelper');

class ValidationError extends Error {
  /**
   * Creates an indexer event validation error.
   * @param {string} message Human-readable failure.
   * @param {string} code Stable error code.
   * @param {object|null} details Validation details.
   */
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

class LeaseLostError extends Error {
  /**
   * Creates an escrow indexer lease fencing error.
   * @param {string} message Human-readable failure.
   * @param {string} code Stable error code.
   * @param {object|null} details Validation details.
   */
  constructor(message, code = 'LEASE_LOST', details = null) {
    super(message);
    this.name = 'LeaseLostError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 100;

// Fencing token lease; expiry is compared with the database clock.
const LEASE_KEY = 'worker_lease';
const DEFAULT_LEASE_DURATION_MS = 30_000;

/**
 * Validates a Stellar contract ID using StrKey encoding rules (starts with 'C', correct length, and valid checksum).
 *
 * @param {string} contractId - The contract ID to validate.
 * @returns {boolean} True if the contract ID is valid.
 */
function isValidStellarContractId(contractId) {
  if (typeof contractId !== 'string') {
    return false;
  }
  const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
  if (!CONTRACT_ID_RE.test(contractId)) {
    return false;
  }
  try {
    return StrKey.isValidContract(contractId);
  } catch (_err) {
    return false;
  }
}

/**
 * Validates a transaction hash (exactly 64 hexadecimal characters, case-insensitive, no prefixes).
 *
 * @param {string} txHash - The transaction hash to validate.
 * @returns {boolean} True if the transaction hash is valid.
 */
function isValidTxHash(txHash) {
  if (typeof txHash !== 'string') {
    return false;
  }
  const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
  return TX_HASH_RE.test(txHash);
}

/**
 * Attempts to derive a usable invoice ID from a Horizon/Soroban contract event
 * record, in priority order:
 *
 *   1. An explicit `invoice_id` / `invoiceId` field on the record.
 *   2. The LiquifactEscrow event payload — the `value` body or a `topic`/
 *      `topics` entry explicitly labelled with an invoice field. Bare topic
 *      symbols (e.g. the event-name symbol) are not treated as invoice IDs.
 *   3. Reverse lookup of the emitting contract address through escrowMap.
 *
 * The derived value is validated against INVOICE_ID_REGEX; anything that does
 * not match (including the bare contract address) yields null so the caller can
 * skip the event rather than mis-key the projection by contract address.
 *
 * @param {object} record - Raw Horizon contract event record.
 * @param {(address: string) => (string|null)} [reverseLookup] - Address->invoiceId resolver.
 * @returns {string|null} A valid invoice ID, or null if none can be resolved.
 */
function deriveInvoiceId(record, reverseLookup = resolveInvoiceByAddress) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const isValid = (candidate) => {
    if (candidate === null || candidate === undefined) {
      return null;
    }
    const value = String(candidate).trim();
    return INVOICE_ID_REGEX.test(value) ? value : null;
  };

  // 1. Explicit field on the record.
  const explicit = isValid(record.invoice_id) || isValid(record.invoiceId);
  if (explicit) {
    return explicit;
  }

  // 2. LiquifactEscrow event payload: value body and topics.
  const body = record.value;
  if (body && typeof body === 'object') {
    const fromBody = isValid(body.invoice_id) || isValid(body.invoiceId);
    if (fromBody) {
      return fromBody;
    }
  }

  const topics = Array.isArray(record.topics)
    ? record.topics
    : Array.isArray(record.topic)
      ? record.topic
      : [];
  for (const topic of topics) {
    if (topic && typeof topic === 'object') {
      // Only trust explicitly-labelled invoice fields in a topic entry. The
      // first topic in a LiquifactEscrow event is the event-name symbol, so
      // we must not treat arbitrary symbol/string values as an invoice id.
      const fromTopic = isValid(topic.invoice_id) || isValid(topic.invoiceId);
      if (fromTopic) {
        return fromTopic;
      }
    }
  }

  // 3. Reverse lookup by contract address.
  if (record.contract_id && typeof reverseLookup === 'function') {
    const resolved = reverseLookup(String(record.contract_id));
    if (resolved === String(record.contract_id) || isValidStellarContractId(resolved)) {
      return null;
    }
    const fromMap = isValid(resolved);
    if (fromMap) {
      return fromMap;
    }
  }

  return null;
}

/**
 * Validates and normalizes a raw escrow event into the canonical shape used by
 * the indexer's persistence and projection logic.
 *
 * Rejects unknown fields, wrong types, and out-of-range values with a
 * structured {@link ValidationError} that carries a machine-readable error
 * code and field-level details.
 *
 * @param {object} rawEvent - Raw event payload to validate and normalize.
 * @returns {object} The normalized event with validated required fields and
 *   defaults applied for optional fields.
 * @throws {ValidationError} If the payload is not an object, contains unknown
 *   fields, has wrong types, or field values are out of bounds.
 */
function normalizeEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    throw new ValidationError('Event payload must be an object.', 'INVALID_PAYLOAD');
  }

  const result = indexerEventSchema.safeParse(rawEvent);

  if (!result.success) {
    const { parseValidationErrors } = require('../schemas/indexerEvent');
    const fieldErrors = parseValidationErrors(result.error);
    throw new ValidationError(
      'Event payload contains invalid or out-of-range fields.',
      'VALIDATION_ERROR',
      fieldErrors,
    );
  }

  const data = result.data;
  return {
    eventId: data.eventId,
    invoiceId: data.invoiceId,
    eventType: data.eventType,
    ledgerSequence: data.ledgerSequence,
    pagingToken: data.pagingToken || '',
    contractId: data.contractId !== undefined ? data.contractId : null,
    txHash: data.txHash !== undefined ? data.txHash : null,
    eventBody: data.eventBody !== undefined ? data.eventBody : {},
    observedAt: data.observedAt || new Date().toISOString(),
  };
}

/* istanbul ignore next -- DB-backed store is exercised in integration tests; unit tests inject in-memory store via DI. */
/**
 * Builds a Knex-backed escrow event store providing cursor, event, and
 * projection persistence operations.
 *
 * @param {import('knex').Knex} knex - Configured Knex instance.
 * @returns {object} Store with loadCursor, saveCursor, findProjection,
 *   upsertEvent, and upsertProjection methods.
 */
function createKnexEscrowEventStore(knex) {
  async function assertLease(trx, token) {
    const row = await (trx || knex)('escrow_indexer_state')
      .where({ key: LEASE_KEY })
      .whereRaw("value::jsonb ->> 'token' = ?", [token])
      .whereRaw("(value::jsonb ->> 'expiresAt')::bigint > EXTRACT(EPOCH FROM NOW()) * 1000")
      .first();
    if (!row) {
      throw new LeaseLostError('Escrow indexer lease is missing, stale, or expired.', 'LEASE_LOST');
    }
    return typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  }

  return {
    async acquireLease({ leaseDurationMs = DEFAULT_LEASE_DURATION_MS } = {}) {
      const token = crypto.randomUUID();
      const result = await knex.raw(
        `INSERT INTO escrow_indexer_state (key, value, updated_at)
         VALUES (?, jsonb_build_object('token', ?, 'expiresAt', EXTRACT(EPOCH FROM NOW()) * 1000 + ?)::text, NOW())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = NOW()
           WHERE escrow_indexer_state.value IS NULL
              OR COALESCE((escrow_indexer_state.value::jsonb ->> 'expiresAt')::bigint, 0) <= EXTRACT(EPOCH FROM NOW()) * 1000
         RETURNING value`,
        [LEASE_KEY, token, leaseDurationMs],
      );
      if (!result.rows || result.rows.length === 0) {
        return null;
      }
      return typeof result.rows[0].value === 'string'
        ? JSON.parse(result.rows[0].value)
        : result.rows[0].value;
    },

    async renewLease(token, leaseDurationMs = DEFAULT_LEASE_DURATION_MS) {
      const result = await knex.raw(
        `UPDATD escrow_indexer_state
         SET value = jsonb_build_object(
               'token', value::jsonb ->> 'token',
               'expiresAt', EXTRACT(EPOCH FROM NOW()) * 1000 + ?
             )::text,
             updated_at = NOW()
         WHERE key = ?
           AND value::jsonb ->> 'token' = ?
           AND COALESCE((value::jsonb ->> 'expiresAt')::bigint, 0) > EXTRACT(EPOCH FROM NOW()) * 1000
         RETURNING value`,
        [leaseDurationMs, LEASE_KEY, token],
      );
      if (!result.rows || result.rows.length === 0) {
        return null;
      }
      return typeof result.rows[0].value === 'string'
        ? JSON.parse(result.rows[0].value)
        : result.rows[0].value;
    },

    async completeLease(token) {
      const deleted = await knex('escrow_indexer_state')
        .where({ key: LEASE_KEY })
        .whereRaw("value::jsonb ->> 'token' = ?", [token])
        .del();
      return deleted > 0;
    },

    assertLease,

    async loadCursor() {
      const row = await knex('escrow_indexer_state')
        .where({ key: 'horizon_cursor' })
        .first();
      return row ? row.value : null;
    },

    async saveCursor(cursor, fenceToken) {
      if (fenceToken) {
        await assertLease(null, fenceToken);
      }
      await knex('escrow_indexer_state')
        .insert({ key: 'horizon_cursor', value: cursor, updated_at: knex.fn.now() })
        .onConflict('key')
        .merge({ value: cursor, updated_at: knex.fn.now() });
    },

    async findProjection(invoiceId) {
      return knex('escrow_event_projection').where({ invoice_id: invoiceId }).first();
    },

    async upsertEvent(trx, event) {
      await trx('escrow_events')
        .insert({
          event_id: event.eventId,
          invoice_id: event.invoiceId,
          event_type: event.eventType,
          ledger_sequence: event.ledgerSequence,
          paging_token: event.pagingToken || null,
          contract_id: event.contractId,
          tx_hash: event.txHash,
          event_body: JSON.stringify(event.eventBody || {}),
          observed_at: event.observedAt,
        })
        .onConflict('event_id')
        .ignore();
    },

    async upsertProjection(trx, event) {
      await trx('escrow_event_projection')
        .insert({
          invoice_id: event.invoiceId,
          latest_event_id: event.eventId,
          latest_event_type: event.eventType,
          latest_ledger_sequence: event.ledgerSequence,
          latest_paging_token: event.pagingToken || null,
          latest_event_body: JSON.stringify(event.eventBody || {}),
          latest_observed_at: event.observedAt,
          updated_at: trx.fn.now(),
        })
        .onConflict('invoice_id')
        .merge({
          latest_event_id: event.eventId,
          latest_event_type: event.eventType,
          latest_ledger_sequence: event.ledgerSequence,
          latest_paging_token: event.pagingToken || null,
          latest_event_body: JSON.stringify(event.eventBody || {}),
          latest_observed_at: event.observedAt,
          updated_at: trx.fn.now(),
        });
    },
  };
}

module.exports = {
  ValidationError,
  LeaseLostError,
  isValidStellarContractId,
  isValidTxHash,
  deriveInvoiceId,
  normalizeEvent,
  createKnexEscrowEventStore,
};
