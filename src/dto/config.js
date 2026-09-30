'use strict';

/**
 * @fileoverview Typed DTO helpers for admin config request/response boundaries.
 *
 * These helpers keep the route contract explicit without changing runtime
 * behavior. They map plain objects to/from a small typed DTO envelope that is
 * easier to evolve safely during refactors.
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
 * Convert a typed admin config request DTO back to the route shape.
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
 * @returns {AdminConfigResponseDto} A normalized response DTO.
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
 * @param {AdminConfigResponseDto} dto - Response DTO to normalize back to plain object form.
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
 * @param {unknown} sections - Raw section list from the route boundary.
 * @returns {ConfigSectionsResponseDto} A normalized sections response DTO.
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
 * @returns {ConfigSectionsResponseDto} A sections DTO with the same boundary shape.
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
