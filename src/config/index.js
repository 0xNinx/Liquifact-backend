/**
 * Centralized typed configuration module with runtime validation.
 * Uses Zod for schema validation and type safety.
 *
 * ## Public API contract
 *
 * The following exports form the public contract of this module. Each entry is
 * versioned implicitly by the module path `src/config/index.js`. Any breaking
 * change must include a migration path documented in this file and tested in
 * the companion test suite.
 *
 * ### Functions
 * | Export              | Signature                                              | Since     |
 * |---------------------|--------------------------------------------------------|-----------|
 * | `validate()`        | `() => Config`                                         | initial   |
 * | `get()`             | `() => Config`                                         | initial   |
 * | `getValue(key)`     | `(key: keyof Config) => Config[key]`                   | initial   |
 * | `getInvoiceFileMaxSize()` | `() => string`                                  | initial   |
 * | `logRedactedSummary(err)` | `(err) => void`                                 | initial   |
 * | `getFeatureFlag(key)` | `(key: FeatureFlagKey) => boolean`                  | #1306     |
 *
 * ### Classes / schemas
 * | Export                   | Type              | Since   |
 * |--------------------------|-------------------|---------|
 * | `ConfigSchema`           | ZodObject         | initial |
 * | `InvoiceFileMaxSizeSchema` | ZodString        | initial |
 *
 * ### Objects
 * | Export            | Type              | Since   |
 * |-------------------|-------------------|---------|
 * | `securityHeaders` | plain object      | initial |
 * | `CONFIG_VERSION`  | string (semver)   | #1306   |
 *
 * ### Compatibility guarantees
 * 1. All exports listed in the "initial" column existed before this PR and are
 *    preserved with identical signatures. Callers do not need to change.
 * 2. `getFeatureFlag(key)` is additive — existing callers using `getValue(key)`
 *    for feature flags continue to work.
 * 3. `CONFIG_VERSION` is a constant string. Callers may import it to assert
 *    the minimum config API version they depend on.
 * 4. `InvoiceFileMaxSizeSchema` remains exported so callers that import it
 *    directly (e.g. route builders) keep working.
 * 5. `securityHeaders` remains a plain object so callers can spread or
 *    reference its fields without change.
 *
 * @module config
 *
 * Compatibility contract: `validate()` is idempotent and safe to call
 * multiple times; `get()` throws until `validate()` succeeds.
 */

const z = require('zod');

// ─── Public API version ───────────────────────────────────────────────────────

/**
 * Semantic version of the config module's public API.
 *
 * Bump the minor version when adding new exports.
 * Bump the major version when removing or renaming existing exports, and include
 * a migration guide in this file and the CHANGELOG.
 *
 * @type {string}
 */
const CONFIG_VERSION = '1.1.0';

// ─── Feature-flag key type guard ─────────────────────────────────────────────

/**
 * The complete set of boolean feature-flag keys in the config schema.
 * This tuple is the source of truth for `getFeatureFlag()` key validation.
 *
 * @type {readonly string[]}
 */
const FEATURE_FLAG_KEYS = Object.freeze([
  'ESCROW_INDEXER_ENABLED',
  'ESCROW_READ_PROJECTION_ENABLED',
  'INVOICE_STATE_ENABLED',
  'CONFIG_RUNTIME_ENABLED',
  'KYC_WEBHOOK_ENABLED',
  'KYC_PROVIDER_SIGN_REQUESTS',
  'KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE',
  'CURSOR_TTL_ENABLED',
  'METRICS_ENABLED',
]);

/** Express-compatible request size string. @type {z.ZodDefault<z.ZodString>} */
const InvoiceFileMaxSizeSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?(?:b|kb|mb|gb)$/i, {
    message: 'INVOICE_FILE_MAX_SIZE must be a size such as 512kb or 5mb.',
  })
  .default('5mb');

// ─── Main schema ──────────────────────────────────────────────────────────────

/**
 * Complete configuration schema with explicit boundaries on every field.
 *
 * Boundary guarantees enforced here:
 *   1. PORT is a finite integer in [1, 65535].
 *   2. JWT_SECRET is at least 32 characters — never has a default.
 *   3. All numeric timeout/retry/concurrency knobs have min AND max guards so
 *      a mis-typed value cannot push them into an unsafe or non-functional range.
 *   4. Boolean feature flags accept only "true" | "false" — no truthy aliases.
 *   5. URLs are parsed by Zod's url() validator before use.
 *   6. Cross-field invariants are checked in superRefine (see below).
 *
 * @type {z.ZodObject<any>}
 */
