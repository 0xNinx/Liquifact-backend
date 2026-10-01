'use strict';

/**
 * @fileoverview Typed DTO helpers for admin config request/response boundaries.
 *
 * These helpers keep the route contract explicit without changing runtime
 * behavior. They map plain objects to/from a small typed DXO envelope that is
 * easier to evolve safely during refactors.
 *
 * Invariants enforced here:
 *   - All inputs are validated defensively; no input can produce a thrown
 *     exception — malformed inputs produce safe zero-value defaults instead
 *     of propagating bad data downstream.
 *   - Output objects are shallow-frozen so callers cannot silently mutate the
 *     DTO after it leaves this layer, preventing cross-request state bleed
 *     in concurrent execution.
 *   - `config` payloads are always shallow-copied (never aliased) so the
 *     original request body cannot be mutated via the DTO reference.
 *   - String fields are type-checked and default to `''` rather than
 *     `undefined`, keeping downstream consumers free from null-checks.
 *
 * @module dto/config
 */

/**
 * Determine whether a value is a plain object (not null, not array).
 *
 * @param {unknown} value - Value to inspect.
 * @returns {boolean} True when the value is a non-null, non-array object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @typedef {Object} AdminConfigRequestDto
 * @property {string} section - Configuration section name.
 * @property {Record<string, unknown>} config - Section-specific configuration payload.
 */

/**
 * @typedef {Object} AdminConfigResponseDto
 * @property {string} section - Configuration section name.
 * @property {Record<string, unknown>} config - Accepted section payload.
 * @property {string} message - Human-readable success message.
 */

/**
 * @typedef {Object} ConfigSectionsResponseDto
 * @property {string[]} sections - Valid configuration section names.
 */

/**
 * Returns true when `value` is a plain (non-array, non-null) object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function _isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Map a raw admin config request payload into a typed request DTO.
 *
 * Defensive behaviour:
 *   - Non-object, null, or array payloads yield `{ section: '', config: {} }`.
 *   - A non-string `section` defaults to `''`.
 *   - A non-plain-object `config` defaults to `{}`.
 *   - The returned `config` is a **shallow copy**, so mutations to the original
 *     request body do not affect the DTO and vice-versa.
 *   - The returned DTO is **frozen** to prevent accidental downstream mutation.
 *
 * @param {unknown} payload - Raw request payload from the route boundary.
 * @returns {Readonly<AdminConfigRequestDto>} A normalized, immutable request DTO.
 */
function toAdminConfigRequestDto(payload) {
  if (!_isPlainObject(payload)) {
    return Object.freeze({ section: '', config: Object.freeze({}) });
  }

  const section = typeof payload.section === 'string' ? payload.section : '';
  const config = _isPlainObject(payload.config)
    ? Object.freeze({ ...payload.config })
    : Object.freeze({});

  return Object.freeze({ section, config });
}

/**
 * Convert a typed admin config request DXO back to the route shape.
 *
 * This function is symmetric with `toAdminConfigRequestDto` so that code
 * receiving a DTO can pass it back through the boundary without any asymmetry.
 * The same defensive normalisation and freeze are applied.
 *
 * @param {AdminConfigRequestDto} dto - Request DTO to normalize back to plain object form.
 * @returns {Readonly<AdminConfigRequestDto>} A request DTO with the same boundary shape.
 */
function fromAdminConfigRequestDto(dto) {
  const normalized = toAdminConfigRequestDto(dto);
  return { section: normalized.section, config: { ...normalized.config } };
}

/**
 * Map a raw admin config response payload into a typed response DTO.
 *
 * Defensive behaviour:
 *   - Non-object, null, or array payloads yield `{ section: '', config: {}, message: '' }`.
 *   - Non-string `section` / `message` default to `''`.
 *   - The returned `config` is a **shallow copy** and **frozen**.
 *   - The returned DTO is **frozen**.
 *
 * @param {unknown} payload - Raw response payload from the route boundary.
 * @returns {Readonly<AdminConfigResponseDto>} A normalized, immutable response DTO.
 */
function toAdminConfigResponseDto(payload) {
  if (!_isPlainObject(payload)) {
    return Object.freeze({ section: '', config: Object.freeze({}), message: '' });
  }

  const section = typeof payload.section === 'string' ? payload.section : '';
  const config = _isPlainObject(payload.config)
    ? Object.freeze({ ...payload.config })
    : Object.freeze({});
  const message = typeof payload.message === 'string' ? payload.message : '';

  return Object.freeze({ section, config, message });
}

/**
 * Convert a typed admin config response DTO back to the route shape.
 *
 * Symmetric with `toAdminConfigResponseDto`.
 *
 * @param {AdminConfigResponseDto} dto - Response DTO to normalize back to plain object form.
 * @returns {Readonly<AdminConfigResponseDto>} A response DTO with the same boundary shape.
 */
function fromAdminConfigResponseDto(dto) {
  const normalized = toAdminConfigResponseDto(dto);
  return {
    section: normalized.section,
    config: { ...normalized.config },
    message: normalized.message,
  };
}

/**
 * Map a list of config sections into the typed sections response DTO.
 *
 * Defensive behaviour:
 *   - Non-array input yields `{ sections: [] }`.
 *   - Non-string array elements are silently filtered out.
 *   - The inner array is **frozen** (a new array copy is always produced).
 *   - The returned DTO is **frozen**.
 *
 * @param {unknown} sections - Raw section list from the route boundary.
 * @returns {Readonly<ConfigSectionsResponseDto>} A normalized, immutable sections DTO.
 */
function toConfigSectionsResponseDto(sections) {
  if (!Array.isArray(sections)) {
    return Object.freeze({ sections: Object.freeze([]) });
  }

  const filtered = sections.filter((section) => typeof section === 'string');
  return Object.freeze({ sections: Object.freeze(filtered) });
}

/**
 * Convert a typed config sections response DTO back to the route shape.
 *
 * Accepts the DTO envelope `{ sections: [...] }` and re-normalises it,
 * producing a new frozen copy (so the caller's frozen reference is never
 * re-used directly).
 *
 * @param {ConfigSectionsResponseDto} dto - Sections DTO to normalize back to plain object form.
 * @returns {Readonly<ConfigSectionsResponseDto>} A sections DTO with the same boundary shape.
 */
function fromConfigSectionsResponseDto(dto) {
  const sections = isPlainObject(dto) ? dto.sections : undefined;
  return toConfigSectionsResponseDto(sections);
}

module.exports = {
  toAdminConfigRequestDto,
  fromAdminConfigRequestDto,
  toAdminConfigResponseDto,
  fromAdminConfigResponseDto,
  toConfigSectionsResponseDto,
  fromConfigSectionsResponseDto,
};
