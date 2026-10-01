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

// ─── Boundary constants ────────────────────────────────────────────────────────
// Centralising limits here makes them easy to review and tune without hunting
// through the schema definition.

/** Minimum length for any secret/key that protects cryptographic operations. */
const SECRET_MIN_LENGTH = 32;

/** Port range accepted by the OS for unprivileged binding. */
const PORT_MIN = 1;
const PORT_MAX = 65535;

/** Soroban RPC concurrency: prevent runaway parallelism while allowing tuning. */
const SOROBAN_BATCH_CONCURRENCY_MIN = 1;
const SOROBAN_BATCH_CONCURRENCY_MAX = 50;

/** Soroban per-request timeout: 100 ms floor prevents zero/negative values;
 *  30 s ceiling prevents indefinite hangs. */
const SOROBAN_BATCH_TIMEOUT_MS_MIN = 100;
const SOROBAN_BATCH_TIMEOUT_MS_MAX = 30_000;

/** KYC transport knobs — mirrored from issue #592. */
const KYC_TIMEOUT_MS_MIN = 100;
const KYC_TIMEOUT_MS_MAX = 30_000;
const KYC_MAX_RETRIES_MIN = 0;
const KYC_MAX_RETRIES_MAX = 10;
const KYC_BASE_DELAY_MS_MIN = 0;
const KYC_BASE_DELAY_MS_MAX = 10_000;
const KYC_MAX_DELAY_MS_MIN = 0;
const KYC_MAX_DELAY_MS_MAX = 60_000;
const KYC_CB_FAILURE_THRESHOLD_MIN = 1;
const KYC_CB_FAILURE_THRESHOLD_MAX = 100;
const KYC_CB_RECOVERY_TIMEOUT_MS_MIN = 100;
const KYC_CB_RECOVERY_TIMEOUT_MS_MAX = 60_000;

/** Cursor TTL: at least 1 second; no upper bound mandated by schema. */
const CURSOR_TTL_SECONDS_MIN = 1;

/** Escrow stale threshold: at least 1 second. */
const ESCROW_INDEXER_STALE_THRESHOLD_SECONDS_MIN = 1;

// ─── Sub-schemas ───────────────────────────────────────────────────────────────

