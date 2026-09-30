'use strict';

/**
 * @file src/db/__mocks__/knex.js
 * @description Manual Jest mock for `src/db/knex`.
 *
 * Mirrors the public interface of the hardened production module so tests
 * that use `jest.mock('../../src/db/knex')` exercise the same lifecycle
 * invariants that production code depends on:
 *
 *   - db(table)         — fluent query builder; thenable; resolves to []
 *   - db.raw()          — resolves to undefined
 *   - db.transaction()  — passes a transaction-scoped mock (same shape) to callback
 *   - db.destroy()      — idempotent teardown; sets state → DESTROYED
 *   - db._getState()    — returns current DB_STATE string
 *   - db._DB_STATE      — frozen enum mirror of the production DB_STATE
 *   - db._resetState()  — test-only helper; resets state back to READY
 *
 * Destroyed-state guard
 * ---------------------
 * Once `db.destroy()` has been called (state: DESTROYED), calling `db()`,
 * `db.raw()`, or `db.transaction()` throws a `DatabaseLifecycleError` with
 * `code = 'DB_ALREADY_DESTROYED'`.  This prevents tests from accidentally
 * exercising code that calls the DB after shutdown without noticing.
 *
 * Transaction isolation
 * ---------------------
 * `db.transaction(callback)` passes a *separate* mock instance (trx) to the
 * callback so tests can inspect which queries were issued inside a transaction
 * independently from those issued on the outer `db` mock.
 *
 * @module src/db/__mocks__/knex
 */

// ---------------------------------------------------------------------------
// Lifecycle state enum (mirrors production)
// ---------------------------------------------------------------------------

/**
 * @enum {string}
 */
const DB_STATE = Object.freeze({
  READY: 'READY',
  DESTROYING: 'DESTROYING',
  DESTROYED: 'DESTROYED',
});

// ---------------------------------------------------------------------------
// Error type (mirrors production)
// ---------------------------------------------------------------------------

/**
 * Thrown when a query is attempted against a destroyed mock instance.
 */
class DatabaseLifecycleError extends Error {
  /**
   * @param {string} message
   * @param {string} [state]
   */
  constructor(message, state) {
    super(message);
    this.name = 'DatabaseLifecycleError';
    this.code = 'DB_ALREADY_DESTROYED';
    this.dbState = state || DB_STATE.DESTROYED;
  }
}

// ---------------------------------------------------------------------------
// Mock query builder (shared fluent chain)
// ---------------------------------------------------------------------------

/**
 * Build a fluent mock query builder.  Every method returns `this` (chainable)
 * and the chain is also thenable so `await db('table')…` resolves to `[]`.
 *
 * @returns {object} A Jest mock query chain.
 */
function buildMockQuery() {
  const q = {
    where:      jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull:  jest.fn().mockReturnThis(),
    whereIn:    jest.fn().mockReturnThis(),
    whereRaw:   jest.fn().mockReturnThis(),
    andWhere:   jest.fn().mockReturnThis(),
    orWhere:    jest.fn().mockReturnThis(),
    leftJoin:   jest.fn().mockReturnThis(),
    orderBy:    jest.fn().mockReturnThis(),
    select:     jest.fn().mockReturnThis(),
    clone:      jest.fn().mockReturnThis(),
    clearSelect: jest.fn().mockReturnThis(),
    clearOrder:  jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),

    // Termination methods
    limit:     jest.fn().mockReturnThis(),
    offset:    jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),

    del:    jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([{ id: 'mock-id', created_at: new Date() }]),
    update: jest.fn().mockResolvedValue(1),
    delete: jest.fn().mockResolvedValue(1),
    merge:  jest.fn().mockResolvedValue(1),
    first:  jest.fn().mockResolvedValue(null),
    count:  jest.fn().mockResolvedValue([{ count: 0 }]),

    // Make the chain thenable so `await db('table').where(…)` resolves to [].
    then: jest.fn((resolve) => resolve([])),
  };
  return q;
}

