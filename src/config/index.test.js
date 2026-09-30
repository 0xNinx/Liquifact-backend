/**
 * Tests for centralized config module — #1303 Protect state invariants.
 *
 * Covers:
 *  - Singleton is frozen (immutable) after validate()
 *  - Failed validate() does not overwrite a previously-valid singleton
 *  - isValidated() reflects correct state before/after validate()
 *  - get() / getValue() throw before validation, succeed after
 *  - _resetForTesting() clears the singleton
 *  - Retries and concurrent-style repeated calls remain safe
 *  - All original tests preserved for regression coverage
 */

const {
  validate,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  isValidated,
  _resetForTesting,
  ConfigSchema,
} = require('./index');

// ─── Helpers ───────────────────────────────────────────────────────────────────

const VALID_JWT = 'valid-secret-at-least-32-chars-long-here';
const VALID_PROD = {
  NODE_ENV: 'production',
  JWT_SECRET: VALID_JWT,
  PUBLIC_API_BASE_URL: 'https://api.example.com',
};

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('Config — state invariants (#1303)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Full module reload gives us a clean singleton for each test.
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── isValidated() ──────────────────────────────────────────────────────────

  test('isValidated() returns false before any validate() call', () => {
    jest.isolateModules(() => {
      const { isValidated: fresh } = require('./index');
      expect(fresh()).toBe(false);
    });
  });

  test('isValidated() returns true after a successful validate()', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, isValidated: iv } = require('./index');
      v();
      expect(iv()).toBe(true);
    });
  });

  test('isValidated() remains false after a failed validate()', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = 'short'; // will fail
      const { validate: v, isValidated: iv } = require('./index');
      try { v(); } catch (_) { /* expected */ }
      expect(iv()).toBe(false);
    });
  });

  // ── Singleton immutability ─────────────────────────────────────────────────

  test('config object is frozen after validate()', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      const cfg = v();
      expect(Object.isFrozen(cfg)).toBe(true);
    });
  });

  test('mutating a field on the returned config has no effect (strict mode ignored silently)', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, get: g } = require('./index');
      const cfg = v();
      const original = cfg.NODE_ENV;
      // In non-strict mode this is a no-op; in strict it throws — either way
      // the stored value must not change.
      try { cfg.NODE_ENV = 'hacked'; } catch (_) { /* strict mode may throw */ }
      expect(g().NODE_ENV).toBe(original);
    });
  });

  test('adding a new key to the config object has no effect', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      const cfg = v();
      try { cfg.__injected = true; } catch (_) { /* strict mode */ }
      expect(cfg.__injected).toBeUndefined();
    });
  });

  // ── Singleton survives failed re-validation ────────────────────────────────

  test('a failed validate() call does not clear a previously-valid singleton', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const mod = require('./index');

      // First call succeeds — singleton is set.
      mod.validate();
      expect(mod.isValidated()).toBe(true);
      const firstConfig = mod.get();

      // Second call with bad env — must throw but not clear the singleton.
      const savedSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'short';
      expect(() => mod.validate()).toThrow();

      // Singleton is still the first valid config.
      expect(mod.isValidated()).toBe(true);
      expect(mod.get()).toBe(firstConfig);

      process.env.JWT_SECRET = savedSecret;
    });
  });

  test('multiple successful validate() calls each replace the singleton', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PORT = '3001';
      const mod = require('./index');

      mod.validate();
      const first = mod.get();

      process.env.PORT = '4000';
      mod.validate();
      const second = mod.get();

      // The singleton has been replaced with the new config.
      expect(second.PORT).toBe(4000);
      // The two config objects are different references.
      expect(second).not.toBe(first);
    });
  });

  // ── get() / getValue() guards ─────────────────────────────────────────────

  test('get() throws a descriptive error before validate()', () => {
    jest.isolateModules(() => {
      const { get: g } = require('./index');
      expect(() => g()).toThrow(/Config not validated/i);
    });
  });

  test('getValue() throws before validate()', () => {
    jest.isolateModules(() => {
      const { getValue: gv } = require('./index');
      expect(() => gv('NODE_ENV')).toThrow(/Config not validated/i);
    });
  });

  test('get() and getValue() succeed after validate()', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v, get: g, getValue: gv } = require('./index');
      v();
      expect(g().NODE_ENV).toBeDefined();
      expect(gv('NODE_ENV')).toBeDefined();
    });
  });

  // ── _resetForTesting() ────────────────────────────────────────────────────

  test('_resetForTesting() clears the singleton so isValidated() returns false', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const mod = require('./index');
      mod.validate();
      expect(mod.isValidated()).toBe(true);

      mod._resetForTesting();
      expect(mod.isValidated()).toBe(false);
    });
  });

  test('get() throws after _resetForTesting()', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const mod = require('./index');
      mod.validate();
      mod._resetForTesting();
      expect(() => mod.get()).toThrow(/Config not validated/i);
    });
  });

  test('validate() works normally after _resetForTesting()', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const mod = require('./index');
      mod.validate();
      mod._resetForTesting();

      mod.validate();
      expect(mod.isValidated()).toBe(true);
      expect(mod.get().JWT_SECRET).toBe(VALID_JWT);
    });
  });

  // ── Repeated/concurrent-style calls ──────────────────────────────────────

  test('calling validate() many times with valid env always returns frozen config', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const { validate: v } = require('./index');
      for (let i = 0; i < 10; i++) {
        const cfg = v();
        expect(Object.isFrozen(cfg)).toBe(true);
        expect(cfg.JWT_SECRET).toBe(VALID_JWT);
      }
    });
  });

  test('validate() failure in a retry does not corrupt state', () => {
    jest.isolateModules(() => {
      process.env.JWT_SECRET = VALID_JWT;
      const mod = require('./index');

      // Good first call.
      mod.validate();
      const snapshot = mod.get().NODE_ENV;

      // Simulate a broken env on a retry (e.g. env var removed by mistake).
      const saved = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      expect(() => mod.validate()).toThrow();

      // State is intact.
      expect(mod.isValidated()).toBe(true);
      expect(mod.get().NODE_ENV).toBe(snapshot);

      process.env.JWT_SECRET = saved;
    });
  });

  // ── Original regression tests ─────────────────────────────────────────────

  test('validates minimal config with defaults', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'development';
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

  test('logRedactedSummary does not expose secret values', () => {
    jest.isolateModules(() => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      process.env.JWT_SECRET = 'short';
      process.env.KYC_PROVIDER_API_KEY = 'ultra-secret-value';
      const { validate: v, logRedactedSummary: lrs } = require('./index');

      let err;
      try { v(); } catch (e) { err = e; }
      lrs(err);

      const output = consoleSpy.mock.calls.flat().join('\n');
      expect(output).toContain('JWT_SECRET');
      expect(output).not.toContain('ultra-secret-value');
      expect(output).not.toContain('short');
      consoleSpy.mockRestore();
    });
  });

  test('rejects half-set KYC in non-test env', () => {
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

  test('rejects non-HTTPS PUBLIC_API_BASE_URL in production', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PUBLIC_API_BASE_URL = 'http://api.example.com';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/must use HTTPS/i);
    });
  });

  test('rejects loopback PUBLIC_API_BASE_URL in production', () => {
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = VALID_JWT;
      process.env.PUBLIC_API_BASE_URL = 'https://localhost:3001';
      const { validate: v } = require('./index');
      expect(() => v()).toThrow(/must not be a loopback address/i);
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

  test('getInvoiceFileMaxSize falls back to env before validation', () => {
    jest.isolateModules(() => {
      process.env.INVOICE_FILE_MAX_SIZE = '512kb';
      const { getInvoiceFileMaxSize: gifs } = require('./index');
      expect(gifs()).toBe('512kb');
    });
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
