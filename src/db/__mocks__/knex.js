'use strict';

/**
 * @file src/db/__mocks__/knex.js
 * @description Manual Jest mock for the Knex singleton (src/db/knex.js).
 *
 * Mirrors the public API of the real module:
 *   - `db(tableName)`   — fluent query builder stub (thenable → [])
 *   - `db.raw()`        — stub that resolves immediately
 *   - `db.transaction()`— stub that invokes the callback with the mock db
 *   - `db.destroyOnce()`— idempotent teardown stub; tracks call count and
 *                         resolves without side-effects
 *   - `db.getHealthInfo()` — returns a healthy snapshot by default; can be
 *                            overridden per-test via `db._setHealthResponse()`
 *
 * The mock is automatically resolved when `jest.mock('../../src/db/knex')` is
 * called.  It never loads the real knex package or opens any database connection.
 */

// ---------------------------------------------------------------------------
// Query builder stub
// ---------------------------------------------------------------------------

// mockQuery is both a fluent builder (every method returns this) AND
// thenable (awaiting the chain resolves to []), matching real Knex behaviour.
const mockQuery = {
  where: jest.fn().mockReturnThis(),
  whereNotIn: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  whereRaw: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  returning: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  del: jest.fn().mockResolved(1),
  insert: jest.fn().mockResolved([{ id: 'mock-id', created_at: new Date() }]),
  update: jest.fn().mockResolved(1),
  delete: jest.fn().mockResolved(1),
  first: jest.fn().mockResolved(null),
  andWhere: jest.fn().mockReturnThis(),
  orWhere: jest.fn().mockReturnThis(),
  // Make mockQuery thenable so `await query` resolves to []
  then: jest.fn((resolve) => resolve([])),
};

// ---------------------------------------------------------------------------
// Destroy-state tracking
// ---------------------------------------------------------------------------

/**
 * Number of times `destroyOnce()` has been called on the mock instance.
 * Tests can assert against this to verify idempotent teardown.
 * @type {number}
 * @private
 */
let _destroyCallCount = 0;

/**
 * Cached promise for the first `destroyOnce()` invocation.  Subsequent calls
 * return this same promise, matching the real module's coalescing behaviour.
 * @type {Promise<void> | null}
 * @private
 */
let _destroyPromise = null;

// ---------------------------------------------------------------------------
// Health-check state
// ---------------------------------------------------------------------------

/**
 * Default health response returned by `getHealthInfo()`.
 * Override with `db._setHealthResponse(response)` inside a specific test.
 * @type {object}
 * @private
 */
let _healthResponse = {
  status: 'healthy',
  latencyMs: 1,
  lastHealthyAt: new Date().toISOString(),
  error: null,
};

// ---------------------------------------------------------------------------
// Mock db function
// ---------------------------------------------------------------------------

const db = jest.fn(() => mockQuery);

// ---------------------------------------------------------------------------
// Core Knex stubs
// ---------------------------------------------------------------------------

db.raw = jest.fn().mockResolvedValue({ rows: [] });

db.transaction = jest.fn(async (callback) => {
  // The callback receives the same mock db instance as trx
  return callback(db);
});

// ---------------------------------------------------------------------------
// Idempotent destroy — mirrors destroyOnce() on the real module
// ---------------------------------------------------------------------------

/**
 * Idempotent teardown stub.  The first call increments `_destroyCallCount` and
 * returns a resolved Promise.  Subsequent concurrent or repeated calls return
 * the same cached Promise without incrementing the counter again.
 *
 * @returns {Promise<void>}
 */
db.destroyOnce = jest.fn(() => {
  if (_destroyPromise !== null) {
    return _destroyPromise;
  }
  _destroyCallCount += 1;
  _destroyPromise = Promise.resolve();
  return _destroyPromise;
});

/**
 * Legacy `destroy()` stub — delegates to `destroyOnce()` so tests that call
 * the old API still exercise the idempotency logic.
 *
 * @returns {Promise<void>}
 */
db.destroy = jest.fn(() => db.destroyOnce());

// ---------------------------------------------------------------------------
// Health-check helper — mirrors getHealthInfo() on the real module
// ---------------------------------------------------------------------------

/**
 * Returns the configured health response snapshot.
 *
 * @returns {Promise<object>}
 */
db.getHealthInfo = jest.fn(async () => ({ ..._healthResponse }));

// ---------------------------------------------------------------------------
// Test-only introspection helpers (non-enumerable, prefixed with `_`)
// ---------------------------------------------------------------------------

/**
 * Returns the number of times `destroyOnce()` has been invoked.
 * Useful for asserting idempotency in tests.
 *
 * @returns {number}
 */
db._getDestroyCallCount = () => _destroyCallCount;

/**
 * Returns `true` if `destroyOnce()` has been called at least once.
 *
 * @returns {boolean}
 */
db._isDestroyed = () => _destroyCallCount > 0;

/**
 * Override the response returned by `getHealthInfo()` for a specific test.
 *
 * @param {object} response - Partial or full health response override.
 * @returns {void}
 */
db._setHealthResponse = (response) => {
  _healthResponse = { ..._healthResponse, ...response };
};

/**
 * Reset all mock state between tests.  Call this in `beforeEach` / `afterEach`
 * when multiple tests exercise destroy or health behaviour.
 *
 * @returns {void}
 */
db._reset = () => {
  _destroyCallCount = 0;
  _destroyPromise = null;
  _healthResponse = {
    status: 'healthy',
    latencyMs: 1,
    lastHealthyAt: new Date().toISOString(),
    error: null,
  };
  db.destroyOnce.mockClear();
  db.destroy.mockClear();
  db.getHealthInfo.mockClear();
  db.raw.mockClear();
  db.transaction.mockClear();
  db.mockClear();
};

module.exports = db;
