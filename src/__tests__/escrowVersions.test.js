'use strict';

/**
 * Tests for issue #134: LiquifactEscrow wasm version registry and contract list refresh.
 *
 * Covers:
 *  - escrowVersions.js: REGISTRY, isValidContractId, compareVersions, getOnChainSchemaVersion
 *  - contractListRefresh.js: runContractListRefresh
 *  - adminEscrow routes: POST /refresh, GET /version (auth + logic)
 *  - escrowMap.js: compatibility contracts (getEscrowMap, resolveEscrow, invariants)
 */

jest.mock('../services/soroban');
jest.mock('../middleware/apiKeyAuth', () => ({
  authenticateApiKey: jest.fn(() => (req, res, next) => next()),
  API_KEY_HEADER: 'x-api-key',
  timingSafeStringEqual: (a, b) => a === b,
}));

const { callSorobanContract } = require('../services/soroban');

const {
  REGISTRY,
  isValidContractId,
  compareVersions,
  getOnChainSchemaVersion,
  assertRegistryInvariants,
  freezeRegistry,
} = require('../config/escrowVersions');

const {
  getEscrowMap,
  resolveEscrow,
  ESCROW_MAP,
  ESCROW_MAP_INVARIANTS,
} = require('../config/escrowMap');

const { runContractListRefresh } = require('../jobs/contractListRefresh');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../index');

const SECRET = process.env.JWT_SECRET || 'test-secret';

/**
 * Creates an admin JWT token with tenant context for route-level tests.
 * The extractTenant middleware requires a tenantId claim or x-tenant-id header.
 *
 * @param {object} [overrides] - Additional JWT claims.
 * @returns {string} Signed JWT.
 */
function makeAdminToken(overrides = {}) {
  return jwt.sign(
    { id: 1, role: 'admin', tenantId: 'test-tenant', ...overrides },
    SECRET,
    { expiresIn: '1h' }
  );
}

const adminToken = makeAdminToken();
const VALID_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_ID_2 = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// ─── escrowVersions: REGISTRY ─────────────────────────────────────────────────

describe('REGISTRY', () => {
  it('contains at least one entry', () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(0);
  });

  it('maps semver strings to positive integers', () => {
    for (const [semver, schemaVersion] of Object.entries(REGISTRY)) {
      expect(typeof semver).toBe('string');
      expect(Number.isInteger(schemaVersion)).toBe(true);
      expect(schemaVersion).toBeGreaterThan(0);
    }
  });

  it('includes known versions 1.0.0, 1.1.0, 1.2.0', () => {
    expect(REGISTRY['1.0.0']).toBe(1);
    expect(REGISTRY['1.1.0']).toBe(2);
    expect(REGISTRY['1.2.0']).toBe(3);
  });

  it('is frozen so callers cannot mutate the shared registry', () => {
    expect(Object.isFrozen(REGISTRY)).toBe(true);
    expect(() => {
      REGISTRY['9.9.9'] = 999;
    }).toThrow();
    expect(REGISTRY['9.9.9']).toBeUndefined();
  });

  it('maps each schema version to exactly one semver (no duplicates)', () => {
    const seen = new Map();
    for (const [semver, schemaVersion] of Object.entries(REGISTRY)) {
      expect(seen.has(schemaVersion)).toBe(false);
      seen.set(schemaVersion, semver);
    }
  });

  it('has strictly increasing schema versions in ascending semver order', () => {
    const entries = Object.entries(REGISTRY).sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true })
    );
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i][1]).toBeGreaterThan(entries[i - 1][1]);
    }
  });
});

// ─── escrowVersions: assertRegistryInvariants / freezeRegistry ───────────────

describe('assertRegistryInvariants', () => {
  it('accepts the shipped REGISTRY', () => {
    expect(() => assertRegistryInvariants(REGISTRY)).not.toThrow();
  });

  it('rejects an empty registry', () => {
    expect(() => assertRegistryInvariants({})).toThrow(/non-empty/i);
  });

  it('rejects non-integer schema versions', () => {
    expect(() => assertRegistryInvariants({ '1.0.0': 1.5 })).toThrow(/integer/i);
  });

  it('rejects non-positive schema versions', () => {
    expect(() => assertRegistryInvariants({ '1.0.0': 0 })).toThrow(/positive/i);
  });

  it('rejects duplicate schema versions', () => {
    expect(() => assertRegistryInvariants({ '1.0.0': 1, '1.1.0': 1 })).toThrow(/duplicate/i);
  });

  it('rejects non-monotonic schema versions', () => {
    expect(() => assertRegistryInvariants({ '1.0.0': 2, '1.1.0': 1 })).toThrow(/monotonic/i);
  });

  it('rejects malformed semver keys', () => {
    expect(() => assertRegistryInvariants({ 'not-semver': 1 })).toThrow(/semver/i);
  });
});

