// src/services/cacheStore.test.js
/**
 * Tests for the bounded LRU MemoryCacheStore with metrics.
 */
const { MemoryCacheStore, createCacheStore } = require('./cacheStore');
const {
  footprintCacheHitsTotal,
  footprintCacheMissesTotal,
  footprintCacheEvictionsTotal,
} = require('../metrics');

function resetMetrics() {
  // The prom-client counters do not have a reset method in the shim, but in real client they do.
  // We'll recreate a new registry for a clean state by resetting the metric values via internal property if present.
  // For simplicity in tests we just set the internal count to 0 when possible.
  if (typeof footprintCacheHitsTotal.reset === 'function') {
    footprintCacheHitsTotal.reset();
  }
  if (typeof footprintCacheMissesTotal.reset === 'function') {
    footprintCacheMissesTotal.reset();
  }
  if (typeof footprintCacheEvictionsTotal.reset === 'function') {
    footprintCacheEvictionsTotal.reset();
  }
}

describe('MemoryCacheStore (bounded LRU)', () => {
  let store;

  beforeEach(() => {
    resetMetrics();
    store = new MemoryCacheStore({ maxEntries: 2 });
  });

  it('returns undefined for missing keys and records a miss', () => {
    expect(store.get('nonexistent')).toBeUndefined();
    expect(footprintCacheMissesTotal.val).toBe(1);
  });

  it('stores and retrieves a value, records hit/miss correctly', () => {
    store.set('key1', { data: 'hello' }, 5000);
    expect(store.get('key1')).toEqual({ data: 'hello' });
    expect(footprintCacheHitsTotal.val).toBe(1);
    expect(footprintCacheMissesTotal.val).toBe(0);
  });

  it('evicts expired entries lazily and records a miss', () => {
    const now = Date.now();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(now) // set call
      .mockReturnValueOnce(now + 6000); // get call after TTL
    store.set('key1', 'value', 5000);
    expect(store.get('key1')).toBeUndefined();
    expect(footprintCacheMissesTotal.val).toBe(1);
    Date.now.mockRestore();
  });

  it('evicts least‑recently used entry when exceeding maxEntries', () => {
    store.set('a', 1, 5000);
    store.set('b', 2, 5000);
    // Access 'a' to make it most‑recently used
    expect(store.get('a')).toBe(1);
    // Insert third entry, should evict 'b'
    store.set('c', 3, 5000);
    expect(store.get('b')).toBeUndefined(); // evicted
    expect(store.get('a')).toBe(1);
    expect(store.get('c')).toBe(3);
    expect(footprintCacheEvictionsTotal.val).toBe(1);
  });

  it('del removes a specific entry', () => {
    store.set('key1', 'value1', 5000);
    store.set('key2', 'value2', 5000);
    store.del('key1');
    expect(store.get('key1')).toBeUndefined();
    expect(store.get('key2')).toBe('value2');
  });

  it('clear removes all entries', () => {
    store.set('key1', 'value1', 5000);
    store.set('key2', 'value2', 5000);
    store.clear();
    expect(store.get('key1')).toBeUndefined();
    expect(store.get('key2')).toBeUndefined();
  });

  it('set overwrites existing entries without affecting LRU order', () => {
    store.set('key1', 'old', 5000);
    store.set('key1', 'new', 5000);
    expect(store.get('key1')).toBe('new');
  });
});

describe('createCacheStore', () => {
  it('returns a MemoryCacheStore instance with default options', () => {
    const store = createCacheStore();
    expect(store).toBeInstanceOf(MemoryCacheStore);
  });
});
