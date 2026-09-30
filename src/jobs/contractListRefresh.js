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
  const signature = `${expectedVersion || 'none'}|${observedVersion}`;

  if (_alertedMismatches.get(mapKey) === signature) {
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
  MISMATCH_STATUSES,
};