describe('freezeRegistry', () => {
  it('returns a frozen copy and does not mutate the input', () => {
    const input = { '1.0.0': 1 };
    const frozen = freezeRegistry(input);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(frozen).not.toBe(input);
  });

  it('throws when given an invalid registry', () => {
    expect(() => freezeRegistry({ '1.0.0': -1 })).toThrow();
  });
});

// ─── escrowMap: compatibility contracts ──────────────────────────────────────

describe('escrowMap: ESCROW_MAP shape and invariants', () => {
  it('exposes a frozen map object', () => {
    expect(typeof ESCROW_MAP).toBe('object');
    expect(ESCROW_MAP).not.toBeNull();
    expect(Object.isFrozen(ESCROW_MAP)).toBe(true);
  });

  it('exposes documented invariants as a frozen array of strings', () => {
    expect(Array.isArray(ESCROW_MAP_INVARIANTS)).toBe(true);
    expect(ESCROW_MAP_INVARIANTS.length).toBeGreaterThan(0);
    for (const inv of ESCROW_MAP_INVARIANTS) {
      expect(typeof inv).toBe('string');
      expect(inv.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a valid contractId and integer schemaVersion >= 1', () => {
    for (const [key, entry] of Object.entries(ESCROW_MAP)) {
      expect(typeof key).toBe('string');
      expect(isValidContractId(entry.contractId)).toBe(true);
      expect(Number.isInteger(entry.schemaVersion)).toBe(true);
      expect(entry.schemaVersion).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('escrowMap: getEscrowMap', () => {
  it('returns a defensive copy that is not the internal map', () => {
    const a = getEscrowMap();
    const b = getEscrowMap();
    expect(a).not.toBe(ESCROW_MAP);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('mutating the returned copy does not affect subsequent calls', () => {
    const a = getEscrowMap();
    const keys = Object.keys(a);
    if (keys.length > 0) {
      delete a[keys[0]];
    }
    const b = getEscrowMap();
    expect(Object.keys(b).length).toBe(keys.length);
  });

  it('is deterministic across repeated calls', () => {
    const first = JSON.stringify(getEscrowMap());
    const second = JSON.stringify(getEscrowMap());
    expect(first).toBe(second);
  });
});

describe('escrowMap: resolveEscrow', () => {
  it('returns null for non-string input', () => {
    expect(resolveEscrow(null)).toBeNull();
    expect(resolveEscrow(undefined)).toBeNull();
    expect(resolveEscrow(123)).toBeNull();
    expect(resolveEscrow({})).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveEscrow('')).toBeNull();
  });

  it('returns null for malformed contract ids', () => {
    expect(resolveEscrow('bad')).toBeNull();
    expect(resolveEscrow('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('returns null for a valid but unknown contract id', () => {
    expect(resolveEscrow(VALID_ID_2)).toBeNull();
  });

  it('resolves a known contract id to its entry with key and schemaVersion', () => {
    const keys = Object.keys(ESCROW_MAP);
    if (keys.length === 0) {
      return;
    }
    const key = keys[0];
    const entry = ESCROW_MAP[key];
    const resolved = resolveEscrow(entry.contractId);
    expect(resolved).not.toBeNull();
    expect(resolved.key).toBe(key);
    expect(resolved.contractId).toBe(entry.contractId);
    expect(resolved.schemaVersion).toBe(entry.schemaVersion);
  });

  it('is deterministic for repeated calls with the same input', () => {
    const keys = Object.keys(ESCROW_MAP);
    if (keys.length === 0) {
      return;
    }
    const id = ESCROW_MAP[keys[0]].contractId;
    expect(resolveEscrow(id)).toEqual(resolveEscrow(id));
  });

  it('does not mutate the internal map when resolving', () => {
    const before = JSON.stringify(getEscrowMap());
    resolveEscrow(VALID_ID_2);
    const keys = Object.keys(ESCROW_MAP);
    if (keys.length > 0) {
      resolveEscrow(ESCROW_MAP[keys[0]].contractId);
    }
    const after = JSON.stringify(getEscrowMap());
    expect(after).toBe(before);
  });
});

// ─── escrowVersions: isValidContractId ───────────────────────────────────────

describe('isValidContractId', () => {
  it('accepts a valid Stellar contract address', () => {
    expect(isValidContractId(VALID_ID)).toBe(true);
  });

  it('rejects an address that is too short', () => {
    expect(isValidContractId('CAAA')).toBe(false);
  });

  it('rejects an address starting with wrong letter', () => {
    expect(isValidContractId('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidContractId(null)).toBe(false);
    expect(isValidContractId(undefined)).toBe(false);
    expect(isValidContractId(123)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidContractId('')).toBe(false);
  });
});

// ─── escrowVersions: compareVersions ─────────────────────────────────────────

describe('compareVersions', () => {
  it('returns current when on-chain version matches highest registry entry', () => {
    const result = compareVersions(3); // 1.2.0 -> 3
    expect(result.status).toBe('current');
    expect(result.knownVersion).toBe('1.2.0');
  });

  it('returns ahead when on-chain version exceeds all registry entries', () => {
    const result = compareVersions(99);
    expect(result.status).toBe('ahead');
    expect(result.knownVersion).toBe('1.2.0'); // highest known
  });

  it('returns unknown with matching semver for a lower known version', () => {
    const result = compareVersions(1); // 1.0.0 -> 1
    expect(result.status).toBe('unknown');
    expect(result.knownVersion).toBe('1.0.0');
  });

  it('returns ahead for version 42 (higher than max)', () => {
    const result = compareVersions(42);
    expect(result.status).toBe('ahead');
  });

  it('returns unknown/null for version 0 (not in registry, lower than max)', () => {
    const result = compareVersions(0);
    expect(result.status).toBe('unknown');
    expect(result.knownVersion).toBeNull();
  });

  it('rejects non-integer on-chain versions', () => {
    expect(() => compareVersions(1.5)).toThrow(/integer/i);
    expect(() => compareVersions('3')).toThrow(/integer/i);
    expect(() => compareVersions(null)).toThrow(/integer/i);
  });

  it('rejects negative on-chain versions', () => {
    expect(() => compareVersions(-1)).toThrow(/non-negative/i);
  });

  it('is deterministic across repeated calls', () => {
    const a = compareVersions(3);
    const b = compareVersions(3);
    expect(a).toEqual(b);
  });
});

// ─── escrowVersions: getOnChainSchemaVersion ─────────────────────────────────

describe('getOnChainSchemaVersion', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('rejects with INVALID_CONTRACT_ID when no contractId and no env var', async () => {
    await expect(getOnChainSchemaVersion()).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('rejects with INVALID_CONTRACT_ID for a bad contract address', async () => {
    await expect(getOnChainSchemaVersion('bad-id')).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('uses ESCROW_CONTRACT_ID env var when no argument given', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockRejectedValueOnce(new Error('RPC_NOT_IMPLEMENTED'));
    await expect(getOnChainSchemaVersion()).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });

  it('wraps RPC errors as RPC_ERROR', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('network timeout'));
    await expect(getOnChainSchemaVersion(VALID_ID)).rejects.toMatchObject({
      code: 'RPC_ERROR',
    });
  });

  it('resolves with the value returned by callSorobanContract', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const version = await getOnChainSchemaVersion(VALID_ID);
    expect(version).toBe(3);
  });

  it('rejects with INVALID_SCHEMA_VERSION when RPC returns a non-integer', async () => {
    callSorobanContract.mockResolvedValueOnce('3');
    await expect(getOnChainSchemaVersion(VALID_ID)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA_VERSION',
    });
  });

  it('rejects with INVALID_SCHEMA_VERSION when RPC returns a negative value', async () => {
    callSorobanContract.mockResolvedValueOnce(-1);
    await expect(getOnChainSchemaVersion(VALID_ID)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA_VERSION',
    });
  });

  it('rejects with INVALID_SCHEMA_VERSION when RPC returns null', async () => {
    callSorobanContract.mockResolvedValueOnce(null);
    await expect(getOnChainSchemaVersion(VALID_ID)).rejects.toMatchObject({
      code: 'INVALID_SCHEMA_VERSION',
    });
  });
});

// ─── contractListRefresh: runContractListRefresh ──────────────────────────────

describe('runContractListRefresh', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('returns structured result on success', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockResolvedValueOnce(3);
    const result = await runContractListRefresh();
    expect(result).toEqual({ onChainVersion: 3, knownVersion: '1.2.0', status: 'current' });
  });

  it('propagates RPC_ERROR from getOnChainSchemaVersion', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockRejectedValueOnce(new Error('timeout'));
    await expect(runContractListRefresh()).rejects.toMatchObject({ code: 'RPC_ERROR' });
  });

  it('propagates INVALID_CONTRACT_ID when env var is missing', async () => {
    await expect(runContractListRefresh()).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('accepts an explicit contractId override', async () => {
    callSorobanContract.mockResolvedValueOnce(2);
    const result = await runContractListRefresh(VALID_ID);
    expect(result.onChainVersion).toBe(2);
    expect(result.status).toBe('unknown'); // 2 < 3 (max) and matches 1.1.0
  });

  it('propagates INVALID_SCHEMA_VERSION for malformed RPC payloads', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockResolvedValueOnce('not-a-number');
    await expect(runContractListRefresh()).rejects.toMatchObject({
      code: 'INVALID_SCHEMA_VERSION',
    });
  });

  it('is idempotent for repeated identical calls', async () => {
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
    callSorobanContract.mockResolvedValue(3);
    const first = await runContractListRefresh();
    const second = await runContractListRefresh();
    expect(first).toEqual(second);
  });
});

// ─── Admin routes: POST /api/admin/escrow/refresh ────────────────────────────

describe('POST /api/admin/escrow/refresh', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
  });

  afterAll(() => {
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('returns 401 when no auth is provided', async () => {
    const res = await request(app).post('/api/admin/escrow/refresh');
    expect(res.status).toBe(401);
  });

  it('returns 202 with result on success (JWT auth)', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    // Response goes through standardized envelope: payload is in res.body.data
    expect(res.body.data.message).toBe('Contract list refresh triggered.');
    expect(res.body.data.onChainVersion).toBe(3);
    expect(res.body.data.status).toBe('current');
  });

  it('returns 400 when ESCROW_CONTRACT_ID is invalid', async () => {
    process.env.ESCROW_CONTRACT_ID = 'bad';
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 502 on RPC failure', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('timeout'));
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });

  it('returns 502 when RPC returns a malformed schema version', async () => {
    callSorobanContract.mockResolvedValueOnce('bad');
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });

  it('returns 202 when authenticated via X-API-KEY', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const res = await request(app)
      .post('/api/admin/escrow/refresh')
      .set('x-tenant-id', 'test-tenant')
      .set('X-API-KEY', 'any-key');
    expect(res.status).toBe(202);
  });
});

// ─── Admin routes: GET /api/admin/escrow/version ─────────────────────────────

describe('GET /api/admin/escrow/version', () => {
  beforeEach(() => {
    callSorobanContract.mockReset();
    process.env.ESCROW_CONTRACT_ID = VALID_ID;
  });

  afterAll(() => {
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it('returns 401 when no auth is provided', async () => {
    const res = await request(app).get('/api/admin/escrow/version');
    expect(res.status).toBe(401);
  });

  it('returns 200 with version info on success', async () => {
    callSorobanContract.mockResolvedValueOnce(3);
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Response goes through standardized envelope: payload is in res.body.data
    expect(res.body.data).toMatchObject({
      onChainVersion: 3,
      knownVersion: '1.2.0',
      status: 'current',
    });
  });

  it('returns 400 when ESCROW_CONTRACT_ID is invalid', async () => {
    process.env.ESCROW_CONTRACT_ID = 'bad';
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('returns 502 on RPC failure', async () => {
    callSorobanContract.mockRejectedValueOnce(new Error('rpc down'));
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });

  it('returns 502 when RPC returns a malformed schema version', async () => {
    callSorobanContract.mockResolvedValueOnce(-5);
    const res = await request(app)
      .get('/api/admin/escrow/version')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(502);
  });
});
