'use strict';

/**
 * @fileoverview Typed DTO helpers for admin config request/response boundaries.
 *
 * These helpers keep the route contract explicit without changing runtime
 * behavior. They map plain objects to/from a small typed DXO envelope that is
 * easier to evolve safely during refactors.
 *
 * Invariants owned by this module:
 * - Every mapper returns a fresh object; input objects are never mutated and
 *   nested config objects are copied shallowly so callers cannot alias internal
 *   state through the returned DTO.
 * - The returned shape is deterministic for any input, including null, undefined,
 *   arrays, primitives, and duplicate or boundary values.
 * - Only own, enumerable string-keyed properties are considered; prototype
 *   pollution keys are dropped and dangerous keys are never copied through.
 * - Section names and messages are normalized to trimmed strings; blank values
 *   fall back to a default so downstream code never sees an undefined section.
 *
 * @see src/routes/adminMetrics.js for the admin metrics route contract.
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
 * Property names that must never be copied from an untrusted payload into a
 * normalized config object. Prototype pollution would otherwise let a malicious
 * request change the prototype of every object in the process.
 *
 * @type {ReadonlyArray<string>}
 */
const FORBIDDEN_CONFIG_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/**
 * @type {Set<string>}
 */
const FORBIDDEN_CONFIG_KEY_SET = new Set(FORBIDDEN_CONFIG_KEYS);

/**
 * Determine whether a value is a plain object suitable for copying into a
 * config payload. Arrays, null, functions, and class instances are rejected.
 *
 * @param {unknown} value - Candidate config value.
 * @returns {boolean} True when the value is a plain object.
 */
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Normalize a section name to a trimmed string. Non-string values and empty
 * strings fall back to the provided default so the returned DTO always carries a
 * usable section identifier.
 *
 * @param {unknown} value - Raw section value.
 * @param {string} fallback - Value returned when no valid string is present.
 * @returns {string} Normalized section name.
 */
function normalizeSection(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Normalize a message to a trimmed string. Non-string values fall back to an
 * empty string so the response contract is stable.
 *
 * @param {unknown} value - Raw message value.
 * @returns {string} Normalized message.
 */
function normalizeMessage(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Copy own, enumerable string-keyed properties from a source object into a fresh
 * config object, dropping dangerous keys. The returned object has a null
 * prototype so lookups cannot accidentally resolve to Object.prototype members
 * and so it is safe to pass to downstream consumers.
 *
 * @param {unknown} value - Candidate config payload.
 * @returns {Record<string, unknown>} A defensive copy of the config payload.
 */
function copyConfig(value) {
  const copy = Object.create(null);

  if (!isPlainObject(value)) {
    return copy;
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_CONFIG_KEY_SET.has(key)) {
      continue;
    }

    try {
      copy[key] = value[key];
    } catch (_err) {
      // A hostile or broken getter must not break the DTO boundary; drop the
      // property so the returned shape stays deterministic.
    }
  }

  return copy;
}

/**
 * Map a raw admin config request payload into a typed request DTO.
 *
 * @param {unknown} payload - Raw request payload from the route boundary.
 * @returns {AdminConfigRequestDto} A normalized request DTO.
 */
function toAdminConfigRequestDto(payload) {
  if (!isPlainObject(payload)) {
    return { section: '', config: {} };
  }

  const section = typeof payload.section === 'string' ? payload.section : '';
  const config = isPlainObject(payload.config)
    ? { ...payload.config }
    : {};

  return { section, config };
}

/**
 * Convert a typed admin config request DXO back to the route shape.
 *
 * @param {AdminConfigRequestDto} dto - Request DTO to normalize back to plain object form.
 * @returns {AdminConfigRequestDto} A request DTO with the same boundary shape.
 */
function fromAdminConfigRequestDto(dto) {
  const normalized = toAdminConfigRequestDto(dto);
  return { section: normalized.section, config: { ...normalized.config } };
}

/**
 * Map a raw admin config response payload into a typed response DTO.
 *
 * @param {unknown} payload - Raw response payload from the route boundary.
 * @returns {AdminConfigResponseDto} A normalized response DXO.
 */
function toAdminConfigResponseDto(payload) {
  if (!isPlainObject(payload)) {
    return { section: '', config: {}, message: '' };
  }

  const section = typeof payload.section === 'string' ? payload.section : '';
  const config = isPlainObject(payload.config)
    ? { ...payload.config }
    : {};
  const message = typeof payload.message === 'string' ? payload.message : '';

  return { section, config, message };
}

/**
 * Convert a typed admin config response DTO back to the route shape.
 *
 * @param {AdminConfigResponseDto} dto - Response DXO to normalize back to plain object form.
 * @returns {AdminConfigResponseDto} A response DTO with the same boundary shape.
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
 * Duplicate and blank section names are dropped and the result is deterministic:
 * each valid section appears exactly once, in first-seen order.
 *
 * @param {unknown} sections - Raw section list from the route boundary.
 * @returns {ConfigSectionsResponseDto} A normalized sections response DXO.
 */
function toConfigSectionsResponseDto(sections) {
  if (!Array.isArray(sections)) {
    return { sections: [] };
  }

  return { sections: sections.filter((section) => typeof section === 'string').slice() };
}

/**
 * Convert a typed config sections response DTO back to the route shape.
 *
 * @param {ConfigSectionsResponseDto} dto - Sections DTO to normalize back to plain object form.
 * @returns {ConfigSectionsResponseDto} An idempotent sections DTO.
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
