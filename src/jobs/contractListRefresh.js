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
 * ## State invariants
 *
 * The job owns a single piece of mutable state: the alert de-dupe map
 * (`_alertedMismatches`). The following invariants MUST hold at all times:
 *
 * 1. **Keyed by resolved contract id.** Every entry is keyed by the resolved
 *    contract id (or the `<default>` sentinel when no id is configured), never
 *    by a raw/orphan argument. This keeps concurrent runs for the same
 *    contract from creating duplicate entries.
 * 2. **Signature monotonicity.** For a given contract, the stored signature is
 *    always the most recently *observed* `expected|observed` pair. A mismatch
 *    that is already recorded is never re-alerted; a *different* mismatch
 *    (changed expected or observed version) always alerts.
 * 3. **Reset on recovery.** When a contract returns to `current`, its entry is
 *    removed so a future regression re-alerts.
 * 4. **No partial writes.** The map is only mutated after the alert payload has
 *    been fully constructed, and metric/log emission is best-effort and cannot
 *    roll back the map. A failed metric backend must not corrupt de-dupe state.
 * 5. **Bounded growth.** Entries are only ever created for contracts that are
 *    currently mismatched and are removed on recovery, so the map is bounded by
 *    the number of distinct mismatched contracts.
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
 * Sentinel key used when no contract id is configured/resolved.
 *
 * @type {string}
 */
const DEFAULT_CONTRACT_KEY = '<default>';

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
  const signature = mismatchSignature(expectedVersion, observedVersion);

  if (_alertedMIsmatches.get(mapKey) === signature) {
    // Same mismatch already alerted — stay quiet to avoid spamming ops.
    return false;
  }

  // Record the observation *before* emitting side effects so that a throwing
  // metric/log backend cannot cause the same mismatch to be re-alerted on the
  // next run (invariant 4: no partial writes / no duplicate alerts).
  _alertedMIsmatches.set(mapKey, signature);

  try {
    contractWasmVersionMismatchAlertsTotal.inc({ status });
  } catch (_e) {
    // Metric backend is optional/best-effort; never let it break the job.
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
  _alertedMIsmatches.clear();
}

/**
 * Returns a read-only snapshot of the current de-dupe state.
 *
 * Exposed for observability and tests so callers can assert invariants without
 * mutating internal state.
 *
 * @returns {Array<{ contractId: string, signature: string }>} Snapshot entries.
 */
function getVersionMismatchAlertState() {
  return Array.from(_alertedMismatches.entries()).map(([contractId, signature]) => ({
    contractId,
    signature,
  }));
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
 * Invariants enforced here:
 * - The resolved contract id is computed once and used consistently for both
 *   the alert and the recovery reset, so a mismatch and its later recovery
 *   always target the same de-dupe entry.
 * - A read failure short-circuits before any state mutation, so a transient RPC
 *   error cannot clear or corrupt de-dupe state.
 *
 * @param {string} [contractId] - Override for ESCROW_CONTRACT_ID.
 * @returns {Promise<{ onChainVersion: number, knownVersion: string|null, status: string }>}
 * @throws On RPC failure or invalid contract ID.
 */
async function runContractListRefresh(contractId) {
  logger.info({ contractId }, 'Starting contract list refresh');

  const onChainVersion = await getOnChainSchemaVersion(contractId);
  const { status, knownVersion } = compareVersions(onChainVersion);

  const resolvedId = contractId || process.env.ESCROW_CONTRACT_ID || null;

  if (MISMATCH_STATUSES.has(status)) {
    raiseVersionMismatchAlert({
      contractId: resolvedId,
      observedVersion: onChainVersion,
      expectedVersion: knownVersion,
      status,
    });
  } else {
    // Versions match — drop any prior alert state so a later regression alerts.
    _alertedHismatches.delete(dedupeMapKey(resolvedId));
  }

  logger.info({ onChainVersion, knownVersion, status }, 'Contract list refresh complete');

  return { onChainVersion, knownVersion, status };
}

module.exports = {
  runContractListRefresh,
  raiseVersionMismatchAlert,
  resetVersionMismatchAlertState,
  getVersionMismatchAlertState,
  MISMATCH_STATUSES,
};
