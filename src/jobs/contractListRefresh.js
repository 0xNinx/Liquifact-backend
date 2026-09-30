'use strict';

/**
 * @fileoverview Contract list refresh job for LiquifactEscrow wasm upgrades.
 *
 * Reads the on-chain SCHEMA_VERSION, compares it against the registry, and
 * returns a structured result.  Never calls process.exit on error.
 *
 * When the on-chain version diverges from the expected/known registry version
 * an operator-facing alert is raised (dedicated metric + `error`-severity log).
 * A version mismatch signals a contract upgrade or an unexpected/rolled-back
 * deployment that the backend may not yet support, so it must not be noticed
 * silently. See {@link raiseVersionMismatchAlert} and `docs/wasm-ops.md`.
 *
 * @module jobs/contractListRefresh
 */

const { getOnChainSchemaVersion, compareVersions } = require('../config/escrowVersions');
const logger = require('../logger');
const { contractWasmVersionMismatchAlertsTotal } = require('../metrics');

/**
 * Comparison statuses that represent a version mismatch (i.e. anything other
 * than `current`). `ahead` — on-chain version is newer than every registry
 * entry; `unknown` — on-chain version is not tracked by the registry.
 *
 * @type {ReadonlySet<string>}
 */
const MISMATCH_STATUSES = new Set(['ahead', 'unknown']);

/**
 * Every status `compareVersions` is allowed to return. Anything else means the
 * comparison module violated its contract, and a mismatch alert must not be
 * raised or suppressed on the strength of an unknown value.
 *
 * @type {ReadonlySet<string>}
 */
const VALID_STATUSES = new Set(['current', 'ahead', 'unknown']);

/**
 * Largest value a Soroban `u32` SCHEMA_VERSION can hold. A decoded version
 * outside `[0, MAX_U32]` (NaN, a float, a negative, an overflow) is a corrupt
 * read, not a real on-chain version — alerting on it would be a false positive.
 *
 * @constant {number}
 */
const MAX_U32 = 0xffffffff;

/**
 * Error codes raised by input validation. Callers branch on `code`, never on
 * message text.
 *
 * @constant {Readonly<Record<string, string>>}
 */
const REFRESH_ERRORS = Object.freeze({
  /** `contractId` override was present but not a usable string. */
  INVALID_CONTRACT_ID: 'INVALID_CONTRACT_ID',
  /** The decoded on-chain SCHEMA_VERSION was not a valid u32. */
  INVALID_ON_CHAIN_VERSION: 'INVALID_ON_CHAIN_VERSION',
  /** `compareVersions` returned a status outside {@link VALID_STATUSES}. */
  INVALID_STATUS: 'INVALID_STATUS',
});

/**
 * Builds a tagged validation error.
 *
 * @param {string} code - One of {@link REFRESH_ERRORS}.
 * @param {string} message - Human-readable detail.
 * @returns {Error} Error with `code` set.
 */
function _refreshError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Validates the optional `contractId` override.
 *
 * `undefined`/`null` are allowed and mean "fall back to ESCROW_CONTRACT_ID".
 * A supplied override must be a non-empty string; it is trimmed so callers
 * cannot smuggle a whitespace id past the downstream address validation. This
 * deliberately does not enforce the Stellar address *format* — that concern is
 * owned by `config/escrowVersions` and is exercised by its own tests.
 *
 * @param {unknown} contractId - Candidate override.
 * @returns {string|undefined} Trimmed override, or undefined when absent.
 * @throws {Error} `INVALID_CONTRACT_ID` for a present-but-unusable override.
 */
function validateContractIdOverride(contractId) {
  if (contractId === undefined || contractId === null) {
    return undefined;
  }
  if (typeof contractId !== 'string' || contractId.trim().length === 0) {
    throw _refreshError(
      REFRESH_ERRORS.INVALID_CONTRACT_ID,
      'contractId override must be a non-empty string'
    );
  }
  return contractId.trim();
}

/**
 * Validates the on-chain SCHEMA_VERSION decoded from the RPC read.
 *
 * @param {unknown} value - Decoded version.
 * @returns {number} The validated integer.
 * @throws {Error} `INVALID_ON_CHAIN_VERSION` when not an integer in [0, MAX_U32].
 */
function validateOnChainVersion(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw _refreshError(
      REFRESH_ERRORS.INVALID_ON_CHAIN_VERSION,
      `on-chain SCHEMA_VERSION must be an integer in [0, ${MAX_U32}], got ${String(value)}`
    );
  }
  return value;
}

/**
 * Validates the comparison envelope returned by `compareVersions`.
 *
 * Guards against a malformed/`undefined` return (which would otherwise be
 * destructured or silently treated as "no mismatch") and against an unexpected
 * status (which would otherwise skip the alert path entirely).
 *
 * @param {unknown} comparison - Return value of `compareVersions`.
 * @returns {{ status: 'current'|'ahead'|'unknown', knownVersion: string|null }}
 *   The validated envelope.
 * @throws {Error} `INVALID_STATUS` when the envelope or status is not recognised.
 */
function validateComparison(comparison) {
  if (!comparison || typeof comparison !== 'object') {
    throw _refreshError(
      REFRESH_ERRORS.INVALID_STATUS,
      'compareVersions returned a non-object result'
    );
  }
  if (!VALID_STATUSES.has(comparison.status)) {
    throw _refreshError(
      REFRESH_ERRORS.INVALID_STATUS,
      `compareVersions returned an unexpected status: ${String(comparison.status)}`
    );
  }
  return comparison;
}

