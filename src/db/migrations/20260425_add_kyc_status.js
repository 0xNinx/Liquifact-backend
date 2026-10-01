/**
 * Database Migration: Create kyc_records table
 *
 * Persists KYC verification results so status survives restarts.
 * One row per SME; upserted on each provider response.
 *
 * Validation boundaries (enforced at the DB layer so that any
 * code path writing to this table is bound by the same invariants):
 *
 *   - sme_id: primary key, non-null, 1..128 chars. The primary key
 *     guarantees deduplication -- a duplicate insert must
 *     be expressed as an upsert (conflict on sme_id), never as a second
 *     row.
 *   - status: non-null, defaults to 'pending', constrained to the
 *     known state machine: pending -> verified | rejected | expired.
 *     Any other value is rejected by the database, not just by the
 *     application, so a bug or a compromised caller cannot persist an
 *     unknown state.
 *   - provider_record_id: nullable, 1..256 chars when present. Null
 *     means "no provider response yet" and is distinct from an empty
 *     string, which is rejected.
 *   - verified_at: nullable; must be null unless status is 'verified'.
 *     Enforced by a CHECK constraint so the invariant holds even under
 *     concurrent upserts from multiple workers.
 *   - deleted_at: soft-delete marker. Non-null means the record is
 *     tombstoned and must not be treated as active by readers.
 *
 * All constraints are declared in the createTable call below so the
 * migration is deterministic and reviewable in a single place.
 */

/**
 * Allowed status values. Exported so the application layer can
 * reference the same list and tests can assert against it without
 * duplicating the literals.
 */
const KYC_STATUS_VALUES = Object.freeze(['pending', 'verified', 'rejected', 'expired']);

/**
 * Maximum lengths for character columns. These are the boundaries
 * enforced by the database and must match the column declarations.
 */
const SME_ID_MAX_LENGTH = 128;
const STATUS_MAX_LENGTH = 32;
const PROVIDER_RECORD_ID_MAX_LENGTH = 256;

exports.KYC_STATUS_VALUES = KYC_STATUS_VALUES;
exports.SME_ID_MAX_LENGTH = SME_ID_MAX_LENGTH;
exports.STATUS_MAX_LENGTH = STATUS_MAX_LENGTH;
exports.PROVIDER_RECORD_ID_MAX_LENGTH = PROVIDER_RECORD_ID_MAX_LENGTH;

exports.up = async (knex) => {
  await db.schema.createTable('kyc_records', (table) => {
    // Primary key guarantees one row per SME. Duplicate submissions
    // must be handled as upserts (conflict on sme_id), not as a
    // second insert.
    table.string('sme_id', SME_ID_MAX_LENGTH).notNullable().primary();

    // Status is constrained to the known state machine. The default
    // is 'pending' so a row can be created before the provider
    // responds.
    table.string('status', STATUS_MAX_LENGTH)
      .notNullable()
      .defaultTo('pending');

    // Provider record id is optional. Null means "no provider response
    // yet". An empty string is not a valid replacement and is rejected
    // by the CHECK constraint below.
    table.string('provider_record_id', PROVIDER_RECORD_ID_MAX_LENGTH).nullable();

    // verified_at is only meaningful for 'verified' records.
    table.timestamp('verified_at').nullable();

    // updated_at is always set by the database on insert.
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    // Soft delete marker. Non-null means the record is tombstoned.
    table.timestamp('deleted_at').nullable();

    // State machine enforcement at the DB layer. This is the last line
    // of defense: even if a caller bypasses application validation,
    // the database will reject an unknown status or an inconsistent
    // verified_at/verified pairing.
    table.check(
      'chk_kyc_records_status_allowed',
      ['status'],
      'in',
      KYC_STATUS_VALUES
    );

    table.check(
      'chk_kyc_records_verified_at_consistent',
      knex.raw(
        `(status = 'pending' AND verified_at IS NULL) OR (status = 'verified') OR (status = 'rejected' AND verified_at IS NULL) OR (status = 'expired' AND verified_at IS NULL)`
      )
    );

    // Empty strings are not valid values for optional identifiers.
    table.check(
      'chk_kyc_records_provider_record_id_non_empty',
      knex.raw(
        `provider_record_id IS NULL OR (provider_record_id <> '')`
      )
    );

    table.index('status');
    table.index('deleted_at');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('kyc_records');
};
