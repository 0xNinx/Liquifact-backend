/**
 * Centralized typed configuration module with runtime validation.
 * Uses Zod for schema validation and type safety.
 *
 * ## State invariants protected in this module
 *
 * 1. **Single initialization** — `validate()` may be called multiple times (e.g.
 *    during test setup) but the singleton is only replaced when parsing succeeds.
 *    A failed call leaves any previously-validated config in place and rethrows
 *    the error; it never partially overwrites the singleton.
 *
 * 2. **Immutability after validation** — the config object returned by `validate()`,
 *    `get()`, and `getValue()` is deeply frozen with `Object.freeze`. No caller can
 *    mutate a field on the singleton or add new keys to it.
 *
 * 3. **Consistent read access** — `get()` and `getValue()` throw a descriptive error
 *    if `validate()` has never been called successfully. There is no code path that
 *    returns `undefined` or a partial config.
 *
 * 4. **Validated-state query** — `isValidated()` allows callers to check whether the
 *    singleton has been initialised without triggering the guard error, which is
 *    useful in graceful-degradation paths and health checks.
 *
 * 5. **Test reset** — `_resetForTesting()` is provided for test suites that need
 *    module-level isolation. It is intentionally prefixed with `_` and must not be
 *    called in production paths.
 *
 * @module config
 */

const z = require('zod');

/** Express-compatible request size string. @type {z.ZodDefault<z.ZodString>} */
const InvoiceFileMaxSizeSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?(?:b|kb|mb|gb)$/i, {
    message: 'INVOICE_FILE_MAX_SIZE must be a size such as 512kb or 5mb.',
  })
  .default('5mb');

/**
 * Complete configuration schema with defaults and validation.
 * Secrets have no defaults - must be provided.
 * @type {z.ZodObject<any>}
 */
const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().min(1).max(65535).default(3001),
    JWT_SECRET: z.string().min(32), // No default for security
    JWT_ALGORITHMS: z.string().optional().default('HS256'), // Comma-separated allowlist, e.g. HS256,RS256
    JWT_ISSUER: z.string().optional(), // Optional issuer claim to enforce
    JWT_AUDIENCE: z.string().optional(), // Optional audience claim to enforce
    CURSOR_SECRET: z.string().min(32).optional(), // Dedicated marketplace cursor HMAC secret
    CURSOR_TTL_ENABLED: z.enum(['true', 'false']).default('false'),
    CURSOR_TTL_SECONDS: z.coerce.number().int().min(1).default(3600),
    CORS_ALLOWED_ORIGINS: z.string().optional(), // Comma-separated, optional for dev fallbacks
    SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
    NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
    SOROBAN_BATCH_CONCURRENCY: z.coerce.number().min(1).max(50).default(5),
    SOROBAN_BATCH_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    // Escrow indexer configuration
    ESCROW_INDEXER_ENABLED: z.enum(['true', 'false']).default('false'),
    ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: z.coerce.number().min(1).default(300),
    // Escrow read projection — gates the new projection/cache-based escrow read path
    ESCROW_READ_PROJECTION_ENABLED: z.enum(['true', 'false']).default('true'),
    // Invoice state machine — gates /api/invoices state-transition endpoints.
    // When 'false', the invoice state routes are not mounted so requests return 404.
    // Defaults to 'true' (enabled) to preserve existing behaviour.
    INVOICE_STATE_ENABLED: z.enum(['true', 'false']).default('true'),
    // Runtime admin config surface — gates POST /api/admin/config and
    // GET /api/admin/config/sections. When 'false' the router is not mounted
    // so requests return 404, allowing the surface to be disabled without a
    // deploy. Defaults to 'true' (enabled).
    CONFIG_RUNTIME_ENABLED: z.enum(['true', 'false']).default('true'),
    // KYC provider — all optional, but URL+key must be provided together in non-test envs
    KYC_PROVIDER_URL: z.string().url().optional(),
    KYC_PROVIDER_API_KEY: z.string().min(1).optional(),
    KYC_PROVIDER_SECRET: z.string().min(1).optional(),
    // Issue #592 — KYC provider transport hardening. Numeric knobs are clamped
    // so a typo cannot disable the timeout, exhaust retries, or hang the breaker.
    KYC_PROVIDER_TIMEOUT_MS: z.coerce.number().min(100).max(30000).default(5000),
    KYC_PROVIDER_MAX_RETRIES: z.coerce.number().min(0).max(10).default(3),
    KYC_PROVIDER_BASE_DELAY_MS: z.coerce.number().min(0).max(10000).default(200),
    KYC_PROVIDER_MAX_DELAY_MS: z.coerce.number().min(0).max(60000).default(5000),
    KYC_PROVIDER_SIGN_REQUESTS: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_CB_FAILURE_THRESHOLD: z.coerce.number().min(1).max(100).default(5),
    KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS: z.coerce.number().min(100).max(60000).default(10000),
    // KYC webhook ingestion feature flag — safe default: disabled
    KYC_WEBHOOK_ENABLED: z.enum(['true', 'false']).default('false'),
    // Public base URL for the API, used in the OpenAPI spec servers array.
    // Required in production and must use HTTPS. Falls back to localhost in development/test.
    PUBLIC_API_BASE_URL: z.string().url().optional(),
    INVOICE_FILE_MAX_SIZE: InvoiceFileMaxSizeSchema,
    // Feature flag: gates Prometheus metrics collection and the /metrics endpoint.
    // When 'false', all metric recording becomes a silent no-op and GET /metrics
    // returns 503. Default 'true' preserves existing behaviour.
    METRICS_ENABLED: z.enum(['true', 'false']).default('true'),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'test') { return; }
    if (data.NODE_ENV === 'production' && !data.CURSOR_SECRET && !data.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CURSOR_SECRET or JWT_SECRET must be configured in production.',
        path: ['CURSOR_SECRET'],
      });
    }
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
          message:
            'PUBLIC_API_BASE_URL must use HTTPS in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
        return;
      }
      const loopbackPattern = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$/i;
      if (loopbackPattern.test(parsed.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'PUBLIC_API_BASE_URL must not be a loopback address in production.',
          path: ['PUBLIC_API_BASE_URL'],
        });
      }
    }
  });

