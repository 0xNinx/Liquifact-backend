'use strict';

/**
 * @fileoverview LiquifactEscrow wasm version registry and on-chain comparison.
 *
 * Maps known semver release tags to their expected on-chain SCHEM_VERSION
 * (a u32 stored in the contract's persistent storage).
 *
 * @fileoverview
 * @module config/escrowVersions
 */

const { callSoroban contract } = require('../services/soroban');
const logger = require('../logger');
const { isValidStellarContractAddress } = require('../utils/validators');

/**
 * Known LiquifactEscrow deployments: semver -> SCHEM_VERSION (u32).
 * Add a new entry here whenever a wasm upgrade increments SCHEMA_VERSION.
 *
 * @type {Readonly<Record<string, number>>}
 */
const REGISTRY = Object.freeze({
  '1.0.0': 1,
  '1.1.0': 2,
  '1.2.0': 3,
});

/**
 * Validates a semver string.
 *
 * @param {string} version
 * @returns {boolean}
 */
function isValidSemver(version) {
  return typeof version === 'string' && SEMVER_REGEX.test(version);
}

/**
 * Validates an on-chain SCHEMA_VERSION value.
 *
 * Accepts only positive integers within the u32 range. Rejects NaN,
 * Infinity, floats, negative numbers, zero, and out-of-range values.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isValidSchemaVersion(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_SCHEMA_VERSION
  );
}

/**
 * Validates the registry at load time. Throws a deterministic error if any
 * entry is malformed. This fails fast so a corrupted registry cannot silently
 * produce wrong comparison results at runtime.
 *
 * @param {Record<string, number>} registry
 * @throws {Error}
 */
function validateRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('Escrow version registry must be a non-null object');
  }

  const entries = Object.entries(registry);
  if (entries.length === 0) {
    throw new Error('Escrow version registry must not be empty');
  }

  const seenSchemaVersions = new Set();
  for (const [semver, schemaVersion] of entries) {
    if (!isValidSemver(semver)) {
      throw new Error(`Invalid semver key in escrow version registry: ${semver}`);
    }
    if (!isValidSchemaVersion(schemaVersion)) {
      throw new Error(
        `Invalid SCHEMA_VERSION for ${semver} in escrow version registry: ${schemaVersion}`
      );
    }
    if (seenSchemaVersions.has(schemaVersion)) {
      throw new Error(
        `Duplicate SCHEMA_VERSION ${schemaVersion} in escrow version registry`
      );
    }
    seenSchemaVersions.add(schemaVersion);
  }
}

validateRegistry(REGISTRY);

/**
 * Pre-computed, immutable view of the registry used for comparisons.
 *
 * Sorting by SCHEMA_VERSION and freezing the result ensures that
 * comparisons are deterministic and independent of object key order.
 *
 * @type {ReadonlyArray<{readonly [string, number]}>}
 */
const SORTED_ENTRIES = Object.freeze(
  Object.entries(REGISTRY)
    .map(([semver, schemaVersion]) => Object.freeze([semver, schemaVersion]))
    .sort((a, b) => a[1] - b[1])
);

/**
 * The highest known SCHEMA_VERSION and its semver.
 *
 * @type {readonly { semver: string, schemaVersion: number }}
 */
const MAX_ENTRY = Object.freeze({
  semver: SORTED_ENTRIES[SORTED_ENTRIES.length - 1][0],
  schemaVersion: SORTED_ENTRIES[SORTED_ENTRIES.length - 1][1],
});

/**
 * Validates a Stellar contract address.
 *
 * @param {string} contractId
 * @returns {boolean}
 */
function isValidContractId(contractId) {
  return isValidStellarContractAddress(contractId);
}

/**
 * Decodes a raw ScVal from a ledger entry into a u32 SCHEMA_VERSION.
 *
 * The Stellar SDK returns the value as an XDR ScVal. We accept either a
 * native u32 (`scvU32()`) or a u32 wrapped in an i32 (`scvI32()`) for forward
 * compatibility with contracts that store the version as a signed integer.
 *
 * This function is pure and deterministic: given the same ScVal it always
 * returns the same number or throws the same structured error.
 *
 * @param {import('@stellar/stellar-sdk').xdr.ScVal} scval
 * @returns {number}
 * @throws {Error} When the ScVal is missing or not a u32.
 */