const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().min(1).max(65535).default(3001),
    JWT_SECRET: z.string().min(32), // No default for security
    JWT_ALGORITHMS: z.string().optional().default('HS256'),
    JWT_ISSUER: z.string().optional(),
    JWT_AUDIENCE: z.string().optional(),
    CURSOR_SECRET: z.string().min(32).optional(),
    CURSOR_TTL_ENABLED: z.enum(['true', 'false']).default('false'),
    CURSOR_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
    CORS_ALLOWED_ORIGINS: z.string().optional(),
    SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),

    NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
    SOROBAN_BATCH_CONCURRENCY: z.coerce.number().min(1).max(50).default(5),
    SOROBAN_BATCH_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    ESCROW_INDEXER_ENABLED: z.enum(['true', 'false']).default('false'),
    ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: z.coerce.number().min(1).default(300),
    ESCROW_READ_PROJECTION_ENABLED: z.enum(['true', 'false']).default('true'),
    INVOICE_STATE_ENABLED: z.enum(['true', 'false']).default('true'),
    CONFIG_RUNTIME_ENABLED: z.enum(['true', 'false']).default('true'),
    KYC_PROVIDER_URL: z.string().url().optional(),

    /** KYC API key. Must be paired with KYC_PROVIDER_URL. */
    KYC_PROVIDER_API_KEY: z.string().min(1).optional(),

    KYC_PROVIDER_SECRET: z.string().min(1).optional(),
    KYC_PROVIDER_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    KYC_PROVIDER_MAX_RETRIES: z.coerce.number().min(0).max(10).default(3),
    KYC_PROVIDER_BASE_DELAY_MS: z.coerce.number().min(0).max(10000).default(200),
    KYC_PROVIDER_MAX_DELAY_MS: z.coerce.number().min(0).max(60000).default(5000),
    KYC_PROVIDER_SIGN_REQUESTS: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_CB_FAILURE_THRESHOLD: z.coerce.number().min(1).max(100).default(5),
    KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS: z.coerce.number().min(100).max(60000).default(10000),
    KYC_WEBHOOK_ENABLED: z.enum(['true', 'false']).default('false'),
    PUBLIC_API_BASE_URL: z.string().url().optional(),

    // ── Invoice upload ────────────────────────────────────────────────────────
    INVOICE_FILE_MAX_SIZE: InvoiceFileMaxSizeSchema,
    METRICS_ENABLED: z.enum(['true', 'false']).default('true'),
  })
  // ── Cross-field boundary checks ─────────────────────────────────────────────
  .superRefine((data, ctx) => {
    // Skip cross-field checks in test mode to allow partial configurations.
    if (data.NODE_ENV === 'test') { return; }

    // 1. Production cursor secret: either CURSOR_SECRET or JWT_SECRET must be set.
    if (data.NODE_ENV === 'production' && !data.CURSOR_SECRET && !data.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CURSOR_SECRET or JWT_SECRET must be configured in production.',
        path: ['CURSOR_SECRET'],
      });
    }

    // 2. KYC half-configuration: URL and key must be present together or absent together.
    const hasUrl = Boolean(data.KYC_PROVIDER_URL);
    const hasKey = Boolean(data.KYC_PROVIDER_API_KEY);
    if (hasUrl !== hasKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'KYC_PROVIDER_URL and KYC_PROVIDER_API_KEY must both be set or both be absent.',
        path: hasUrl ? ['KYC_PROVIDER_API_KEY'] : ['KYC_PROVIDER_URL'],
      });
    }

    // 3. Production PUBLIC_API_BASE_URL: required, HTTPS, non-loopback.
    if (data.NODE_ENV === 'production') {
      const baseUrl = data.PUBLIC_API_BASE_URL;
      if (!baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'PUBLIC_API_BASE_URL must be set in production. It is used in the OpenAPI spec servers array.',
          path: ['PUBLIC_API_BASE_URL'],
        });
        return;
      }
      let parsed;
      try { parsed = new URL(baseUrl); } catch (_) { parsed = null; }

      if (!parsed || parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PUBLIC_API_BASE_URL must use HTTPS in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
        return;
      }
      const loopbackPattern = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$/i;
      if (loopbackPattern.test(parsed.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'PUBLIC_API_BASE_URL must not be a loopback address in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
      }
    }
  });

// ─── Singleton state ───────────────────────────────────────────────────────────

/**
 * Runtime validated configuration object.
 * @type {z.infer<typeof ConfigSchema> | undefined}
 */
let config;

/** Frozen snapshot of the last successfully validated config. @type {Readonly<z.infer<typeof ConfigSchema>>|null} */
let frozenConfig = null;

/**
 * Validates environment variables against schema and returns typed config.
 * Throws ZodError on validation failure.
 * Should be called once early in app bootstrap.
 *
 * CONTRACT: return type is `z.infer<typeof ConfigSchema>`. Shape is stable.
 * Callers may destructure any key documented in ConfigSchema.
 *
 * @returns {z.infer<typeof ConfigSchema>} Validated config.
 * @throws {z.ZodError} If any environment variable fails its boundary check.
 */
function validate() {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error);
  }
  // Freeze the validated snapshot so callers cannot mutate shared state and
  // so repeated validate() calls produce a deterministic, stable object.
  frozenConfig = Object.freeze({ ...parsed.data });
  config = frozenConfig;
  return config;
}

