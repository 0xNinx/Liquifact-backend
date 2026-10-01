

/**
 * Tests for centralized config module — #1304 Make failure recovery deterministic.
 *
 * Covers:
 *  - validateSafe() returns { ok, config } or { ok, error } — never throws
 *  - ConfigValidationError: code, issues structure, no secret leakage
 *  - validate() throws ConfigValidationError (not raw ZodError)
 *  - logRedactedSummary handles ConfigValidationError and ZodError
 *  - getInvoiceFileMaxSize() falls back safely when env is missing/invalid
 *  - All original regression tests preserved
 */

const {
  validate,
  validateSafe,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  ConfigValidationError,
  ConfigSchema,
  VALIDATION_BOUNDARIES,
} = require('./index');

// ─── Helpers ───────────────────────────────────────────────────────────────────

const VALID_JWT = 'valid-secret-at-least-32-chars-long-here';

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('Config — failure recovery (#1304)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── ConfigValidationError structure ───────────────────────────────────────

  test('validate() throws ConfigValidationError (not a raw ZodError)', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validate: v, ConfigValidationError: CVE } = require('./index');
      let caught;
      try { v(); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(CVE);
      expect(caught.name).toBe('ConfigValidationError');
    });
  });

  test('ConfigValidationError has stable .code = "CONFIG_VALIDATION_ERROR"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validate: v, ConfigValidationError: CVE } = require('./index');
      let err;
      try { v(); } catch (e) { err = e; }
      expect(err.code).toBe('CONFIG_VALIDATION_ERROR');
    });
  });

  test('ConfigValidationError.issues is an array of { path, message }', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validate: v } = require('./index');
      let err;
      try { v(); } catch (e) { err = e; }
      expect(Array.isArray(err.issues)).toBe(true);
      expect(err.issues.length).toBeGreaterThan(0);
      err.issues.forEach(issue => {
        expect(typeof issue.path).toBe('string');
        expect(typeof issue.message).toBe('string');
      });
    });
  });

  test('ConfigValidationError.issues does not contain raw secret values', () => {
    jest.isolateModules(() => {
      const secretValue = 'my-real-secret-do-not-leak';
      process.env.JWT_SECRET = secretValue; // too short but contains the value
      const { validate: v } = require('./index');
      let err;
      try { v(); } catch (e) { err = e; }
      const issueText = JSON.stringify(err.issues);
      expect(issueText).not.toContain(secretValue);
    });
  });

  test('ConfigValidationError.cause is the original ZodError', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validate: v, ConfigValidationError: CVE } = require('./index');
      let err;
      try { v(); } catch (e) { err = e; }
      expect(err.cause).toBeDefined();
      expect(typeof err.cause.issues).toBe('object');
    });
  });

  test('ConfigValidationError has a readable .message', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validate: v } = require('./index');
      let err;
      try { v(); } catch (e) { err = e; }
      expect(err.message).toMatch(/Configuration validation failed/i);
      expect(err.message).toContain('JWT_SECRET');
    });
  });

  // ── validateSafe() — success path ─────────────────────────────────────────

  test('validateSafe() returns { ok: true, config } on valid env', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validateSafe: vs } = require('./index');
      const result = vs();
      expect(result.ok).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.config.JWT_SECRET).toBe(VALID_JWT);
      expect(result.error).toBeUndefined();
    });
  });

  test('validateSafe() returns frozen config on success', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validateSafe: vs } = require('./index');
      const { config: cfg } = vs();
      expect(Object.isFrozen(cfg)).toBe(true);
    });
  });

  // ── validateSafe() — failure path ─────────────────────────────────────────

  test('validateSafe() returns { ok: false, error } on invalid env', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validateSafe: vs } = require('./index');
      const result = vs();
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.config).toBeUndefined();
    });
  });

  test('validateSafe() never throws — not even on completely broken env', () => {
    jest.isolateModules(() => {
      // Remove all env vars to maximise the number of failures.
      process.env = {};
      const { validateSafe: vs } = require('./index');
      expect(() => vs()).not.toThrow();
      const result = vs();
      expect(result.ok).toBe(false);
    });
  });

  test('validateSafe() error is a ConfigValidationError', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validateSafe: vs, ConfigValidationError: CVE } = require('./index');
      const { error } = vs();
      expect(error).toBeInstanceOf(CVE);
      expect(error.code).toBe('CONFIG_VALIDATION_ERROR');
    });
  });

  test('validateSafe() error.issues contains the expected failing key', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validateSafe: vs } = require('./index');
      const { error } = vs();
      const paths = error.issues.map(i => i.path);
      expect(paths).toContain('JWT_SECRET');
    });
  });

  test('validateSafe() does not modify the singleton on failure', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const mod = require('./index');

      // Establish a valid singleton.
      mod.validateSafe();
      const first = mod.get();

      // Break env and try again.
      process.env.JWT_SECRET = 'short';
      const result = mod.validateSafe();
      expect(result.ok).toBe(false);

      // Singleton unchanged.
      expect(mod.get()).toBe(first);
    });
  });

  // ── Repeated failures (retry simulation) ──────────────────────────────────

  test('calling validateSafe() repeatedly with bad env always returns ok: false', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const { validateSafe: vs } = require('./index');
      for (let i = 0; i < 5; i++) {
        const r = vs();
        expect(r.ok).toBe(false);
      }
    });
  });

  test('validateSafe() succeeds after env is fixed (recovery simulation)', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short';
      const mod = require('./index');

      // First attempt fails.
      expect(mod.validateSafe().ok).toBe(false);

      // Fix the env (simulate operator correcting the value).
      process.env.JWT_SECRET = VALID_JWT;

      // Recovery succeeds.
      const result = mod.validateSafe();
      expect(result.ok).toBe(true);
      expect(result.config.JWT_SECRET).toBe(VALID_JWT);
    });
  });

  // ── logRedactedSummary ────────────────────────────────────────────────────

  test('logRedactedSummary handles ConfigValidationError without leaking secrets', () => {
    jest.isolateModules(() => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const secretValue = 'ultra-secret-key-99999';
      process.env.JWT_SECRET = secretValue;
      const { validate: v, logRedactedSummary: lrs } = require('./index');

      let err;
      try { v(); } catch (e) { err = e; }
      lrs(err);

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('JWT_SECRET');
      expect(output).not.toContain(secretValue);
      consoleSpy.mockRestore();
    });
  });

  test('logRedactedSummary handles raw ZodError (backwards compat)', () => {
    jest.isolateModules(() => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.JWT_SECRET = 'short';
      const { ConfigSchema: CS, logRedactedSummary: lrs } = require('./index');

      const result = CS.safeParse(process.env);
      expect(result.success).toBe(false);
      lrs(result.error);

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('JWT_SECRET');
      consoleSpy.mockRestore();
    });
  });

  test('logRedactedSummary handles null without throwing', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logRedactedSummary(null)).not.toThrow();
    consoleSpy.mockRestore();
  });

  test('logRedactedSummary handles undefined without throwing', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logRedactedSummary(undefined)).not.toThrow();
    consoleSpy.mockRestore();
  });

  test('logRedactedSummary handles a plain Error without throwing', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => logRedactedSummary(new Error('boom'))).not.toThrow();
    consoleSpy.mockRestore();
  });

  // ── getInvoiceFileMaxSize safe fallback ───────────────────────────────────

  test('getInvoiceFileMaxSize returns default "5mb" when env is missing and singleton absent', () => {
    jest.isolateModules(() => {
      delete process.env.INVOICE_FILE_MAX_SIZE;
      const { getInvoiceFileMaxSize: gifs } = require('./index');
      expect(gifs()).toBe('5mb');
    });
  });

  test('getInvoiceFileMaxSize returns default "5mb" when env value is invalid and singleton absent', () => {
    jest.isolateModules(() => {
      process.env.INVOICE_FILE_MAX_SIZE = 'not-a-size';
      const { getInvoiceFileMaxSize: gifs } = require('./index');
      expect(gifs()).toBe('5mb');
    });
  });

  test('getInvoiceFileMaxSize returns config value after successful validate()', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.INVOICE_FILE_MAX_SIZE = '1mb';
      const { validate: v, getInvoiceFileMaxSize: gifs } = require('./index');
      v();
      expect(gifs()).toBe('1mb');
    });
  });

  // ── Original regression tests ─────────────────────────────────────────────

  test('validates minimal config with defaults', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      const cfg = v();
      expect(cfg.NODE_ENV).toBe('development');
      expect(cfg.PORT).toBe(3001);
    });
  });

  test('rejects short JWT_SECRET', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'too-short';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow();
    });
  });

  test('rejects invalid NODE_ENV', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.NODE_ENV = 'invalid';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow();
    });
  });

  test('get() throws if not validated', () => {
    jest.isolateModules(() => {
      const { get: g } = require('./index');
      expect(() => g()).toThrow(/Config not validated/i);
    });
  });

  test('rejects half-set KYC configuration in non-test env', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';
      process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
      delete process.env.KYC_PROVIDER_API_KEY;
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/KYC_PROVIDER_API_KEY/i);
    });
  });

  test('rejects missing PUBLIC_API_BASE_URL in production', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      delete process.env.PUBLIC_API_BASE_URL;
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/PUBLIC_API_BASE_URL must be set in production/i);
    });
  });

  test('schema direct parse', () => {
    const result = ConfigSchema.parse({
      NODE_ENV: 'test',
      PORT: 3001,
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(result).toMatchObject({ NODE_ENV: 'test', PORT: 3001 });
  });

  test('ESCROW_READ_PROJECTION_ENABLED defaults to "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().ESCROW_READ_PROJECTION_ENABLED).toBe('true');
    });
  });

  test('CONFIG_RUNTIME_ENABLED defaults to "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().CONFIG_RUNTIME_ENABLED).toBe('true');
    });
  });

  test('INVOICE_STATE_ENABLED defaults to "true"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().INVOICE_STATE_ENABLED).toBe('true');
    });
  });

  test('ESCROW_INDEXER_ENABLED defaults to "false"', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      expect(v().ESCROW_INDEXER_ENABLED).toBe('false');
    });
  });
});