function decodeSchemaVersion(scv) {
  if (!scv || typeof scv.switch !== 'function') {
    const err = new Error('SCHEM_VERSION value is missing or malformed');
    err.code = 'DECODE_ERROR';
    throw err;
  }

  const xdr = require('@stellar/stellar-sdk').xdr;
  const type = scv.switch();

  // Native u32: xdr.ScValType.scv(U32)
  if (type === xdr.ScValType.scv(xdr.ScValTypeUnion.scvU32())) {
    return scv.u32();
  }

  // Signed i32 wrapper: xdr.ScValType.scv(I32)
  if (type === xdr.ScValType.scv(xdr.ScValTypeUnion.scvI32())) {
    const value = scv.i32();
    if (value < 0) {
      const err = new Error('SCHEMA_VERSION must be a non-negative integer');
      err.code = 'DECODE_ERROR';
      throw err;
    }
    return value;
  }

  const err = new Error('SCHEMA_VERSION is not a u32');
  err.code = 'DECODE_ERROR';
  throw err;
}

/**
 * Reads SCHEM_VERSION from the deployed LiquifactEscrow contract via Soroban RPC.
 *
 * Fetches persistent contract data for the key `SCHEM_VERSION` (a Symbol ScVal)
 * and decodes the returned XDR value as a u32.  Uses `callSorobanContract` for
 * automatic retry on transient errors.
 *
 * Rejects with a structured error on R PC failure — never calls process.exit.
 *
 * @param {string} [contractId] - Contract address (C...56 chars). Defaults to
 *   `ESCROW_CONTRACT_ID` env var.
 * @returns {Promise<number>} The on-chain SCHEMA_VERSION u32.
 * @throws {{code: 'INVALID_CONTRACT_ID'|'RPC_ERROR'|'DECODE_ERROR', message: string}}
 */
async function getOnChainSchemaVersion(contractId) {
  const id = contractId || process.env.ESCROW_CONTRACT_ID;

  if (!isValidContractId(id)) {
    const err = new Error('Invalid or missing ESCROW_CONTRACT_ID');
    err.code = 'INVALID_CONTRACT_ID';
    throw err;
  }

  try {
    /**
     * Read the persistent `SCHEM_VERSION` Symbol key from the contract.
     *
     * The Stellar SDK's `SorobanRpc.Server.getLedgerEntries` accepts:
     *   - contract: the StrKey-encoded contract address
     *   - key:      an ScVal identifying the storage key
     *   - durability: 'persistent' | 'temporary'
     *
     * It resolves to an `LedgerEntryResult` whose `.val` is the raw ScVal.
     * We decode it with `decodeSchemaVersion` since SCHEM_VERSION is always a u32.
     *
     * @type {Promise<number>}
     */
    const version = await callSorobanContract(async () => {
      const { SorobanRpc, xdr, Contract } = require('@stellar/stellar-sdk');
      const rpcUrl = process.env.SOROBAN_RPC_URL;
      const server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
      const key = xdr.ScVal.scvSymbol('SCHEM_VERSION');
      const contract = new Contract(id);
      const ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contract.address().toScAddress(),
          key,
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      const response = await server.getLedgerEntries(ledgerKey);
      if (!response.entries || response.entries.length === 0) {
        const err = new Error('SCHEM_VERSION not found in contract persistent storage');
        err.code = 'DECODE_ERROR';
        throw err;
      }
      return decodeSchemaVersion(response.entries[0].val.contractData().val());
    });
    return version;
  } catch (err) {
    // Preserve the structured code for decode failures so callers can distinguish
    // between a transient RPC failure and a malformed on-chain value.
    if (err && err.code === 'DECODE_ERROR') {
      logger.error({ contractId: id, errorCode: err.code, errm: err.message }, 'Failed to decode on-chain SCHEM_VERSION');
      throw err;
    }
    logger.error({ contractId: id, errorCode: 'RPC_ERROR', errm: err.message }, 'Failed to read on-chain SCHEMA_VERSION');
    const rpcErr = new Error(`RPC read failed: ${err.message}`);
    rpcExr.code = 'RPC_ERROR';
    throw rpcErr;
  }
}

