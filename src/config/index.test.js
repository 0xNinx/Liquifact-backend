

/**
 * Tests for centralized config module.
 */

const {
  validate,
  get,
  getValue,
  getInvoiceFileMaxSize,
  logRedactedSummary,
  ConfigSchema,
} = require('./index');

describe('Config Validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear module cache and reset config
    delete require.cache[require.resolve('./index')];
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('validates minimal config with defaults', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'this-is-a-32-char-secret-for-testing-only-do-not-use-in-prod';

    const config = validate();
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3001);
    expect(config.JWT_SECRET).toBe(process.env.JWT_SECRET);
    // JWT_ISSUER/JWT_AUDIENCE are optional with no default — enforcement in
    // src/middleware/auth.js is conditional on these being explicitly set.
    expect(config.JWT_ISSUER).toBeUndefined();
    expect(config.JWT_AUDIENCE).toBeUndefined();
    expect(config.JWT_ALGORITHMS).toBe('HS256');
  });

  test('overrides defaults', () => {
    process.env.PORT = '8080';
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'prod-secret-32-chars-minimum-required';
    process.env.JWT_ISSUER = 'custom-issuer';
    process.env.JWT_AUDIENCE = 'custom-audience';
    process.env.JWT_ALGORITHMS = 'HS256,HS384';
    // Required in production by the PUBLIC_API_BASE_URL superRefine rule.
    process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';

    const config = validate();
    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('production');
    expect(config.JWT_ISSUER).toBe('custom-issuer');
    expect(config.JWT_AUDIENCE).toBe('custom-audience');
    expect(config.JWT_ALGORITHMS).toBe('HS256,HS384');
  });

  test('rejects short JWT_SECRET', () => {
    process.env.JWT_SECRET = 'too-short';
    expect(() => validate()).toThrow(/string/i);
  });

  test('rejects invalid PORT', () => {
    process.env.PORT = 'invalid';
    expect(() => validate()).toThrow(/number/i);
  });

  test('rejects invalid NODE_ENV', () => {
    process.env.NODE_ENV = 'invalid';
    expect(() => validate()).toThrow(/invalid/i);
  });

  test('logRedactedSummary output does not contain secrets', () => {
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

  test('boot validation gate exits on invalid config', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'short-secret';
      
      const { startServer } = require('../index');
      startServer();
      
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  test('boot validation gate does not exit on valid config', () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    jest.isolateModules(() => {
      const app = require('../app');
      const listenSpy = jest.spyOn(app, 'listen').mockImplementation(() => ({}));

      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
      // Required in production by the PUBLIC_API_BASE_URL superRefine rule.
      process.env.PUBLIC_API_BASE_URL = 'https://api.example.com';

      const { startServer } = require('../index');
      startServer();

      expect(exitSpy).not.toHaveBeenCalled();
      listenSpy.mockRestore();
    });

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  test('rejects half-set KYC configuration in non-test env', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    delete process.env.KYC_PROVIDER_API_KEY;
    expect(() => validate()).toThrow(/KYC_PROVIDER_API_KEY/i);

    delete process.env.KYC_PROVIDER_URL;
    process.env.KYC_PROVIDER_API_KEY = 'some-key';
    expect(() => validate()).toThrow(/KYC_PROVIDER_URL/i);
  });

  test('rejects missing PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    delete process.env.PUBLIC_API_BASE_URL;

    expect(() => validate()).toThrow(/PUBLIC_API_BASE_URL must be set in production/i);
  });

  test('rejects non-HTTPS PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PUBLIC_API_BASE_URL = 'http://api.example.com';

    expect(() => validate()).toThrow(/must use HTTPS/i);
  });

  test('rejects loopback PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PUBLIC_API_BASE_URL = 'https://localhost:3001';

    expect(() => validate()).toThrow(/must not be a loopback address/i);
  });

  test('accepts a valid HTTPS non-loopback PUBLIC_API_BASE_URL in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    process.env.PUBLIC_API_BASE_URL = 'https://api.liquifact.com';

    const config = validate();
    expect(config.PUBLIC_API_BASE_URL).toBe('https://api.liquifact.com');
  });

  test('allows half-set KYC configuration in test env', () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'valid-secret-at-least-32-chars-long-here';
    
    process.env.KYC_PROVIDER_URL = 'https://kyc.example.com';
    delete process.env.KYC_PROVIDER_API_KEY;
    
    const config = validate();
    expect(config.KYC_PROVIDER_URL).toBe('https://kyc.example.com');
    expect(config.KYC_PROVIDER_API_KEY).toBeUndefined();
  });

  test('get() throws if not validated', () => {
    jest.isolateModules(() => {
      const { get: getFresh } = require('./index');
      expect(() => getFresh()).toThrow(/validated/i);
    });
  });

  test('schema type safety', () => {
    const result = ConfigSchema.parse({
      NODE_ENV: 'test',
      PORT: 3001,
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(result).toMatchObject({ NODE_ENV: 'test', PORT: 3001 });
  });

  // ── ESCROW_READ_PROJECTION_ENABLED flag ──────────────────────────────────

  test('ESCROW_READ_PROJECTION_ENABLED defaults to "true"', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    const config = validate();
    expect(config.ESCROW_READ_PROJECTION_ENABLED).toBe('true');
  });

  test('ESCROW_READ_PROJECTION_ENABLED accepts "false"', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.ESCROW_READ_PROJECTION_ENABLED = 'false';
    const config = validate();
    expect(config.ESCROW_READ_PROJECTION_ENABLED).toBe('false');
  });

  test('ESCROW_READ_PROJECTION_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.ESCROW_READ_PROJECTION_ENABLED = 'invalid';
    expect(() => validate()).toThrow();
  });

  // ── ESCROW_INDEXER_ENABLED flag ─────────────────────────────────────────

  test('ESCROW_INDEXER_ENABLED defaults to "false" (safe default)', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    const config = validate();
    expect(config.ESCROW_INDEXER_ENABLED).toBe('false');
  });

  test('ESCROW_INDEXER_ENABLED accepts "true"', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.ESCROW_INDEXER_ENABLED = 'true';
    const config = validate();
    expect(config.ESCROW_INDEXER_ENABLED).toBe('true');
  });

  test('ESCROW_INDEXER_ENABLED accepts "false"', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.ESCROW_INDEXER_ENABLED = 'false';
    const config = validate();
    expect(config.ESCROW_INDEXER_ENABLED).toBe('false');
  });

  test('ESCROW_INDEXER_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.ESCROW_INDEXER_ENABLED = 'yes';
    expect(() => validate()).toThrow();
  });

  // ── CONFIG_RUNTIME_ENABLED flag ──────────────────────────────────────────

  test('CONFIG_RUNTIME_ENABLED defaults to "true" (safe default — surface enabled)', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    const config = validate();
    expect(config.CONFIG_RUNTIME_ENABLED).toBe('true');
  });

  test('CONFIG_RUNTIME_ENABLED accepts "true"', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.CONFIG_RUNTIME_ENABLED = 'true';
    const config = validate();
    expect(config.CONFIG_RUNTIME_ENABLED).toBe('true');
  });

  test('CONFIG_RUNTIME_ENABLED accepts "false" (disables /api/admin/config routes)', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.CONFIG_RUNTIME_ENABLED = 'false';
    const config = validate();
    expect(config.CONFIG_RUNTIME_ENABLED).toBe('false');
  });

  test('CONFIG_RUNTIME_ENABLED rejects truthy-but-not-"true" values', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    for (const val of ['1', 'yes', 'TRUE', 'enabled', 'on']) {
      process.env.CONFIG_RUNTIME_ENABLED = val;
      expect(() => validate()).toThrow();
    }
  });

  test('CONFIG_RUNTIME_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.CONFIG_RUNTIME_ENABLED = 'invalid';
    expect(() => validate()).toThrow();
  });

  // ── INVOICE_STATE_ENABLED flag ───────────────────────────────────────────

  test('INVOICE_STATE_ENABLED defaults to "true" (safe default — routes enabled)', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    const config = validate();
    expect(config.INVOICE_STATE_ENABLED).toBe('true');
  });

  test('INVOICE_STATE_ENABLED accepts "true"', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.INVOICE_STATE_ENABLED = 'true';
    const config = validate();
    expect(config.INVOICE_STATE_ENABLED).toBe('true');
  });

  test('INVOICE_STATE_ENABLED accepts "false"', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.INVOICE_STATE_ENABLED = 'false';
    const config = validate();
    expect(config.INVOICE_STATE_ENABLED).toBe('false');
  });

  test('INVOICE_STATE_ENABLED rejects invalid value', () => {
    process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef';
    process.env.INVOICE_STATE_ENABLED = 'yes';
    expect(() => validate()).toThrow();
  });

  // ── verificationThresholds validation boundaries ────────────────────────

  describe('verificationThresholds boundaries', () => {
    const { verificationThresholds } = require('./index');
    test('exposes a frozen, well-formed thresholds object', () => {
      expect(verificationThresholds).toBeDefined();
      expect(typeof verificationThresholds).toBe('object');
      expect(Object.isFrozen(verificationThresholds)).toBe(true);
    });

    test('all threshold values are finite non-negative numbers', () => {
      for (const [key, value] of Object.entries(verificationThresholds)) {
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        // eslint-disable-next-line no-console
        expect(Number.isNaN(value)).toBe(false);
        expect(key).toEqual(expect.any(String));
      }
    });

    test('getValue returns the same threshold for a known key (idempotent)', () => {
      const keys = Object.keys(verificationThresholds);
      expect(keys.length).toBeGreaterThan(0);
      const first = keys[0];
      const a = getValue(first);
      const b = getValue(first);
      expect(a).toBe(b);
    });

    test('getValue on unknown threshold key is deterministic (undefined, not throw)', () => {
      const unknown = '__definitely_not_a_threshold__';
      let first;
      let second;
      expect(() => {
        first = getValue(unknown);
      }).not.toThrow();
      expect(() => {
        second = getValue(unknown);
      }).not.toThrow();
      expect(first).toBe(second);
      expect(first).toBeUndefined();
    });

    test('boundary: zero-valued thresholds (if any) are accepted, not coerced', () => {
      for (const [key, value] of Object.entries(verificationThresholds)) {
        if (value === 0) {
          expect(getValue(key)).toBe(0);
        }
      }
    });

    test('duplicate reads of the thresholds object are stable across calls', () => {
      const snapshot = JSON.stringify(verificationThresholds);
      const again = JSON.stringify(verificationThresholds);
      expect(again).toBe(snapshot);
    });

    test('rejects mutation attempts on the frozen thresholds object', () => {
      const keys = Object.keys(verificationThresholds);
      if (keys.length === 0) {
        return;
      }
      const key = keys[0];
      const original = verificationThresholds[key];
      expect(() => {
        'use strict';
        verificationThresholds[key] = original + 1;
      }).toThrow();
      expect(verificationThresholds[key]).toBe(original);
    });
  });
});

