

/**
 * Tests for centralized config module.
 *
 * Covers:
 *  - #1302  Validation boundaries: accepted input, rejected input, boundary values,
 *           numeric range guards, boolean-flag strictness, cross-field invariants.
 */

const {
  validate,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  ConfigSchema,
  VALIDATION_BOUNDARIES,
} = require('./index');

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid env that passes all field-level and cross-field checks. */
const VALID_BASE = {
  NODE_ENV: 'development',
  JWT_SECRET: 'this-is-a-32-char-secret-for-testing-only-do-not-use-in-prod',
};

/** Minimal valid production env. */
const VALID_PROD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'valid-secret-at-least-32-chars-long-here',
  PUBLIC_API_BASE_URL: 'https://api.example.com',
};

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('Config Validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete require.cache[require.resolve('./index')];
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── Core / defaults ────────────────────────────────────────────────────────

  test('validates minimal config with defaults', () => {
    process.env.NODE_ENV = VALID_BASE.NODE_ENV;
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;

    const config = validate();
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3001);
    expect(config.JWT_SECRET).toBe(VALID_BASE.JWT_SECRET);
    expect(config.JWT_ISSUER).toBeUndefined();
    expect(config.JWT_AUDIENCE).toBeUndefined();
    expect(config.JWT_ALGORITHMS).toBe('HS256');
  });

  test('overrides defaults', () => {
    Object.assign(process.env, VALID_PROD, {
      PORT: '8080',
      JWT_ISSUER: 'custom-issuer',
      JWT_AUDIENCE: 'custom-audience',
      JWT_ALGORITHMS: 'HS256,HS384',
    });

    const config = validate();
    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('production');
    expect(config.JWT_ISSUER).toBe('custom-issuer');
    expect(config.JWT_AUDIENCE).toBe('custom-audience');
    expect(config.JWT_ALGORITHMS).toBe('HS256,HS384');
  });

  // ── #1302: JWT_SECRET boundary ────────────────────────────────────────────

  test('#1302 rejects JWT_SECRET shorter than minimum', () => {
    process.env.JWT_SECRET = 'too-short';
    expect(() => validate()).toThrow();
  });

  test('#1302 accepts JWT_SECRET exactly at minimum length', () => {
    process.env.JWT_SECRET = 'a'.repeat(VALIDATION_BOUNDARIES.SECRET_MIN_LENGTH);
    expect(() => validate()).not.toThrow();
  });

  test('#1302 accepts JWT_SECRET longer than minimum', () => {
    process.env.JWT_SECRET = 'a'.repeat(VALIDATION_BOUNDARIES.SECRET_MIN_LENGTH + 10);
    expect(() => validate()).not.toThrow();
  });

  // ── #1302: PORT boundary ──────────────────────────────────────────────────

  test('#1302 rejects non-numeric PORT', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.PORT = 'invalid';
    expect(() => validate()).toThrow();
  });

  test('#1302 rejects PORT below minimum (0)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.PORT = '0';
    expect(() => validate()).toThrow();
  });

  test('#1302 rejects PORT above maximum (65536)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.PORT = '65536';
    expect(() => validate()).toThrow();
  });

  test('#1302 accepts PORT at minimum boundary (1)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.PORT = String(VALIDATION_BOUNDARIES.PORT_MIN);
    const config = validate();
    expect(config.PORT).toBe(VALIDATION_BOUNDARIES.PORT_MIN);
  });

  test('#1302 accepts PORT at maximum boundary (65535)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.PORT = String(VALIDATION_BOUNDARIES.PORT_MAX);
    const config = validate();
    expect(config.PORT).toBe(VALIDATION_BOUNDARIES.PORT_MAX);
  });

  // ── #1302: NODE_ENV boundary ──────────────────────────────────────────────

  test('#1302 rejects invalid NODE_ENV', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.NODE_ENV = 'staging';
    expect(() => validate()).toThrow();
  });

  // ── #1302: Soroban numeric boundaries ────────────────────────────────────

  test('#1302 rejects SOROBAN_BATCH_CONCURRENCY below minimum (0)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.SOROBAN_BATCH_CONCURRENCY = '0';
    expect(() => validate()).toThrow();
  });

  test('#1302 rejects SOROBAN_BATCH_CONCURRENCY above maximum (51)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.SOROBAN_BATCH_CONCURRENCY = '51';
    expect(() => validate()).toThrow();
  });

  test('#1302 accepts SOROBAN_BATCH_CONCURRENCY at boundaries', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.SOROBAN_BATCH_CONCURRENCY = String(VALIDATION_BOUNDARIES.SOROBAN_BATCH_CONCURRENCY_MIN);
    expect(() => validate()).not.toThrow();

    delete require.cache[require.resolve('./index')];
    process.env.SOROBAN_BATCH_CONCURRENCY = String(VALIDATION_BOUNDARIES.SOROBAN_BATCH_CONCURRENCY_MAX);
    expect(() => validate()).not.toThrow();
  });

  test('#1302 rejects SOROBAN_BATCH_TIMEOUT_MS below minimum (99)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.SOROBAN_BATCH_TIMEOUT_MS = '99';
    expect(() => validate()).toThrow();
  });

  test('#1302 rejects SOROBAN_BATCH_TIMEOUT_MS above maximum (30001)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.SOROBAN_BATCH_TIMEOUT_MS = '30001';
    expect(() => validate()).toThrow();
  });

  // ── #1302: KYC numeric boundaries ────────────────────────────────────────

  test('#1302 rejects KYC_PROVIDER_TIMEOUT_MS below minimum (99)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.KYC_PROVIDER_TIMEOUT_MS = '99';
    expect(() => validate()).toThrow();
  });

  test('#1302 rejects KYC_PROVIDER_MAX_RETRIES above maximum (11)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.KYC_PROVIDER_MAX_RETRIES = '11';
    expect(() => validate()).toThrow();
  });

  test('#1302 accepts KYC_PROVIDER_MAX_RETRIES at 0 (no retries)', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.KYC_PROVIDER_MAX_RETRIES = '0';
    const config = validate();
    expect(config.KYC_PROVIDER_MAX_RETRIES).toBe(0);
  });

  test('#1302 rejects KYC_PROVIDER_CB_FAILURE_THRESHOLD below 1', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.KYC_PROVIDER_CB_FAILURE_THRESHOLD = '0';
    expect(() => validate()).toThrow();
  });

  test('#1302 rejects KYC_PROVIDER_CB_FAILURE_THRESHOLD above 100', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.KYC_PROVIDER_CB_FAILURE_THRESHOLD = '101';
    expect(() => validate()).toThrow();
  });

  // ── #1302: Boolean feature-flag strictness ────────────────────────────────

  test('#1302 rejects truthy-but-not-"true" values for ESCROW_READ_PROJECTION_ENABLED', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    for (const val of ['1', 'yes', 'TRUE', 'enabled', 'on']) {
      process.env.ESCROW_READ_PROJECTION_ENABLED = val;
      expect(() => validate()).toThrow();
      delete require.cache[require.resolve('./index')];
    }
  });

  test('#1302 rejects truthy-but-not-"true" values for CONFIG_RUNTIME_ENABLED', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    for (const val of ['1', 'yes', 'TRUE', 'enabled', 'on']) {
      process.env.CONFIG_RUNTIME_ENABLED = val;
      expect(() => validate()).toThrow();
      delete require.cache[require.resolve('./index')];
    }
  });

  test('#1302 rejects truthy-but-not-"true" values for METRICS_ENABLED', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    for (const val of ['1', 'yes', 'TRUE', 'enabled']) {
      process.env.METRICS_ENABLED = val;
      expect(() => validate()).toThrow();
      delete require.cache[require.resolve('./index')];
    }
  });

  // ── #1302: Feature flag defaults ──────────────────────────────────────────

  test('#1302 ESCROW_READ_PROJECTION_ENABLED defaults to "true"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    const config = validate();
    expect(config.ESCROW_READ_PROJECTION_ENABLED).toBe('true');
  });

  test('#1302 ESCROW_READ_PROJECTION_ENABLED accepts "false"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.ESCROW_READ_PROJECTION_ENABLED = 'false';
    const config = validate();
    expect(config.ESCROW_READ_PROJECTION_ENABLED).toBe('false');
  });

  test('#1302 ESCROW_READ_PROJECTION_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.ESCROW_READ_PROJECTION_ENABLED = 'invalid';
    expect(() => validate()).toThrow();
  });

  test('#1302 ESCROW_INDEXER_ENABLED defaults to "false"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    const config = validate();
    expect(config.ESCROW_INDEXER_ENABLED).toBe('false');
  });

  test('#1302 ESCROW_INDEXER_ENABLED accepts "true"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.ESCROW_INDEXER_ENABLED = 'true';
    const config = validate();
    expect(config.ESCROW_INDEXER_ENABLED).toBe('true');
  });

  test('#1302 ESCROW_INDEXER_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.ESCROW_INDEXER_ENABLED = 'yes';
    expect(() => validate()).toThrow();
  });

  test('#1302 CONFIG_RUNTIME_ENABLED defaults to "true"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    const config = validate();
    expect(config.CONFIG_RUNTIME_ENABLED).toBe('true');
  });

  test('#1302 CONFIG_RUNTIME_ENABLED accepts "false"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.CONFIG_RUNTIME_ENABLED = 'false';
    const config = validate();
    expect(config.CONFIG_RUNTIME_ENABLED).toBe('false');
  });

  test('#1302 CONFIG_RUNTIME_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.CONFIG_RUNTIME_ENABLED = 'invalid';
    expect(() => validate()).toThrow();
  });

  test('#1302 INVOICE_STATE_ENABLED defaults to "true"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    const config = validate();
    expect(config.INVOICE_STATE_ENABLED).toBe('true');
  });

  test('#1302 INVOICE_STATE_ENABLED accepts "false"', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.INVOICE_STATE_ENABLED = 'false';
    const config = validate();
    expect(config.INVOICE_STATE_ENABLED).toBe('false');
  });

  test('#1302 INVOICE_STATE_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.INVOICE_STATE_ENABLED = 'yes';
    expect(() => validate()).toThrow();
  });

  // ── #1302: Cross-field invariants ─────────────────────────────────────────

  test('#1302 rejects half-set KYC configuration in non-test env (URL without key)', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = VALID_PROD.JWT_SECRET;
    process.env.PUBLIC_API_BASE_URL = VALID_PROD.PUBLIC_API_BASE_URL;
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    delete process.env.KYC_PROVIDER_API_KEY;
    expect(() => validate()).toThrow(/KYC_PROVIDER_API_KEY/i);
  });

  test('#1302 rejects half-set KYC configuration in non-test env (key without URL)', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = VALID_PROD.JWT_SECRET;
    process.env.PUBLIC_API_BASE_URL = VALID_PROD.PUBLIC_API_BASE_URL;
    delete process.env.KYC_PROVIDER_URL;
    process.env.KYC_PROVIDER_API_KEY = 'some-key';
    expect(() => validate()).toThrow(/KYC_PROVIDER_URL/i);
  });

  test('#1302 allows half-set KYC configuration in test env', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    delete process.env.KYC_PROVIDER_API_KEY;
    const config = validate();
    expect(config.KYC_PROVIDER_URL).toBe('https://kyc.example.com');
    expect(config.KYC_PROVIDER_API_KEY).toBeUndefined();
  });

  // ── #1302: PUBLIC_API_BASE_URL production invariants ─────────────────────

  test('#1302 rejects missing PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = VALID_PROD.JWT_SECRET;
    delete process.env.PUBLIC_API_BASE_URL;
    expect(() => validate()).toThrow(/PUBLIC_API_BASE_URL must be set in production/i);
  });

  test('#1302 rejects non-HTTPS PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = VALID_PROD.JWT_SECRET;
    process.env.PUBLIC_API_BASE_URL = 'http://api.example.com';
    expect(() => validate()).toThrow(/must use HTTPS/i);
  });

  test('#1302 rejects loopback PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = VALID_PROD.JWT_SECRET;
    process.env.PUBLIC_API_BASE_URL = 'https://localhost:3001';
    expect(() => validate()).toThrow(/must not be a loopback address/i);
  });

  test('#1302 accepts a valid HTTPS non-loopback PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = VALID_PROD.JWT_SECRET;
    process.env.PUBLIC_API_BASE_URL = 'https://api.liquifact.com';
    const config = validate();
    expect(config.PUBLIC_API_BASE_URL).toBe('https://api.liquifact.com');
  });

  // ── Redacted summary ──────────────────────────────────────────────────────

  test('logRedactedSummary output does not contain secret values', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.JWT_SECRET = 'short';
    process.env.KYC_PROVIDER_API_KEY = 'some-secret-key-1234';

    let caughtError;
    try {
      validate();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    logRedactedSummary(caughtError);

    const loggedOutput = consoleSpy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(loggedOutput).toContain('JWT_SECRET');
    expect(loggedOutput).not.toContain('some-secret-key-1234');
    expect(loggedOutput).not.toContain('short');

    consoleSpy.mockRestore();
  });

  // ── get() / getValue() guards ─────────────────────────────────────────────

  test('get() throws if not validated', () => {
    jest.isolateModules(() => {
      const { get: getFresh } = require('./index');
      expect(() => getFresh()).toThrow(/validated/i);
    });
  });

  test('getValue() returns the correct field after validation', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    validate();
    expect(getValue('NODE_ENV')).toBe('development');
    expect(getValue('PORT')).toBe(3001);
  });

  // ── getInvoiceFileMaxSize ─────────────────────────────────────────────────

  test('getInvoiceFileMaxSize returns config value after validation', () => {
    process.env.JWT_SECRET = VALID_BASE.JWT_SECRET;
    process.env.INVOICE_FILE_MAX_SIZE = '1mb';
    validate();
    expect(getInvoiceFileMaxSize()).toBe('1mb');
  });

  test('getInvoiceFileMaxSize falls back to env var before validation', () => {
    jest.isolateModules(() => {
      process.env.INVOICE_FILE_MAX_SIZE = '512kb';
      const { getInvoiceFileMaxSize: fresh } = require('./index');
      expect(fresh()).toBe('512kb');
    });
  });

  // ── VALIDATION_BOUNDARIES export ──────────────────────────────────────────

  test('#1302 VALIDATION_BOUNDARIES is exported and frozen', () => {
    expect(VALIDATION_BOUNDARIES).toBeDefined();
    expect(Object.isFrozen(VALIDATION_BOUNDARIES)).toBe(true);
  });

  test('#1302 VALIDATION_BOUNDARIES contains all key limits', () => {
    expect(VALIDATION_BOUNDARIES.SECRET_MIN_LENGTH).toBe(32);
    expect(VALIDATION_BOUNDARIES.PORT_MIN).toBe(1);
    expect(VALIDATION_BOUNDARIES.PORT_MAX).toBe(65535);
    expect(VALIDATION_BOUNDARIES.SOROBAN_BATCH_CONCURRENCY_MIN).toBe(1);
    expect(VALIDATION_BOUNDARIES.SOROBAN_BATCH_CONCURRENCY_MAX).toBe(50);
    expect(VALIDATION_BOUNDARIES.KYC_MAX_RETRIES_MIN).toBe(0);
    expect(VALIDATION_BOUNDARIES.KYC_MAX_RETRIES_MAX).toBe(10);
  });

  // ── Schema direct usage ───────────────────────────────────────────────────

  test('schema type safety', () => {
    const result = ConfigSchema.parse({
      NODE_ENV: 'test',
      PORT: 3001,
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(result).toMatchObject({ NODE_ENV: 'test', PORT: 3001 });
  });
});
