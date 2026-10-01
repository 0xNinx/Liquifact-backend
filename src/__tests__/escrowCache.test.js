'use strict';

const {
  RedisEscrowSummaryCache,
  validateInvoiceId,
  validateSummary,
  validateTtlSeconds,
  validateVersion,
  MAX_INVOICE_ID_LENGTH,
  MAX_TTL_SECONDS,
} = require('../cache/redis');
const { CircuitBreaker, CircuitBreakerState } = require('../utils/circuitBreaker');

/**
 * Minimal in-memory Redis stub used for integration-style cache tests.
 */
class FakeRedisClient {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.get(key) || null;
  }

  async set(key, value, _mode, _ttl) {
    this.map.set(key, value);
    return 'OK';
  }

  async del(key) {
    this.map.delete(key);
    return 1;
  }
}

describe('Escrow Cache Integration', () => {
  it('serves cached response on second request for same invoiceId', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    // First call — miss.
    const miss = await cache.getSummary('inv_100');
    expect(miss.hit).toBe(false);
    expect(miss.reason).toBe('miss');

    // Populate the cache.
    const summary = { invoiceId: 'inv_100', status: 'funded', fundedAmount: 500 };
    await cache.setSummary('inv_100', summary, 200);

    // Second call — hit.
    const hit = await cache.getSummary('inv_100', 201);
    expect(hit.hit).toBe(true);
    expect(hit.value).toEqual(summary);
  });

  it('caches different invoiceIds independently', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    await cache.setSummary('inv_200', { invoiceId: 'inv_200', status: 'a' }, 100);
    await cache.setSummary('inv_300', { invoiceId: 'inv_300', status: 'b' }, 100);

    const r1 = await cache.getSummary('inv_200', 101);
    expect(r1.hit).toBe(true);
    expect(r1.value.invoiceId).toBe('inv_200');

    const r2 = await cache.getSummary('inv_300', 101);
    expect(r2.hit).toBe(true);
    expect(r2.value.invoiceId).toBe('inv_300');
  });

  it('simulated Redis timeout fails open and falls through', async () => {
    const slowClient = {
      get: () => new Promise((resolve) => setTimeout(() => resolve('data'), 5000)),
      set: () => new Promise((resolve) => setTimeout(() => resolve('OK'), 5000)),
      del: () => Promise.resolve(1),
    };

    const cache = new RedisEscrowSummaryCache({
      client: slowClient,
      ttlSeconds: 30,
      timeoutMs: 50,
    });

    // getSummary should not throw — it should return a miss.
    const getResult = await cache.getSummary('inv_timeout');
    expect(getResult.hit).toBe(false);
    expect(getResult.reason).toBe('fail_open');

    // setSummary should not throw — it should return false.
    const setResult = await cache.setSummary('inv_timeout', { status: 'funded' });
    expect(setResult).toBe(false);
  });

  it('falls through when circuit breaker trips open', async () => {
    const client = new FakeRedisClient();
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60000,
      fallbackLogic: () => null,
    });

    // Force breaker to OPEN state.
    breaker.state = CircuitBreakerState.OPEN;
    breaker.nextAttemptTime = Date.now() + 60000;

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 30,
      circuitBreaker: breaker,
    });

    // Even though the underlying client is healthy, the breaker is open
    // so the cache should degrade silently.
    const result = await cache.getSummary('inv_breaker');
    expect(result.hit).toBe(false);

    const setResult = await cache.setSummary('inv_breaker', { status: 'funded' });
    expect(setResult).toBe(false);
  });
});

