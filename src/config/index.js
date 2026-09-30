/**
 * Centralized typed configuration module with runtime validation.
 * Uses Zod for schema validation and type safety.
 *
 * ## Failure recovery model
 *
 * Every failure path in this module is deterministic and observable:
 *
 * 1. **`validateSafe()`** — non-throwing variant of `validate()`. Returns a
 *    discriminated-union result `{ ok: true, config }` or
 *    `{ ok: false, error: ConfigValidationError }` so callers can recover
 *    gracefully without a try/catch.
 *
 * 2. **`ConfigValidationError`** — structured error class that wraps the raw
 *    ZodError. Exposes `.issues` (array of `{ path, message }` pairs) and a
 *    `.code` of `'CONFIG_VALIDATION_ERROR'` for programmatic handling.
 *    Secret values are never stored on the error object.
 *
 * 3. **`logRedactedSummary()`** — writes only key names and schema messages to
 *    `console.error`; raw env-var values are never emitted.
 *
 * 4. **`validate()`** — still throws (as before) for the boot-time fail-fast
 *    path. When it throws it always throws a `ConfigValidationError`, never a
 *    bare ZodError, so the error type is stable and catchable.
 *
 * 5. **`getInvoiceFileMaxSize()`** — falls back to a safe default if the
 *    singleton is not yet initialised and the env var is missing or invalid,
 *    so route construction never throws in recovery paths.
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
    INVOICE_FILE_MAX_SIZE: InvoiceFileMaxSizeSchema,
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

// ─── Structured error class ────────────────────────────────────────────────────

/**
 * Structured error thrown by `validate()` and returned by `validateSafe()`.
 *
 * Wraps a ZodError and exposes a stable, typed interface:
 *   - `.code` — always `'CONFIG_VALIDATION_ERROR'`; safe to use in catch blocks
 *     and error-reporting middleware without inspecting the message string.
 *   - `.issues` — array of `{ path: string, message: string }` pairs extracted
 *     from the ZodError; contains only key names and schema messages, never raw
 *     env-var values.
 *   - `.cause` — the original ZodError for callers that need the full detail.
 *
 * @example
 * try {
 *   validate();
 * } catch (err) {
 *   if (err.code === 'CONFIG_VALIDATION_ERROR') {
 *     err.issues.forEach(i => logger.error({ key: i.path, msg: i.message }));
 *   }
 * }
 */
class ConfigValidationError extends Error {
  /**
   * @param {z.ZodError} zodError - The raw Zod validation error.
   */
  constructor(zodError) {
    // Build a human-readable summary message from the issue paths.
    const summary = zodError.issues
      .map(i => `[${i.path.join('.')}]: ${i.message}`)
      .join('; ');
    super(`Configuration validation failed: ${summary}`);

    this.name = 'ConfigValidationError';

    /**
     * Stable machine-readable code for programmatic error handling.
     * @type {'CONFIG_VALIDATION_ERROR'}
     */
    this.code = 'CONFIG_VALIDATION_ERROR';

    /**
     * Structured list of validation failures.
     * Each entry contains only the key path and the schema message —
     * raw environment variable values are never included.
     * @type {Array<{ path: string, message: string }>}
     */
    this.issues = zodError.issues.map(i => ({
      path: i.path.join('.'),
      message: i.message,
    }));

    /**
     * The original ZodError for callers that need full Zod detail.
     * @type {z.ZodError}
     */
    this.cause = zodError;

    // Maintain a proper prototype chain in transpiled environments.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigValidationError);
    }
  }
}

// ─── Singleton state ───────────────────────────────────────────────────────────

/**
 * Runtime validated configuration object.
 * @type {z.infer<typeof ConfigSchema> | undefined}
 */
let config;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validates environment variables against the schema and returns a typed config.
 *
 * Throws `ConfigValidationError` on failure — never a raw ZodError — so the
 * error type is stable and catchable in all recovery paths.
 *
 * @returns {z.infer<typeof ConfigSchema>} Validated config.
 * @throws {ConfigValidationError} If any environment variable fails validation.
 */
function validate() {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error);
  }
  config = Object.freeze(parsed.data);
  return config;
}

/**
 * Non-throwing variant of `validate()`. Returns a discriminated-union result
 * so callers can handle failure without a try/catch.
 *
 * Recovery guarantee: this function never throws. On a parse failure it returns
 * `{ ok: false, error }` where `error` is a `ConfigValidationError`. The
 * singleton is not modified on failure — any previously-valid config survives.
 *
 * @returns {{ ok: true, config: z.infer<typeof ConfigSchema> } |
 *           { ok: false, error: ConfigValidationError }}
 */
function validateSafe() {
  try {
    const cfg = validate();
    return { ok: true, config: cfg };
  } catch (err) {
    // validate() always throws ConfigValidationError, but guard for safety.
    const wrapped =
      err instanceof ConfigValidationError
        ? err
        : new ConfigValidationError(
            Object.assign(new Error(err.message), { issues: [] })
          );
    return { ok: false, error: wrapped };
  }
}

/**
 * Formats and logs a redacted summary of validation issues to `console.error`.
 *
 * Accepts both `ConfigValidationError` (preferred) and raw `ZodError` for
 * backwards compatibility. Secret values are never printed.
 *
 * @param {ConfigValidationError | z.ZodError | Error | null | undefined} error
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
 * Returns the validated configuration singleton.
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
 * Returns a single value from the validated configuration singleton.
 *
 * @template {keyof z.infer<typeof ConfigSchema>} K
 * @param {K} key
 * @returns {z.infer<typeof ConfigSchema>[K]}
 */
function getValue(key) {
  return get()[key];
}

/**
 * Returns the validated invoice PDF upload limit.
 *
 * Falls back gracefully to a safe default when:
 *   a) the singleton is not yet initialised, AND
 *   b) INVOICE_FILE_MAX_SIZE is missing or invalid in process.env.
 *
 * This prevents route construction from throwing during recovery paths where
 * the app is starting up but env is not yet fully populated.
 *
 * @returns {string} Express-compatible request size limit (e.g. "5mb").
 */
function getInvoiceFileMaxSize() {
  if (config) {
    return config.INVOICE_FILE_MAX_SIZE;
  }
  // Safe fallback: if the env var is missing or invalid, return the schema default.
  const result = InvoiceFileMaxSizeSchema.safeParse(process.env.INVOICE_FILE_MAX_SIZE);
  return result.success ? result.data : InvoiceFileMaxSizeSchema.parse(undefined);
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
  validate,
  validateSafe,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  ConfigValidationError,
  ConfigSchema,
  InvoiceFileMaxSizeSchema,
  securityHeaders,
};
