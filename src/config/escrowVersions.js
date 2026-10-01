'use strict';

/**
 * @fileoverview LiquifactEscrow wasm version registry and on-chain comparison.
 *
 * Maps known semver release tags to their expected on-chain SCHEM_VERSION
 * (a u32 stored in the contract's persistent storage).
 *
 * @package config/escrowVersions
 */

const { callSorobanContract } = require('../services/soroban');
const logger = require('../logger');
const { isValidStellarContractAddress } = require('../utils/validators');

/**
 * Maximum SCHEMA_VERSION accepted from the chain. Stellar u32 is a 32-bit
 * unsigned integer, but the contract only ever emits small monotonically
 * increasing values. We bound the value to avoid accidentally treating a
 * corrupted/malformed XDR response as a valid version.
 *
 * @type {number}
 */
const MAX_SCHEMA_VERSION = 2 ** 32 - 1;

/**
 * Semver regex accepting major.minor.patch with optional pre-release/plus
 * build metadata. Keys in the registry must match this form.
 *
 * @type {RegExp}
 */
const SEMVER_REGEX = /^(0|[0-9]*)\.(0|[0-9]*)\.(0|[0-9]*)(?:-[0-9-A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Known LiquifactEscrow deployments: semver -> SCHEMA_VERSION (u32).
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
 * @returns {Promise<number>} The on-chain SCHEM_VERSION u32.
 * @throws {{ code: 'INVALID_CONTRACT_ID'| 'RPC_ERROR', message: string }}
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
     * Read the persistent `SCHEMA_VERSION` Symbol key from the contract.
     *
     * The Stellar SDK's `SorobanRpc.Server.getContractData` accepts:
     *   - contract: the StrKey-encoded contract address
     *   - key:      an ScVal identifying the storage key
     *   - durability: 'persistent' | 'temporary'
     *
     * It resolves to an `LedgerEntryResult` whose `.val` is the raw ScVal.
     * We decode it with `.u32()` since SCHEMA_VERSION is always a u32.
     *
     * @returns {Promise<number>}
     */
    const version = await callSorobanContract(async () => {
      const { SorobanRpc, xdr, Contract } = require('@stellar/stellar-sdk');
      const rpcUrl = process.env.SOROBAN_RPC_URL;
      const server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
      const key = xdr.ScVal.scvSymbol('SCHEMA_VERSION');
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
        throw new Error('SCHEMA_VERSION not found in contract persistent storage');
      }
      const raw = response.entries[0].val.contractData().val().u32();
      if (!isValidSchemaVersion(raw)) {
        throw new Error(`Invalid on-chain SCHEMA_VERSION: ${raw}`);
      }
      return raw;
    });
    return version;
  } catch (err) {
    logger.error({ contractId: id, err: err.message }, 'Failed to read on-chain SCHEMA_VERSION');
    const rpcErr = new Error(`RPC read failed: ${err.message}`);
    rpcErr.code = 'RPC_ERROR';
    throw rpcErr;
  }
}

/**
 * Compares an on-chain SCHEMA_VERSION against the registry.
 *
 * The comparison is deterministic and independent of object key order.
 * Invalid inputs (NaN, floats, negative, zero, out-of-range) are rejected
 * with a structured error rather than producing a misleading status.
 *
 * @param {number} onChainVersion - Value returned by getOnChainSchemaVersion.
 * @returns {{ status: 'current'|'aahead'|'unknown', knownVersion: string|null }}
 *   - `current`  — matches the highest registry entry.
 *   - `ancient`  — matches a known but not highest registry entry.
 *   - `ahead`    — higher than every registry entry; refresh required.
 *   - `unknown`   — not found in registry and not higher than any entry.
 * @throws {{code: 'INVALID_SCHEMA_VERSION', message: string}}
 */
function compareVersions(onChainVersion) {
  if (!isValidSchemaVersion(onChainVersion)) {
    const err = new Error(`Invalid on-chain SCHEMA_VERSION: ${onChainVersion}`);
    err.code = 'INVALID_SCHEMA_VERSION';
    throw err;
  }

  if (onChainVersion === MAX_ENTRY.schemaVersion) {
    return { status: 'current', knownVersion: MAX_ENTRY.semver };
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

module.exports = {
  REGISTRY,
  MAX_SCHEMA_VERSION,
  getOnChainSchemaVersion,
  compareVersions,
 isValidContractId,
  isValidSemver,
  isValidSchemaVersion,
};