describe('Escrow Cache Validation Boundaries', () => {
  describe('validateInvoiceId', () => {
    it('accepts a well-formed invoice id', () => {
      expect(validateInvoiceId('inv_100')).toEqual({ valid: true, value: 'inv_100' });
    });

    it('accepts boundary-length invoice ids', () => {
      const max = 'a'.repeat(MAX_INVOICE_ID_LENGTH);
      expect(validateInvoiceId(max).valid).toBe(true);
      expect(validateInvoiceId('a').valid).toBe(true);
    });

    it('rejects non-string, empty, and whitespace-only ids', () => {
      expect(validateInvoiceId(undefined).valid).toBe(false);
      expect(validateInvoiceId(null).valid).toBe(false);
      expect(validateInvoiceId(123).valid).toBe(false);
      expect(validateInvoiceId('').valid).toBe(false);
      expect(validateInvoiceId('   ').valid).toBe(false);
    });

    it('rejects ids exceeding the maximum length', () => {
      const tooLong = 'a'.repeat(MAX_INVOICE_ID_LENGTH + 1);
      const result = validateInvoiceId(tooLong);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invoice_id_too_long');
    });

    it('rejects ids containing control characters', () => {
      expect(validateInvoiceId('inv\u0000_1').valid).toBe(false);
      expect(validateInvoiceId('inv\n_1').valid).toBe(false);
    });
  });

  describe('validateSummary', () => {
    it('accepts a plain object summary', () => {
      const summary = { invoiceId: 'inv_1', status: 'funded' };
      expect(validateSummary(summary)).toEqual({ valid: true, value: summary });
    });

    it('rejects null, arrays, and primitives', () => {
      expect(validateSummary(null).valid).toBe(false);
      expect(validateSummary([]).valid).toBe(false);
      expect(validateSummary('str').valid).toBe(false);
      expect(validateSummary(42).valid).toBe(false);
    });

    it('rejects summaries that are not JSON-serializable', () => {
      const cyclic = {};
      cyclic.self = cyclic;
      const result = validateSummary(cyclic);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('summary_not_serializable');
    });
  });

  describe('validateTtlSeconds', () => {
    it('accepts positive integers within bounds', () => {
      expect(validateTtlSeconds(1)).toEqual({ valid: true, value: 1 });
      expect(validateTtlSeconds(MAX_TTL_SECONDS).valid).toBe(true);
    });

    it('rejects zero, negatives, non-integers, and out-of-range values', () => {
      expect(validateTtlSeconds(0).valid).toBe(false);
      expect(validateTtlSeconds(-5).valid).toBe(false);
      expect(validateTtlSeconds(1.5).valid).toBe(false);
      expect(validateTtlSeconds(MAX_TTL_SECONDS + 1).valid).toBe(false);
      expect(validateTtlSeconds('60').valid).toBe(false);
    });
  });

  describe('validateVersion', () => {
    it('accepts non-negative integers and undefined', () => {
      expect(validateVersion(undefined).valid).toBe(true);
      expect(validateVersion(0).valid).toBe(true);
      expect(validateVersion(42).valid).toBe(true);
    });

    it('rejects negatives and non-integers', () => {
      expect(validateVersion(-1).valid).toBe(false);
      expect(validateVersion(1.2).valid).toBe(false);
      expect(validateVersion('1').valid).toBe(false);
    });
  });

  describe('cache behavior with invalid input', () => {
    it('getSummary rejects invalid invoice ids without touching Redis', async () => {
      let getCalls = 0;
      const client = {
        get: async () => {
          getCalls += 1;
          return null;
        },
        set: async () => 'OK',
        del: async () => 1,
      };
      const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

      const result = await cache.getSummary('');
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('invalid_invoice_id');
      expect(getCalls).toBe(0);
    });

    it('setSummary rejects invalid invoice ids and summaries', async () => {
      const client = new FakeRedisClient();
      const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

      expect(await cache.setSummary('', { status: 'funded' })).toBe(false);
      expect(await cache.setSummary('inv_1', null)).toBe(false);
      expect(client.map.size).toBe(false);
    });

    it('setSummary rejects invalid ttl values', async () => {
      const client = new FakeRedisClient();
      const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

      expect(await cache.setSummary('inv_1', { status: 'funded' }, 0)).toBe(false);
      expect(await cache.setSummary('inv_1', { status: 'funded' }, -1)).toBe(false);
      expect(await cache.setSummary('inv_1', { status: 'funded' }, 1.5)).toBe(false);
      expect(client.map.size).toBe(0);
    });

    it('getSummary rejects invalid version values', async () => {
      const client = new FakeRedisClient();
      const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

      const result = await cache.getSummary('inv_1', -1);
      expect(result.hit).toBe(false);
      expect(result.reason).toBe('invalid_version');
    });

    it('duplicate setSummary calls are idempotent for the same payload', async () => {
      const client = new FakeRedisClient();
      const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });
      const summary = { invoiceId: 'inv_dup', status: 'funded' };

      expect(await cache.setSummary('inv_dup', summary, 10)).toBe(true);
      expect(await cache.setSummary('inv_dup', summary, 10)).toBe(true);

      const hit = await cache.getSummary('inv_dup', 11);
      expect(hit.hit).toBe(true);
      expect(hit.value).toEqual(summary);
    });

    it('rejects a stale version read after a newer write', async () => {
      const client = new FakeRedisClient();
      const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

      await cache.setSummary('inv_ver', { invoiceId: 'inv_ver', status: 'a' }, 100);
      const stale = await cache.getSummary('inv_ver', 99);
      expect(stale.hit).toBe(false);
      expect(stale.reason).toBe('stale_version');

      const fresh = await cache.getSummary('inv_ver', 100);
      expect(fresh.hit).toBe(true);
    });
  });
});
