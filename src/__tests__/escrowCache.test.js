'use strict';

const {
  RedisEscrowSummaryCache,
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
      maxRetries: 0,
    });

    // getSummary should not throw — it should return a miss.
    const getResult = await cache.getSummary('inv_timeout');
    expect(getResult.hit).toBe(false);
    expect(getResult.reason).toBe('timeout');

    // setSummary should not throw — it should return false.
    const setResult = await cache.setSummary('inv_timeout', { status: 'funded' });
    expect(setResult).toBe(false);
  });

  it('falls through when circuit breaker trips open', async () => {
    const client = new FakeRedisClient();
    const breaker = new CircuitBreaker( {
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

  it('returns invalid_input for malformed invoice IDs', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    for (const bad of [' ', 'inv_100 ; del', 'a'.repeat(129), '', null, undefined, 42]) {
      const res = await cache.getSummary(bad);
      expect(res.hit).toBe(false);
      expect(res.reason).toBe('invalid_input');
      expect(await cache.setSummary(bad, {})).toBe(false);
    }
  });

  it('evicts corrupt entries and reports corrupt reason', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });

    await client.set(cache.key('inv_corrupt'), '{lots of bad json');
    const res = await cache.getSummary('inv_corrupt');
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('corrupt');
    // Evicted from Redis.
    expect(await client.get(cache.key('inv_corrupt'))).toBe(null);
  });

  it('retries transient errors up to maxRetries and then succeeds', async () => {
    let calls = 0;
    const client = {
      get: async () => {
        calls += 1;
        if (calls < 3) {
          const e = new Error('connection reset');
          e.code = 'ECONNRESET';
          throw e;
        }
        return JSON.stringify({ summary: { id: 'inv_retry' }, cachedLedger: 100 });
      },
      set: async () => 'OK',
      del: async () => 1,
    };

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      maxRetries: 3,
      retryBaseDelayMs: 0,
    });

    const res = await cache.getSummary('inv_retry', 101);
    expect(res.hit).toBe(true);
    expect(res.value.id).toBe('inv_retry');
    expect(calls).toBe(3);
  });

  it('gives up after maxRetries and reports error reason', async () => {
    let calls = 0;
    const client = {
      get: async () => {
        calls += 1;
        const e = new Error('connection refused');
        e.code = 'ECONNREFUSED';
        throw e;
      },
      set: async () => 'OK',
      del: async () => 1,
    };

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      maxRetries: 2,
      retryBaseDelayMs: 0,
    });

    const res = await cache.getSummary('inv_dead');
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('error');
    // 1 initial + 2 retries.
    expect(calls).toBe(3);
  });

  it('does not retry when the circuit breaker is open', async () => {
    let calls = 0;
    const client = {
      get: async () => {
        calls += 1;
        return null;
      },
      set: async () => 'OK',
      del: async () => 1,
    };
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeout: 60000,
      fallbackLogic: () => null,
    });
    breaker.state = CircuitBreakerState.OPEN;
    breaker.nextAttemptTime = Date.now() + 60000;

    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      circuitBreaker: breaker,
      maxRetries: 5,
      retryBaseDelayMs: 0,
    });

    const res = await cache.getSummary('inv_open');
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('circuit_open');
    expect(calls).toBe(0);
  });

  it('deleteSummary returns true on success and false on failure', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });
    await cache.setSummary('inv_del', { id: 'inv_del' });
    expect(await cache.deleteSummary('inv_del')).toBe(true);

    const failingClient = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => { throw new Error('del failed'); },
    };
    const cache2 = new RedisEscrowSummaryCache({
      client: failingClient,
      ttlSeconds: 60,
      maxRetries: 0,
    });
    expect(await cache2.deleteSummary('inv_del')).toBe(false);
  });

  it('ledger gap evicts the entry and reports ledger_gap', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      ledgerGapThreshold: 3,
    });
    await cache.setSummary('inv_gap', { id: 'inv_gap' }, 100);
    const res = await cache.getSummary('inv_gap', 200);
    expect(res.hit).toBe(false);
    expect(res.reason).toBe('ledger_gap');
    expect(await client.get(cache.key('inv_gap'))).toBe(null);
  });

  it('boundary: ledger gap equal to threshold is a hit', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({
      client,
      ttlSeconds: 60,
      ledgerGapThreshold: 3,
    });
    await cache.setSummary('inv_bound', { id: 'inv_bound' }, 100);
    const res = await cache.getSummary('inv_bound', 103);
    expect(res.hit).toBe(true);
  });

  it('concurrent gets do not corrupt cache state', async () => {
    const client = new FakeRedisClient();
    const cache = new RedisEscrowSummaryCache({ client, ttlSeconds: 60 });
    await cache.setSummary('inv_concurrent', { id: 'inv_concurrent' }, 100);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.getSummary('inv_concurrent', 101))
    );
    for (const r of results) {
      expect(r.hit).toBe(true);
      expect(r.value.id).toBe('inv_concurrent');
    }
  });
});