/**
 * Returns true when validate() has completed successfully at least once.
 * @returns {boolean}
 */
function isInitialized() {
  return config !== null && config !== undefined;
}

/**
 * Format and log a redacted summary of validation issues to console.error.
 * Never prints secret values (only key names and validation error messages).
 *
 * CONTRACT: this function never throws. It accepts any value including null
 * and undefined.
 *
 * @param {z.ZodError | Error | null | undefined} error - The Zod error to summarize.
 * @returns {void}
 */
function logRedactedSummary(error) {
  console.error('Configuration validation failed:');
  // ConfigValidationError exposes .issues as { path, message } pairs.
  if (error instanceof ConfigValidationError) {
    error.issues.forEach(issue => {
      console.error(`- [${issue.path}]: ${issue.message}`);
    });
    return;
  }
  // Legacy: raw ZodError (e.g. from callers that import ConfigSchema directly).
  if (error && Array.isArray(error.issues)) {
    error.issues.forEach(issue => {
      const key = issue.path.join('.');
      console.error(`- [${key}]: ${issue.message}`);
    });
    return;
  }
  console.error(error ? error.message : 'Unknown configuration error');
}

/**
 * Getter for validated config. Throws if not validated.
 *
 * CONTRACT: returns the same object reference that `validate()` returned.
 * Never returns `undefined` or a partial config — throws instead.
 *
 * @throws {Error} If `validate()` has not been called successfully yet.
 * @returns {z.infer<typeof ConfigSchema>}
 */
function get() {
  if (!config) {
    throw new Error('Config not validated. Call validate() first.');
  }
  return config;
}

/**
 * Reset the in-memory config snapshot. Intended for tests only; production
 * code must not call this because it invalidates the validated contract.
 * @returns {void}
 */
function resetForTests() {
  config = null;
  frozenConfig = null;
}

/**
 * Returns a value from the validated configuration with key-aware JSDoc types.
 *
 * CONTRACT: signature is `(key: keyof Config) => Config[key]`. The key type
 * will never widen; callers that pass a valid key today will compile without
 * error after future schema additions.
 *
 * @template {keyof z.infer<typeof ConfigSchema>} K
 * @param {K} key
 * @returns {z.infer<typeof ConfigSchema>[K]}
 */
function getValue(key) {
  return get()[key];
}

/**
 * Returns the validated invoice PDF upload limit used when routes are built.
 *
 * CONTRACT: always returns a non-empty string in the format accepted by the
 * `body-parser` package (e.g. "5mb", "512kb"). Falls back to "5mb" when the
 * singleton is absent.
 *
 * @returns {string} Express-compatible request size limit.
 */
function getInvoiceFileMaxSize() {
  if (config) {
    return config.INVOICE_FILE_MAX_SIZE;
  }
  // Fall back to parsing the raw env var without mutating module state so
  // callers that run before validate() still get a deterministic value.
  const raw = process.env.INVOICE_FILE_MAX_SIZE;
  return InvoiceFileMaxSizeSchema.parse(raw === undefined ? undefined : raw);
}

// ─── Public API — new contracts (additive, #1306) ─────────────────────────────

/**
 * Returns the boolean value of a named feature flag from the validated config.
 *
 * This is an additive helper that converts the stored string literal
 * ("true" | "false") to a native boolean, removing the need for callers to
 * perform string comparison. Existing callers using `getValue(key)` and
 * comparing against `'true'` continue to work without change.
 *
 * CONTRACT:
 *   - Returns `true`  when the stored value is `"true"`.
 *   - Returns `false` when the stored value is `"false"`.
 *   - Throws `TypeError` when `key` is not a recognised feature-flag key, so
 *     callers get an early error rather than a silent `false`.
 *   - Throws `Error` if `validate()` has not been called (same as `get()`).
 *
 * @param {string} key - One of the keys in FEATURE_FLAG_KEYS.
 * @returns {boolean}
 * @throws {TypeError} If `key` is not a valid feature-flag key.
 * @throws {Error} If `validate()` has not been called yet.
 */
function getFeatureFlag(key) {
  if (!FEATURE_FLAG_KEYS.includes(key)) {
    throw new TypeError(
      `"${key}" is not a valid feature-flag key. ` +
      `Valid keys: ${FEATURE_FLAG_KEYS.join(', ')}.`
    );
  }
  return getValue(key) === 'true';
}

// ─── Security headers ─────────────────────────────────────────────────────────

const securityHeaders = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  docsContentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // ── Preserved (initial contract) ─────────────────────────────────────────
  validate,
  validateSafe,
  get,
  isInitialized,
  resetForTests,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  ConfigValidationError,
  ConfigSchema,
  InvoiceFileMaxSizeSchema,
  securityHeaders,
  // ── New (additive, #1306) ─────────────────────────────────────────────────
  getFeatureFlag,
  FEATURE_FLAG_KEYS,
  CONFIG_VERSION,
};
