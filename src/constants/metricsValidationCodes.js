'use strict';

/**
 * @fileoverview Machine-readable error codes for metrics request validation.
 *
 * ## Why this exists
 * Before this module, a metrics validation failure returned only human-readable
 * strings in `fieldErrors` (e.g. `"tenantId must not exceed 128 characters"`).
 * Clients that wanted to react differently to a *type* error than to a *range*
 * error had to string-match those messages, which silently breaks whenever the
 * wording changes.
 *
 * Every metrics validation failure now carries a stable code from
 * {@link METRICS_VALIDATION_CODES}, both at the top level of the problem
 * document (`code`) and per-field (`fieldCodes`). Message wording remains free
 * to change; the codes are the contract.
 *
 * ## Determinism guarantees
 * The classification in {@link codeForIssue} is a pure function of the issue
 * object: it never consults mutable module state, the clock, or the network,
 * and it never throws. The same input always yields the same code, which is
 * what makes failure recovery replayable and observable.
 *
 * @defines {string} MetricsValidationCode
 * @module constants/metricsValidationCodes
 */

/**
 * Bounded set of per-issue validation codes.
 *
 * These describe *why a specific field failed*, and are reported in the
 * `fieldCodes` extension of the problem document.
 *
 * @param {string} MetricsValidationCode
 * @readonly
 * @enum {string}
 */
const METRICS_VALIDATION_CODES = Object.freeze({
  /** A required field was absent or `undefined`. */
  FIELD_REQUIRED: 'FIELD_REQUIRED',
  /** The field was present but of the wrong JSON type. */
  FIELD_TYPE_INVALID: 'FIELD_TYPE_INVALID',
  /** A string was shorter than the allowed minimum (includes empty strings). */
  FIELD_TOO_SHORT: 'FIELD_TOO_SHORT',
  /** A string exceeded its maximum allowed length. */
  FIELD_TOO_LONG: 'FIELD_TOO_LONG',
  /** A numeric value fell below the allowed minimum. */
  VALUE_BELOW_MINIMUM: 'VALUE_BELOW_MINIMUM',
  /** A numeric value exceeded the allowed maximum. */
  VALUE_ABOVE_MAXIMUM: 'VALUE_ABOVE_MAXIMUM',
  /** A numeric value was not an integer where one was required. */
  VALUE_NOT_INTEGER: 'VALUE_NOT_INTEGER',
  /** An array had fewer items than the allowed minimum. */
  ARRAY_TOO_SMALL: 'ARRAY_TOO_SMALL',
  /** An array exceeded the allowed maximum item count. */
  ARRAY_TOO_LARGE: 'ARRAY_TOO_LARGE',
  /** The payload contained a field not declared in the schema. */
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  /** A string did not match its required format/pattern. */
  FIELD_FORMAT_INVALID: 'FIELD_FORMAT_INVALID',
  /** Fallback for any issue not covered by a more specific code. */
  FIELD_INVALID: 'FIELD_INVALID',
});

/**
 * Top-level `code` used on the problem document for a metrics validation
 * failure. Distinct from the per-field codes above.
 *
 * @type {string}
 */
const METRICS_VALIDATION_ERROR_CODE = 'METRICS_VALIDATION_ERROR';

/**
 * Fast membership set over {@link METRICS_VALIDATION_CODES} values, used to
 * validate a schema-declared `params.metricsCode` before trusting it.
 *
 * @readonly
 * @type {Set<string>}
 */
const KNOWN_CODES = new Set(Object.values(METRICS_VALIDATION_CODES));

/**
 * Problem type URI for metrics validation failures.
 *
 * Kept identical to the pre-existing value so the wire format of `type` does
 * not change for current clients.
 *
 * @type {string}
 */
const METRICS_VALIDATION_PROBLEM_TYPE =
  'https://liquifact.io/problems/validation-error';

/**
 * Maximum length of a schema-declared code we will echo back. Bounds the
 * size of attacker-controlled input that can reach the wire format.
 *
 * @type {number}
 */
const MAX_CODE_LENGTH = 64;

/**
 * Normalises a schema-declared code into a known {@link METRICS_VALIDATION_CODES}
 * member, or `null` when it cannot be trusted.
 *
 * The check is deliberately exact-match and case-sensitive: a typo or a code
 * from a future version of this module degrades to the normal classification
 * rather than reaching the wire. This is the security boundary that stops
 * untrusted schema authors from injecting arbitrary codes into client
 * decision logic.
 *
 * @param {unknown} declared - Value of `issue.params.metricsCode`.
 * @returns {string|null} A canonical code, or `null`.
 */