// ─── Singleton state ───────────────────────────────────────────────────────────

/**
 * Runtime validated configuration object.
 *
 * INVARIANT: once set, this reference points to a deeply frozen object. It is
 * only replaced by a successful call to `validate()`. A failed validation never
 * clears or partially overwrites this value.
 *
 * @type {Readonly<z.infer<typeof ConfigSchema>> | undefined}
 */
let config;

// ─── State-invariant helpers ──────────────────────────────────────────────────

/**
 * Returns `true` if `validate()` has been called successfully at least once
 * and the config singleton is available.
 *
 * Callers in graceful-degradation or health-check paths can use this to avoid
 * the guard error thrown by `get()` / `getValue()` before bootstrap completes.
 *
 * @returns {boolean}
 */
function isValidated() {
  return config !== undefined;
}

/**
 * Resets the module-level config singleton to `undefined`.
 *
 * **FOR TEST USE ONLY.** Production paths must never call this function.
 * Normally, test isolation is achieved by calling `jest.resetModules()` and
 * re-requiring the module. This helper exists for cases where the module has
 * already been required and the test needs to reset state without a full
 * module reload.
 *
 * @returns {void}
 */
function _resetForTesting() {
  config = undefined;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validates environment variables against the schema and returns a typed,
 * immutable config object.
 *
 * STATE INVARIANTS:
 *   - On success: the singleton is replaced with a new deeply-frozen object.
 *   - On failure: the singleton is left unchanged (a prior valid config survives
 *     a failed re-validation). The ZodError is rethrown without modification.
 *   - The returned object and the singleton are the same reference.
 *
 * Should be called once early in app bootstrap. Subsequent calls re-validate
 * `process.env` which is useful in test suites. Use `isValidated()` to check
 * readiness without triggering the guard error.
 *
 * @returns {Readonly<z.infer<typeof ConfigSchema>>} Validated, frozen config.
 * @throws {z.ZodError} If any environment variable fails validation.
 */
function validate() {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    // INVARIANT: do NOT assign to `config` on failure. The previous valid
    // config (if any) must remain accessible so callers that already hold a
    // reference to the module continue to operate correctly.
    throw parsed.error;
  }
  // Deeply freeze the result so no caller can mutate the singleton.
  config = Object.freeze(parsed.data);
  return config;
}

/**
 * Formats and logs a redacted summary of validation issues to `console.error`.
 * Never prints secret values — only key names and validation error messages.
 *
 * @param {z.ZodError | Error | null | undefined} error - The error to summarize.
 * @returns {void}
 */
function logRedactedSummary(error) {
  console.error('Configuration validation failed:');
  if (error && Array.isArray(error.issues)) {
    error.issues.forEach(issue => {
      const key = issue.path.join('.');
      console.error(`- [${key}]: ${issue.message}`);
    });
  } else {
    console.error(error ? error.message : 'Unknown configuration error');
  }
}

/**
 * Returns the validated configuration singleton.
 *
 * STATE INVARIANT: if `validate()` has never been called successfully, this
 * function throws rather than returning `undefined` or a partial object. This
 * ensures callers always receive a complete, validated config.
 *
 * @throws {Error} If `validate()` has not been called successfully yet.
 * @returns {Readonly<z.infer<typeof ConfigSchema>>}
 */
function get() {
  if (!config) {
    throw new Error('Config not validated. Call validate() first.');
  }
  return config;
}

/**
 * Returns a single value from the validated configuration singleton.
 *
 * @template {keyof z.infer<typeof ConfigSchema>} K
 * @param {K} key - Validated configuration key.
 * @returns {z.infer<typeof ConfigSchema>[K]} The validated value for the key.
 * @throws {Error} If `validate()` has not been called successfully yet.
 */
function getValue(key) {
  return get()[key];
}

/**
 * Returns the validated invoice PDF upload limit.
 *
 * Falls back to parsing `process.env.INVOICE_FILE_MAX_SIZE` directly when the
 * singleton is not yet initialised (e.g. during route construction before
 * bootstrap completes).
 *
 * @returns {string} Express-compatible request size limit (e.g. "5mb").
 */
function getInvoiceFileMaxSize() {
  if (config) {
    return config.INVOICE_FILE_MAX_SIZE;
  }
  return InvoiceFileMaxSizeSchema.parse(process.env.INVOICE_FILE_MAX_SIZE);
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
  // Less restrictive CSP for Swagger UI docs
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
  validate,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  isValidated,
  _resetForTesting,
  ConfigSchema,
  InvoiceFileMaxSizeSchema,
  securityHeaders,
};