/**
 * Express-compatible request size string accepted by the `body-parser` package.
 * Examples: "512kb", "5mb", "1.5gb".
 * @type {z.ZodDefault<z.ZodString>}
 */
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

    // ── Server ──────────────────────────────────────────────────────────────
    PORT: z.coerce
      .number()
      .int({ message: 'PORT must be an integer.' })
      .min(PORT_MIN, { message: `PORT must be at least ${PORT_MIN}.` })
      .max(PORT_MAX, { message: `PORT must be at most ${PORT_MAX}.` })
      .default(3001),

    // ── Auth ─────────────────────────────────────────────────────────────────
    /** Minimum ${SECRET_MIN_LENGTH} chars. No default — must be explicitly set. */
    JWT_SECRET: z
      .string()
      .min(SECRET_MIN_LENGTH, {
        message: `JWT_SECRET must be at least ${SECRET_MIN_LENGTH} characters.`,
      }),

    /** Comma-separated algorithm allowlist, e.g. "HS256,RS256". */
    JWT_ALGORITHMS: z.string().optional().default('HS256'),

    /** Optional issuer claim to enforce on incoming JWTs. */
    JWT_ISSUER: z.string().optional(),

    /** Optional audience claim to enforce on incoming JWTs. */
    JWT_AUDIENCE: z.string().optional(),

    // ── Cursors ──────────────────────────────────────────────────────────────
    /** Dedicated marketplace cursor HMAC secret. Min ${SECRET_MIN_LENGTH} chars. */
    CURSOR_SECRET: z
      .string()
      .min(SECRET_MIN_LENGTH, {
        message: `CURSOR_SECRET must be at least ${SECRET_MIN_LENGTH} characters.`,
      })
      .optional(),

    CURSOR_TTL_ENABLED: z.enum(['true', 'false']).default('false'),

    CURSOR_TTL_SECONDS: z.coerce
      .number()
      .int({ message: 'CURSOR_TTL_SECONDS must be an integer.' })
      .min(CURSOR_TTL_SECONDS_MIN, {
        message: `CURSOR_TTL_SECONDS must be at least ${CURSOR_TTL_SECONDS_MIN}.`,
      })
      .default(3600),

    // ── CORS ─────────────────────────────────────────────────────────────────
    /** Comma-separated list of allowed origins. Optional (dev falls back to localhost). */
    CORS_ALLOWED_ORIGINS: z.string().optional(),

    // ── Soroban / Stellar ────────────────────────────────────────────────────
    SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),

    NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),

    /** Concurrent Soroban RPC requests: [${SOROBAN_BATCH_CONCURRENCY_MIN}, ${SOROBAN_BATCH_CONCURRENCY_MAX}]. */
    SOROBAN_BATCH_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(SOROBAN_BATCH_CONCURRENCY_MIN, {
        message: `SOROBAN_BATCH_CONCURRENCY must be at least ${SOROBAN_BATCH_CONCURRENCY_MIN}.`,
      })
      .max(SOROBAN_BATCH_CONCURRENCY_MAX, {
        message: `SOROBAN_BATCH_CONCURRENCY must be at most ${SOROBAN_BATCH_CONCURRENCY_MAX}.`,
      })
      .default(5),

    /** Per-batch Soroban timeout in ms: [${SOROBAN_BATCH_TIMEOUT_MS_MIN}, ${SOROBAN_BATCH_TIMEOUT_MS_MAX}]. */
    SOROBAN_BATCH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(SOROBAN_BATCH_TIMEOUT_MS_MIN, {
        message: `SOROBAN_BATCH_TIMEOUT_MS must be at least ${SOROBAN_BATCH_TIMEOUT_MS_MIN} ms.`,
      })
      .max(SOROBAN_BATCH_TIMEOUT_MS_MAX, {
        message: `SOROBAN_BATCH_TIMEOUT_MS must be at most ${SOROBAN_BATCH_TIMEOUT_MS_MAX} ms.`,
      })
      .default(5000),

    // ── Escrow indexer ───────────────────────────────────────────────────────
    /** Feature flag: enable the escrow event indexer. Safe default: disabled. */
    ESCROW_INDEXER_ENABLED: z.enum(['true', 'false']).default('false'),

    ESCROW_INDEXER_STALE_THRESHOLD_SECONDS: z.coerce
      .number()
      .int()
      .min(ESCROW_INDEXER_STALE_THRESHOLD_SECONDS_MIN, {
        message: `ESCROW_INDEXER_STALE_THRESHOLD_SECONDS must be at least ${ESCROW_INDEXER_STALE_THRESHOLD_SECONDS_MIN}.`,
      })
      .default(300),

    // ── Feature flags ────────────────────────────────────────────────────────
    /**
     * Gates the projection/cache-based escrow read path.
     * When "false", reads go directly to the Soroban contract (live read).
     */
    ESCROW_READ_PROJECTION_ENABLED: z.enum(['true', 'false']).default('true'),

    /**
     * Gates invoice state-transition endpoints.
     * When "false", the invoice state routes are not mounted (→ 404).
     */
    INVOICE_STATE_ENABLED: z.enum(['true', 'false']).default('true'),

    /**
     * Gates POST /api/admin/config and GET /api/admin/config/sections.
     * When "false", the router is not mounted (→ 404).
     */
    CONFIG_RUNTIME_ENABLED: z.enum(['true', 'false']).default('true'),

    // ── KYC provider ─────────────────────────────────────────────────────────
    /** KYC provider base URL. Must be paired with KYC_PROVIDER_API_KEY. */
    KYC_PROVIDER_URL: z.string().url().optional(),

    /** KYC API key. Must be paired with KYC_PROVIDER_URL. */
    KYC_PROVIDER_API_KEY: z.string().min(1).optional(),

    KYC_PROVIDER_SECRET: z.string().min(1).optional(),

    /** Per-request KYC timeout in ms: [${KYC_TIMEOUT_MS_MIN}, ${KYC_TIMEOUT_MS_MAX}]. */
    KYC_PROVIDER_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(KYC_TIMEOUT_MS_MIN, {
        message: `KYC_PROVIDER_TIMEOUT_MS must be at least ${KYC_TIMEOUT_MS_MIN} ms.`,
      })
      .max(KYC_TIMEOUT_MS_MAX, {
        message: `KYC_PROVIDER_TIMEOUT_MS must be at most ${KYC_TIMEOUT_MS_MAX} ms.`,
      })
      .default(5000),

    /** Max KYC retries: [${KYC_MAX_RETRIES_MIN}, ${KYC_MAX_RETRIES_MAX}]. */
    KYC_PROVIDER_MAX_RETRIES: z.coerce
      .number()
      .int()
      .min(KYC_MAX_RETRIES_MIN, {
        message: `KYC_PROVIDER_MAX_RETRIES must be at least ${KYC_MAX_RETRIES_MIN}.`,
      })
      .max(KYC_MAX_RETRIES_MAX, {
        message: `KYC_PROVIDER_MAX_RETRIES must be at most ${KYC_MAX_RETRIES_MAX}.`,
      })
      .default(3),

    /** KYC exponential-backoff base delay in ms: [${KYC_BASE_DELAY_MS_MIN}, ${KYC_BASE_DELAY_MS_MAX}]. */
    KYC_PROVIDER_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .min(KYC_BASE_DELAY_MS_MIN, {
        message: `KYC_PROVIDER_BASE_DELAY_MS must be at least ${KYC_BASE_DELAY_MS_MIN} ms.`,
      })
      .max(KYC_BASE_DELAY_MS_MAX, {
        message: `KYC_PROVIDER_BASE_DELAY_MS must be at most ${KYC_BASE_DELAY_MS_MAX} ms.`,
      })
      .default(200),

    /** KYC exponential-backoff max delay in ms: [${KYC_MAX_DELAY_MS_MIN}, ${KYC_MAX_DELAY_MS_MAX}]. */
    KYC_PROVIDER_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(KYC_MAX_DELAY_MS_MIN, {
        message: `KYC_PROVIDER_MAX_DELAY_MS must be at least ${KYC_MAX_DELAY_MS_MIN} ms.`,
      })
      .max(KYC_MAX_DELAY_MS_MAX, {
        message: `KYC_PROVIDER_MAX_DELAY_MS must be at most ${KYC_MAX_DELAY_MS_MAX} ms.`,
      })
      .default(5000),

    KYC_PROVIDER_SIGN_REQUESTS: z.enum(['true', 'false']).default('false'),
    KYC_PROVIDER_VERIFY_RESPONSE_SIGNATURE: z.enum(['true', 'false']).default('false'),

    /** KYC circuit-breaker failure threshold: [${KYC_CB_FAILURE_THRESHOLD_MIN}, ${KYC_CB_FAILURE_THRESHOLD_MAX}]. */
    KYC_PROVIDER_CB_FAILURE_THRESHOLD: z.coerce
      .number()
      .int()
      .min(KYC_CB_FAILURE_THRESHOLD_MIN, {
        message: `KYC_PROVIDER_CB_FAILURE_THRESHOLD must be at least ${KYC_CB_FAILURE_THRESHOLD_MIN}.`,
      })
      .max(KYC_CB_FAILURE_THRESHOLD_MAX, {
        message: `KYC_PROVIDER_CB_FAILURE_THRESHOLD must be at most ${KYC_CB_FAILURE_THRESHOLD_MAX}.`,
      })
      .default(5),

    /** KYC circuit-breaker recovery timeout in ms: [${KYC_CB_RECOVERY_TIMEOUT_MS_MIN}, ${KYC_CB_RECOVERY_TIMEOUT_MS_MAX}]. */
    KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(KYC_CB_RECOVERY_TIMEOUT_MS_MIN, {
        message: `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS must be at least ${KYC_CB_RECOVERY_TIMEOUT_MS_MIN} ms.`,
      })
      .max(KYC_CB_RECOVERY_TIMEOUT_MS_MAX, {
        message: `KYC_PROVIDER_CB_RECOVERY_TIMEOUT_MS must be at most ${KYC_CB_RECOVERY_TIMEOUT_MS_MAX} ms.`,
      })
      .default(10000),

    /** Feature flag: enable the KYC webhook ingestion path. Safe default: disabled. */
    KYC_WEBHOOK_ENABLED: z.enum(['true', 'false']).default('false'),

    // ── Public API surface ────────────────────────────────────────────────────
    /**
     * Public base URL for the API (used in OpenAPI spec).
     * Required in production; must use HTTPS; must not be a loopback address.
     */
    PUBLIC_API_BASE_URL: z.string().url().optional(),

    // ── Invoice upload ────────────────────────────────────────────────────────
    INVOICE_FILE_MAX_SIZE: InvoiceFileMaxSizeSchema,

    // ── Metrics ───────────────────────────────────────────────────────────────
    /**
     * Feature flag: enable Prometheus metrics collection and the /metrics endpoint.
     * When "false", all metric recording becomes a no-op and GET /metrics returns 503.
     */
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
  VALIDATION_BOUNDARIES,
};