/**
 * De-dupe state for raised mismatch alerts, keyed by resolved contract id.
 * The value is the last alerted `expected|observed` version-pair signature, so a
 * persistent, already-reported mismatch does not re-alert on every scheduled
 * run. The entry is cleared once the contract's version returns to `current`,
 * allowing a future regression to alert again.
 *
 * @type {Map<string, string>}
 */
const _alertedMismatches = new Map();

/**
 * Builds the de-dupe map key for a contract.
 *
 * @param {string|null} contractId - Resolved contract address (or null).
 * @returns {string} A stable key, falling back to a sentinel for the default.
 */
function dedupeMapKey(contractId) {
  return contractId || '<default>';
}

/**
 * Raises an operator-facing alert for an on-chain wasm version mismatch.
 *
 * Increments the dedicated {@link contractWasmVersionMismatchAlertsTotal} metric
 * and writes an `error`-severity structured log — the severity the existing
 * alerting pipeline consumes — tagged with `alert: 'contract_wasm_version_mismatch'`.
 *
 * The alert is de-duplicated by `(contractId, expected, observed)`: while the
 * same mismatch persists across runs no new alert is emitted. State is reset for
 * a contract once it returns to `current` (see {@link runContractListRefresh}).
 *
 * Security: only non-secret, publicly observable values are surfaced — the
 * contract address (a public on-chain identifier), the expected registry version
 * label, the observed on-chain SCHEMA_VERSION integer, and the status. No RPC
 * URLs, keys, or other secrets are included in the payload.
 *
 * @param {object} params - Alert parameters.
 * @param {string|null} params.contractId - Resolved contract address.
 * @param {number} params.observedVersion - Observed on-chain SCHEMA_VERSION (u32).
 * @param {string|null} params.expectedVersion - Closest known registry semver, or null.
 * @param {'ahead'|'unknown'} params.status - Comparison status driving the alert.
 * @returns {boolean} `true` when a new alert was raised, `false` when de-duped.
 */
function raiseVersionMismatchAlert({ contractId, observedVersion, expectedVersion, status }) {
  const mapKey = dedupeMapKey(contractId);
  const signature = `${expectedVersion || 'none'}|${observedVersion}`;

  if (_alertedMismatches.get(mapKey) === signature) {
    // Same mismatch already alerted — stay quiet to avoid spamming ops.
    return false;
  }
  _alertedMismatches.set(mapKey, signature);

  try {
    contractWasmVersionMismatchAlertsTotal.inc({ status });
  } catch (_e) {
    // Metric backend is optional/best-effort; never let it break the job.
  }

  logger.error(
    {
      alert: 'contract_wasm_version_mismatch',
      contractId: contractId || null,
      expectedVersion: expectedVersion || null,
      observedVersion,
      status,
    },
    'ALERT: on-chain wasm SCHEMA_VERSION mismatch detected'
  );

  return true;
}

/**
 * Clears the version-mismatch alert de-dupe state.
 *
 * Intended for tests and operational resets (e.g. forcing the next run to
 * re-alert on a still-present mismatch).
 *
 * @returns {void}
 */
function resetVersionMismatchAlertState() {
  _alertedMismatches.clear();
}

/**
 * Runs the contract list refresh job.
 *
 * Reads the on-chain SCHEMA_VERSION and compares it to the registry. On a
 * mismatch (`ahead`/`unknown`) it raises a de-duplicated operator alert; on a
 * `current` match it clears any prior alert state for the contract so a future
 * regression re-alerts. A read failure propagates and is **not** treated as a
 * mismatch (no alert is raised).
 *
 * @param {string} [contractId] - Override for ESCROW_CONTRACT_ID.
 * @returns {Promise<{ onChainVersion: number, knownVersion: string|null, status: string }>}
 * @throws On RPC failure or invalid contract ID.
 */
async function runContractListRefresh(contractId) {
  // ── Validation boundary ──────────────────────────────────────────────────
  // Validate before any RPC call or alert so bad inputs fail deterministically
  // and never produce a false mismatch alert.
  const override = validateContractIdOverride(contractId);
  logger.info({ contractId: override }, 'Starting contract list refresh');

  const onChainVersion = validateOnChainVersion(await getOnChainSchemaVersion(override));
  const { status, knownVersion } = validateComparison(compareVersions(onChainVersion));

  const resolvedId = override || process.env.ESCROW_CONTRACT_ID || null;

  if (MISMATCH_STATUSES.has(status)) {
    raiseVersionMismatchAlert({
      contractId: resolvedId,
      observedVersion: onChainVersion,
      expectedVersion: knownVersion,
      status,
    });
  } else {
    // Versions match — drop any prior alert state so a later regression alerts.
    _alertedMismatches.delete(dedupeMapKey(resolvedId));
  }

  logger.info({ onChainVersion, knownVersion, status }, 'Contract list refresh complete');

  return { onChainVersion, knownVersion, status };
}

module.exports = {
  runContractListRefresh,
  raiseVersionMismatchAlert,
  resetVersionMismatchAlertState,
  validateContractIdOverride,
  validateOnChainVersion,
  validateComparison,
  MISMATCH_STATUSES,
  VALID_STATUSES,
  REFRESH_ERRORS,
  MAX_U32,
};
