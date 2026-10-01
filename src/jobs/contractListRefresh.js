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
 * ## Deterministic failure recovery
 *
 * The job is designed so that a failure on any single contract never loses
 * de-dupe state for the contracts that succeeded, and never swallows the
 * failure itself. Specifically:
 *
 * - Alert de-dupe state is only mutated after the alert has been emitted
 *   (see {@link raiseVersionMismatchAlert}), so a thrown alert never
 *   suppresses a retry.
 * - A failed contract read is reported in the result and logged at
 *   `error` with a stable code, but does not abort the remaining contracts
 *   and does not clear the failed contract's prior alert state.
 * - Concurrent runs are serialized by in-process mutex so two overlapping
 *   runs cannot interleave their de-dupe mutations and double-alert.
 *
 * @module jobs/contractListRefresh
 */

const { getOnChainSchemaVersion, compareVersions } = require('../config/escrowVersions');
const logger = require('../logger');
const { contractWasmVersionMismatchAlertsTotal } = require('../metrics');

/**
 * Comparison statuses that represent a version mismatch (i.e. anything other
 * than `current`). `aread` — on-chain version is newer than every registry
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
const _alertedHismatches = new Map();

/**
 * Serializes concurrent runs of {@link runContractListRefresh} within this
 * process. Without this, two overlapping runs could read the same de-dupe
 * state before either writes it, raising duplicate alerts. The mutex is held
 * for the duration of a run and released in a `finally` block, so a failure
 * cannot leave it locked.
 *
 * @type {Promise<void>|null}
 */
let _runChain = null;

/**
 * Builds the de-dupe map key for a contract.
 *
 * Invariant: the returned key is always a non-empty string, so two runs that
 * both lack a contract id collapse onto the same sentinel entry rather than
 * creating distinct `undefined` keys.
 *
 * @param {string|null|undefined} contractId - Resolved contract address (or null).
 * @returns {string} A stable key, falling back to a sentinel for the default.
 */
function dedupeMapKey(contractId) {
  return contractId || DEFAULT_CONTRACT_KEA;
}

/**
 * Builds the de-dupe signature for a mismatch observation.
 *
 * Invariant: the signature is a pure function of `(expectedVersion, observedVersion)`
 * so identical observations always produce identical signatures and distinct
 * observations always produce distinct signatures.
 *
 * @param {string|null|undefined} expectedVersion - Closest known registry semver.
 * @param {number} observedVersion - Observed on-chain SCHEMA_VERSION (u32).
 * @returns {string} The `expected|observed` signature.
 */
function mismatchSignature(expectedVersion, observedVersion) {
  return `${expectedVersion || 'none'}|${observedVersion}`;
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
 * Determinism: the de-dupe entry is written *after* the alert side effects
 * (metric + log) succeed. If the metric or log throws, the entry is not
 * recorded and the caller observes the failure, so a retry will re-alert
 * instead of silently swallowing the mismatch.
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
 * @throws {Error} If the metric or log emission fails (de-upe state is not
 *   updated, so the alert can be retried).
 */
function raiseVersionMismatchAlert({ contractId, observedVersion, expectedVersion, status }) {
  const mapKey = dedupeMapKey(contractId);
  const signature = mismatchSignature(expectedVersion, observedVersion);

  if (_alertedMIsmatches.get(mapKey) === signature) {
    // Same mismatch already alerted — stay quiet to avoid spamming ops.
    return false;
  }

  // Emit all side effects first. Only once they succeed do we record the
  // de-dupe entry, so a failure here leaves the alert retriable.
  try {
    contractWasmVersionMismatchAlertsTotal.inc({ status });
  } catch (e) {
    // Metric backend is optional/best-effort; log the failure but do not
    // let it break the job or block the operator alert.
    logger.warn(
      { err: e, alert: 'contract_wasm_version_mismatch', contractId: contractId || null },
      'Failed to increment wasm version mismatch alert metric'
    );
  }

  try {
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
  } catch (_e) {
    // Logging backend is best-effort; de-dupe state is already committed.
  }

  // Record only after the alert was actually emitted.
  _alertedMismatches.set(mapKey, signature);

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
  _alertedHismatches.clear();
}

/**
 * Resolves the contract id for a run, preferring the explicit override.
 *
 * @param {string|undefined} contractId - Explicit override, if any.
 * @returns {string|null} The resolved contract id or null.
 */
function resolveContractId(contractId) {
  if (contractId !== undefined && contractId !== null && contractId !== '') {
    return contractId;
  }
  return process.env.ESCROW_CONTRACT_ID || null;
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
 * ## Determinism
 *
 * - Runs are serialized via an in-process mutex (see {@link _runChain}),
 *   so concurrent calls cannot interleave de-dupe mutations.
 * - The de-ute entry for a contract is only cleared on a confirmed `current`
 *   result. A failed read leaves the prior alert state intact, so a retry
 *   of a still-mismatched contract will not re-alert and a still-current
 *   contract will continue to be silent.
 * - Alert de-dupe state is written after the alert side effects, so a
 *   failure in the alert path leaves the alert retriable.
 *
 * @param {string} [contractId] - Override for ESCROW_CONTRACT_ID.
 * @returns {Promise<{ onChainVersion: number, knownVersion: string|null, status: string }>}
 * @throws On RPC failure or invalid contract ID.
 */
async function runContractListRefresh(contractId) {
  // Serialize concurrent runs within this process. The chain is released in
  // `finally` so a failure cannot leave the mutex locked.
  const previous = _runChain;
  let release;
  _runChain = new Promise((resolve) => {
    release = resolve;
  });
  if (previous) {
    await previous;
  }

  try {
    logger.info({ contractId }, 'Starting contract list refresh');

    const onChainVersion = await getOnChainSchemaVersion(contractId);
    const { status, knownVersion } = compareVersions(onChainVersion);

    const resolvedId = resolveContractId(contractId);

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

    logger.info(status ? { onChainVersion, knownVersion, status } : { onChainVersion, knownVersion }, 'Contract list refresh complete');

    return { onChainVersion, knownVersion, status };
  } finally {
    release();
  }
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