// ---------------------------------------------------------------------------
// Transaction-scoped mock (isolated instance)
// ---------------------------------------------------------------------------

/**
 * Build a transaction-scoped mock that has the same shape as the outer db
 * mock but records its own calls separately.  Tests that care about
 * transaction isolation can inspect `trx.insert.mock.calls` independently.
 *
 * @returns {object} Transaction mock, callable with the same fluent chain.
 */
function buildTransactionMock() {
  const trxQuery = buildMockQuery();

  const trx = jest.fn(() => trxQuery);
  trx.raw         = jest.fn().mockResolvedValue(undefined);
  trx.destroy     = jest.fn().mockResolvedValue(undefined);
  trx._isTrxMock  = true;

  // Copy query methods onto trx so callers can do trx.insert(…) directly.
  Object.assign(trx, trxQuery);

  return trx;
}

// ---------------------------------------------------------------------------
// Primary db mock
// ---------------------------------------------------------------------------

/** Mutable lifecycle state. */
let _state = DB_STATE.READY;

/**
 * Guard that throws a DatabaseLifecycleError when the mock is not READY.
 *
 * @param {string} operation
 */
function assertReady(operation) {
  if (_state !== DB_STATE.READY) {
    throw new DatabaseLifecycleError(
      `[db-mock] Cannot execute "${operation}": database connection pool is ` +
      (_state === DB_STATE.DESTROYING
        ? 'being shut down (state: DESTROYING).'
        : 'already destroyed (state: DESTROYED).'),
      _state
    );
  }
}

// The mock chain for bare db() calls.
const _mockQuery = buildMockQuery();

/**
 * The callable mock db function.  Calling `db('tableName')` returns the
 * shared fluent mock query chain.
 *
 * @param {string} tableName
 * @returns {object} Fluent query chain mock.
 */
const db = jest.fn((tableName) => {
  assertReady(`db("${tableName}")`);
  return _mockQuery;
});

// --- db.raw ---
db.raw = jest.fn((..._args) => {
  assertReady('db.raw');
  return Promise.resolve(undefined);
});

// --- db.transaction ---
// NOTE: assertReady() must execute synchronously so callers that use
// `expect(() => db.transaction(...)).toThrow()` can catch the guard error.
// The function is therefore NOT declared async at the outer level; the async
// work is only done after the guard passes.
db.transaction = jest.fn((callback) => {
  assertReady('db.transaction');
  const trx = buildTransactionMock();
  return Promise.resolve().then(() => callback(trx));
});

// --- db.destroy (idempotent) ---
db.destroy = jest.fn(async () => {
  if (_state === DB_STATE.DESTROYED || _state === DB_STATE.DESTROYING) {
    return; // idempotent
  }
  _state = DB_STATE.DESTROYING;
  _state = DB_STATE.DESTROYED;
});

// --- Observability helpers (mirror production API) ---
db._getState  = () => _state;
db._DB_STATE  = DB_STATE;

/**
 * Test-only helper — reset the mock state back to READY and clear all call
 * records.  Call this in `afterEach` when a test exercises `db.destroy()`.
 */
db._resetState = () => {
  _state = DB_STATE.READY;
  db.mockClear();
  db.raw.mockClear();
  db.transaction.mockClear();
  db.destroy.mockClear();
  _mockQuery.where.mockClear();
  _mockQuery.select.mockClear();
  _mockQuery.insert.mockClear();
  _mockQuery.update.mockClear();
  _mockQuery.del.mockClear();
  _mockQuery.delete.mockClear();
  _mockQuery.first.mockClear();
  _mockQuery.returning.mockClear();
  _mockQuery.then.mockClear();
};

// Re-export the same error and state enum so tests can import them from the
// mock path without needing to know the production file path.
db.DatabaseLifecycleError = DatabaseLifecycleError;
db.DB_STATE = DB_STATE;

module.exports = db;
module.exports.DatabaseLifecycleError = DatabaseLifecycleError;
module.exports.DB_STATE = DB_STATE;
