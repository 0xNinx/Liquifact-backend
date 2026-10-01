'use strict';

const { z } = require('zod');
const {
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
} = require('./validationHelper');

// NOTE: `parseValidationErrors` is re-exported below for backward compatibility.
// It is imported here so the re-export stays in sync with the helper module.

/**
 * Compatibility contract for indexer events.
 *
 * This schema is the public boundary between the indexer jobs and the
 * persistence layer. The following invariants are part of the contract:
 *
 *  1. Valid events are normalized deterministically: string fields are
 *     trimmed, optional nullable fields remain `null` when explicitly set,
 *     and missing optional fields are omitted from the output.
 *  2. Unknown keys are rejected (`.strict()`) so downstream consumers
 *     can rely on the exact shape of the object.
 *  3. Errors are reported through the shared `parseValidationErrors` helper
 *     so callers get a stable, machine-readable error shape.
 *  4. The exported regex constants are re-exported unchanged for backward
 *     compatibility with existing callers.
 */

const contractIdSchema = z.string({
  invalid_type_error: 'contractId must be a string',
}).regex(CONTRACT_ID_REGEX, {
  message: 'contractId must be a valid Stellar contract address (C... 56 chars)',
});

/**
 * Normalizes an optional nullable string field.
 *
 * Behavior:
 *  - `undefined` -> field is omitted (not present in output)
 *  - `null`      -> field is preserved as `null`
 *  - `string`    -> field is trimmed and validated
 *
 * This keeps the compatibility contract explicit and deterministic for
 * consumers that distinguish between "absent" and "explicitly null".
 */
function optionalNullableString(schema) {
  return z.union([z.undefined(), z.null(), schema]).optional();
}

const indexerEventSchema = z
  .object({
    eventId: z
      .string({ invalid_type_error: 'eventId must be a string' })
      .min(1, { message: 'eventId is required' })
      .max(256, { message: 'eventId must not exceed 256 characters' })
      .transform((v) => v.trim()),

    invoiceId: z
      .string({ invalid_type_error: 'invoiceId must be a string' })
      .regex(INVOICE_ID_REGEX, {
        message: 'invoiceId must be 1-128 alphanumeric/underscore/hyphen characters',
      })
      .transform((v) => v.trim()),

    eventType: z
      .string({ invalid_type_error: 'eventType must be a string' })
      .min(1, { message: 'eventType is required' })
      .max(128, { message: 'eventType must not exceed 128 characters' })
      .transform((v) => v.trim()),

    ledgerSequence: z
      .number({ invalid_type_error: 'ledgerSequence must be a number' })
      .int({ message: 'ledgerSequence must be an integer' })
      .positive({ message: 'ledgerSequence must be a positive integer' })
      .max(Number.MAX_SAFE_INTEGER, { message: 'ledgerSequence is out of range' }),

    pagingToken: z
      .string({ invalid_type_error: 'pagingToken must be a string' })
      .max(2048, { message: 'pagingToken must not exceed 2048 characters' })
      .default(''),

    contractId: optionalNullableString(contractIdSchema),

    txHash: optionalNullableString(
      z.string().regex(TX_HASH_REGEX, {
        message: 'txHash must be a 64-character hexadecimal string',
      }),
    ),

    eventBody: z.unknown().optional(),

    observedAt: z
      .string({ invalid_type_error: 'observedAt must be a string' })
      .datetime({ message: 'observedAt must be a valid ISO 8601 date string' })
      .optional(),
  })
  .strict();

/**
 * Parse an indexer event and return a normalized result or throw a
 * validation error with the shared error shape.
 *
 * This is the canonical entry point for callers that want deterministic
 * error handling. It is intentionally wrapped so the compatibility
 * contract is explicit and testable.
 */
function parseIndexerEvent(input) {
  const result = indexerEventSchema.safeParse(input);
  if (!result.success) {
    throw parseValidationErrors(result.error);
  }
  return result.data;
}

module.exports = {
  indexerEventSchema,
  parseIndexerEvent,
  parseValidationErrors,
  INVOICE_ID_REGEX,
  CONTRACT_ID_REGEX,
  TX_HASH_REGEX,
};
