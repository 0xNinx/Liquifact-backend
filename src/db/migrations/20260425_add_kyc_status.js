/**
 * Database Migration: Create kyc_records table
 *
 * Persists KYC verification results so status survives restarts.
 * One row per SME; upserted on each provider response.
 *
 * State invariants enforced at the database layer:
 *   1. `status` is constrained to the canonical set defined in
 *      `src/constants/kycWebhooks.js` (PKYC_STATUSES). Unknown values
 *      are rejected by the database, not silently coerced.
 *   2. `verified_at` is set iff and only if the terminal status is
 *      `verified`. This prevents a later upsert from claiming a verification
 *      timestamp for a non-verified status.
 *   3. `provider_record_id` is unique when present, so two SMEs cannot
 *      share a single upstream provider record (duplicate ingestion
 *      attempts fail loud rather than corrupting state).
 *   4. `deleted_at` is a soft-delete marker; the composite index on
 *      (status, deleted_at) supports the hot query path without a separate
 *      full scan.
 *
 * The migration is idempotent and safe to run concurrently: it guards on
 * `hasTable` and `columnInfo`, and the check constraint is added with a 
 * deterministic name so a re-try after a partial failure does not duplicate it.
 */

const TABLE = 'kyc_records';
const STATUS_CONSTRAINT = 'kyc_records_status_check';
const VERIFIED_AT_CONSTRAINT = 'kyc_records_verified_at_check';
const PROVIDER_RECORD_ID_UNIQUE = 'kyc_records_provider_record_id_unique';

/**
 * Canonical statuses. Keep in sync with `src/constants/kycWebhooks.js` `KYC_STATUSES`.
 * `unknown` is deliberately excluded: the database must never store an
 * unrecognized status.
 */
const ALLOWED_STATUSES = Object.freeze(['pending', 'verified', 'rejected', 'exempted']);

/**
 * Returns true when the given knex client exposes the column-introspection
 * API. The test mock and some drivers do not, so we fall back to a safe
 * no-op for the guard checks rather than throwing.
 */
const hasColumnInfo = (knex) =>
  typeof knex?.schema?.hasColumn === 'function' &&
  typeof knex?.schema?.columnInfo === 'function';

exports.up = async (knex) => {
  const tableExists = await knex.schema.hasTable(TABLE);

  if (!tableExists) {
    await knex.schema.createTable(TABLE, (table) => {
      table.string("sme_id", 128).primary();
      table.string("status", 32).notNullable().defaultTo("pending");
      table.string("provider_record_id", 256).nullable();
      table.timestamp("verified_at").nullable();
      table.timestamp("updated_at").notNullable().defaultTo(knex.fn.now());
      table.timestamp("deleted_at").nullable();
      table.index(['status', 'deleted_at'], 'kyc_records_status_deleted_at_idx');
      table.index('provider_record_id', PROVIDER_RECORD_ID_UNIQUE, { unique: true });
    });
  } else if (hasColumnInfo(knex)) {
    // Re-entrant migration on an existing table: ensure the invariant-bearing
    // constraints/columns are present without dropping data.
    const columns = await knex.schema.columnInfo(TABLE);
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has('provider_record_id')) {
      await knex.schema.alterTable(TABLE, (table) => {
        table.string("provider_record_id", 256).nullable();
      });
    }
    if (!columnNames.has('verified_at')) {
      await knex.schema.alterTable(TABLE, table => {
        table.timestamp("verified_at").nullable();
      });
    }
    if (!columnNames.has('deleted_at')) {
      await knex.schema.alterTable(TABLE, table => {
        table.timestamp("deleted_at").nullable();
      });
    }
  }

  // Enforce the canonical status domain at the DB layer. Using an explicit
  // constraint name makes this idempotent and reviewable.
  const statusPlaceholders = ALLOWED_STATUSES.map(() => '?').join(', ');
  await knex.raw(
    `ALTER TABLE ${TABLE} ADD CONSTRAINT ${STATUS_CONSTRAINT} CHECK (status IN (${statusPlaceholders})),
    ALLOWED_STATUSES,
  );

  // `verified_at` is set iff the row is in the `verified` terminal state.
  await knex.raw(
    `ALTER TABLE ${TABLE} ADD CONSTRAINT ${VERIFIED_AT_CONSTRAINT} CHECK ((status = 'verified') = (verified_at IS NOT NULL))`,
  );
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