function normaliseDeclaredCode(declared) {
  if (typeof declared !== 'string') {
    return null;
  }
  if (declared.length === 0 || declared.length > MAX_CODE_LENGTH) {
    return null;
  }
  return KNOWN_CODES.has(declared) ? declared : null;
}

/**
 * Maps a Zod issue to a stable {@link METRICS_VALIDATION_CODES} member.
 *
 * A schema raising a `custom` issue may declare its own code through
 * `params.metricsCode`; it is honoured only when it names a known code, so a
 * typo degrades to the normal classification rather than reaching the wire.
 *
 * Zod reports a missing field as an `invalid_type` issue whose `received` is
 * `'undefined', so that case is disambiguated into `FIELD_REQUIRED` before the
 * generic type branch. `too_small` / `too_big` are split by `origin` (Zod 4) or
 * `type` (Zod 3) so a 26-item array does not report the same code as a
 * 129-character string.
 *
 * The function is totally defensive: malformed issues (`null`, non-objects,
 * unknown codes) all degrade to `FIELD_INVALID` and never throw. That guarantee
 * is what allows the caller to classify a failure without a try/catch and
 * without losing the original error.
 *
 * @param {unknown} issue - A single issue from a `ZodError`.
 * @returns {string} A member of {@link METRICS_VALIDATION_CODES}.
 */
function codeForIssue(issue) {
  if (!issue || typeof issue !== 'object') {
    return METRICS_VALIDATION_CODES.FIELD_INVALID;
  }

  // A schema that raises a `custom` issue can name its own code via
  // `params.metricsCode`, so hand-rolled refinements are not flattened into
  // the generic FIELD_INVALID bucket.
  const declared =
    issue.params && typeof issue.params === 'object'
      ? issue.params.metricsCode
      : undefined;
  const normalised = normaliseDeclaredCode(declared);
  if (normalised !== null) {
    return normalised;
  }

  // Zod 4 renamed `type` to `origin` on size issues; support both.
  const origin = issue.origin || issue.type;

  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' || issue.input === undefined
        ? METRICS_VALIDATION_CODES.FIELD_REQUIRED
        : METRICS_VALIDATION_CODES.FIELD_TYPE_INVALID;

    case 'unrecognized_keys':
      return METRICS_VALIDATION_CODES.UNKNOWN_FIELD;

    case 'too_small':
      if (origin === 'array' || origin === 'set') {
        return METRICS_VALIDATION_CODES.ARRAY_TOO_SMALL;
      }
      if (origin === 'number' || origin === 'int' || origin === 'bigint') {
        return METRICS_VALIDATION_CODES.VALUE_BELOW_MINIMUM;
      }
      return METRICS_VALIDATION_CODES.FIELD_TOO_SHORT;

    case 'too_big':
      if (origin === 'array' || origin === 'set') {
        return METRICS_VALIDATION_CODES.ARRAY_TOO_LARGE;
      }
      if (origin === 'number' || origin === 'int' || origin === 'bigint') {
        return METRICS_VALIDATION_CODES.VALUE_ABOVE_MAXIMUM;
      }
      return METRICS_VALIDATION_CODES.FIELD_TOO_LONG;

    case 'not_multiple_of':
      return METRICS_VALIDATION_CODES.VALUE_NOT_INTEGER;

    case 'invalid_format':
    case 'invalid_string':
      return METRICS_VALIDATION_CODES.FIELD_FORMAT_INVALID;

    default:
      return METRICS_VALIDATION_CODES.FIELD_INVALID;
  }
}

/**
 * Classifies a whole `ZodError` into a deterministic, deduplicated list of
 * codes.
 *
 * This is the recovery primitive for the caller: given a failed validation,
 * it produces a stable set of codes that can be logged, metered, and returned
 * to the client without exposing the original messages (which may echo
 * untrusted input).
 *
 * Guarantees:
  - Never throws, even for `null`/`undefined`/malformed input.
  - Order is deterministic: first-seen order, duplicates removed.
  - Always returns at least one code so callers never have to handle an
    empty classification.
 *
 * @param {unknown} error - A `ZodError` or anything else.
 * @returns {string[]} Deduplicated members of {@link METRICS_VALIDATION_CODES}.
 */
function codesForError(error) {
  const issues =
    error && typeof error === 'object' && Array.isArray(error.issues)
      ? error.issues
      : [];

  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const code = codeForIssue(issue);
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }

  if (out.length === 0) {
    out.push(METRICS_VALIDATION_CODES.FIELD_INVALID);
  }

  return out;
}

module.exports = {
  METRICS_VALIDATION_CODES,
  METRICS_VALIDATION_ERROR_CODE,
  METRICS_VALIDATION_PROBLEM_TYPE,
  codeForIssue,
  codesForError,
  normaliseDeclaredCode,
};