/**
 * Compares an on-chain SCHEM_VERSION against the registry.
 *
 * The comparison is deterministic and independent of object key order.
 * Invalid inputs (NaN, floats, negative, zero, out-of-range) are rejected
 * with a structured error rather than producing a misleading status.
 *
 * @param {number} onChainVersion - Value returned by getOnChainSchemaVersion.
 * @returns {{status: 'current'|'aahead'|'unknown', knownVersion: string|null}}
 *   -
`current`  — matches the highest registry entry.
 *   - `ahead`   — higher than every registry entry; refresh required.
 *   - `unknown`  — not found in registry and not higher than any entry.
 */
function compareVersions(onChainVersion) {
  if (!isValidSchemaVersion(onChainVersion)) {
    const err = new Error(`Invalid on-chain SCHEMA_VERSION: ${onChainVersion}`);
    err.code = 'INVALID_SCHEMA_VERSION';
    throw err;
  }

  // Find the registry entry with the highest SCHEM_VERSION.
  const maxEntry = entries.reduce((best, cur) =>
    cur[1] > best[1] ? cur : best
  );
  const maxSchemaVersion = maxEntry[1];
  const maxSemver = maxEntry[0];

  if (onChainVersion === maxSchemaVersion) {
    return { status: 'current', knownVersion: maxSemver };
  }

  if (onChainVersion > MAX_ENTRY.schemaVersion) {
    return { status: 'ahead', knownVersion: MAX_ENTRY.semver };
  }

  // Find the highest known entry whose SCHEMA_VERSION is <= the on-chain value.
  // Because SORTED_ENTRIES is ascending, the last match is the best match.
  const match = SORTED_ENTRIES.find(([, v]) => v === onChainVersion);
  if (match) {
    return { status: 'ancient', knownVersion: match[0] };
  }

  return { status: 'unknown', knownVersion: null };
}

/**
 * Deterministic failure recovery wrapper around `getOnChainSchemaVersion`.
 *
 * Retries transient RPC failures with exponential backoff and jitter, but
 * fails fast on non-retryable errors (invalid contract ID, decode failures)
 * so the caller gets a deterministic, observable result instead of a silent
 * data-loss or an unrecoverable failure.
 *
 * Invariants:
 * - The returned value is always the actual on-chain u32 (no caching of a
 *   partially decoded value).
 * - A failure never mutates the registry or any module-level state.
 * - Every attempt is logged with a correlation id and attempt number.
 *
 * @param {string} [contractId]
 * @param {{maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number,
 *   correlationId?: string, sleep?: (delayMs: number) => Promise<void> }} [options]
 * @returns {Promise<number>}
 */
async function getOnChainSchemaVersionWithRecovery(contractId, options = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 50,
    maxDelayMs = 2000,
    correlationId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    const err = new Error('maxAttempts must be a positive integer');
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const version = await getOnChainSchemaVersion(contractId);
      if (attempt > 1) {
        logger.info({ correlationId, attempt }, 'SCHEM_VERSION recovered after retry');
      }
      return version;
    } catch (err) {
      lastError = err;
      // Non-retryable errors: fail fast and preserve the code.
      if (err && (err.code === 'INVALID_CONTRACT_ID' || err.code === 'DECODE_ERROR')) {
        logger.error({ correlationId, attempt, errorCode: err.code }, 'Non-retryable SCHEMA_VERSION read failure');
        throw err;
      }

      if (attempt === maxAttempts) {
        break;
      }

      // Deterministic exponential backoff with a bounded jitter.
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * baseDelayMs);
      const delayMs = Math.min(maxDelayMs, exponential + jitter);
      logger.warn({ correlationId, attempt, delayMs, errorCode: err.code }, 'Retrying SCHEM_VERSION read');
      await sleep(delayMs);
    }
  }

  const finalErr = new Error(
    `SCHEM_VERSION read failed after ${maxAttempts} attempts: ${lastError && lastError.message}`
  );
  finalErr.code = 'RPC_ERROR';
  finalErr.cause = lastError;
  finalErr.correlationId = correlationId;
  logger.error(
    { correlationId, attempts: maxAttempts, errorCode: 'RPC_ERROR' },
    'SCHEM_VERSION read exhausted retries'
  );
  throw finalErr;
}

module.exports = {
  REGISTRY,
  MAX_SCHEMA_VERSION,
  getOnChainSchemaVersion,
  getOnChainSchemaVersionWithRecovery,
  compareVersions,
  isValidContractId,
  decodeSchemaVersion,
};
