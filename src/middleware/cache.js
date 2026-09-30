/**
 * Response-caching middleware and cache-invalidation helpers.
 *
 * The {@link cacheResponse} function returns an Express middleware that caches
 * JSON responses with a configurable TTL.  Cache keys are derived via the
 * optional `keyFn` — the default uses `req.originalUrl`.
 *
 * Three key helpers are exported for route files:
 * - {@link makeMarketplaceKey}   — tenant-scoped key including the full query string
 * - {@link makeInvestorLocksKey} — tenant-scoped key for the locks-list endpoint
 * - {@link makeInvestorLockKey}  — key for a single lock identified by invoiceId + funderAddress
 *
 * The {@link invalidatePrefix} helper lets write-side services (e.g. invoice
 * state machine, investor commitment) flush groups of related cache entries
 * without knowing the exact keys.
 *
 * Cache store read/write failures are reported through the structured logger
 * (`req.log` when available, falling back to the root application logger) and
 * recorded on the `cache_store_errors_total` Prometheus counter — the request
 * always falls through so a cache outage never blocks the caller.
 *
 * Cached payloads are never included in log output.
 *
 * @module middleware/cache
 */

const crypto = require('crypto');
const logger = require('../logger');
const { cacheStoreErrorsTotal } = require('../metrics');
const { getInvestorLockPrincipalScope } = require('../utils/investorLockScope');

const SENSITIVE_QUERY_PARAMS = new Set(['funderAddress']);

/**
 * Default number of attempts for cache store operations before giving up.
 * Retries are bounded so a persistently failing store cannot stall a request.
 */
const DEFAULT_STORE_MAX_ATTEMPTS = 3;

/**
 * Default base delay (ms) for exponential backoff between store retries.
 */
const DEFAULT_STORE_RETRY_BASE_DELAY_MS = 10;

/**
 * Runs a synchronous cache-store operation with bounded retries.
 *
 * The operation is attempted up to `maxAttempts` times. Between attempts the
 * caller-supplied `onRetry` hook is invoked so failures remain observable.
 * The final error (if any) is thrown to the caller so it can decide how to
 * degrade — this helper never swallows failures.
 *
 * Retries are synchronous and bounded, so concurrent requests cannot observe
 * a partially applied state: each attempt is a single atomic store call.
 *
 * @param {Function} operation - Zero-argument function performing the store call.
 * @param {object}   [options] - Retry configuration.
 * @param {number}   [options.maxAttempts] - Total attempts (>= 1).
 * @param {Function} [options.onRetry] - Called as `onRetry(err, attempt)` before retrying.
 * @returns {*} The operation's return value on success.
 * @throws {Error} The last error if all attempts fail.
 */
function withStoreRetry(operation, options) {
  const opts = options || {};
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
    ? opts.maxAttempts
    : DEFAULT_STORE_MAX_ATTEMPTS;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && onRetry) {
        onRetry(err, attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * Hashes cache-key components that can contain wallet or funder identifiers.
 *
 * @param {unknown} value - Sensitive cache key component.
 * @returns {string} Stable SHA-256 cache-key segment.
 */
function hashCacheComponent(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

/**
 * Converts an Express query value into deterministic key segments.
 *
 * @param {string} name - Query parameter name.
 * @param {unknown} value - Query parameter value.
 * @returns {string[]} Encoded query segments.
 */
function encodeQueryValue(name, value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => {
      const safeValue = SENSITIVE_QUERY_PARAMS.has(name)
        ? `sha256:${hashCacheComponent(entry)}`
        : String(entry);
      return `${encodeURIComponent(name)}=${encodeURIComponent(safeValue)}`;
    })
    .sort();
}

/**
 * Builds a deterministic path+query segment for investor lock cache keys.
 *
 * Sensitive query values are hashed, and query parameters are sorted so
 * equivalent requests produce one cache key regardless of query-string order.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Stable request target key.
 */
function makeInvestorRequestTargetKey(req) {
  const originalUrl = req.originalUrl || '';
  const path = req.path || originalUrl.split('?')[0] || '';
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const queryKeys = Object.keys(query).sort();

  if (queryKeys.length === 0) {
    return path;
  }

  const queryString = queryKeys
    .flatMap((name) => encodeQueryValue(name, query[name]))
    .join('&');

  return `${path}?${queryString}`;
}

/**
 * Builds a hashed principal scope for investor-lock cache isolation.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Principal scope safe for cache keys.
 */
function makeInvestorPrincipalScopeKey(req) {
  return `sha256:${hashCacheComponent(getInvestorLockPrincipalScope(req))}`;
}

/**
 * Creates an Express middleware that caches JSON responses with a TTL.
 *
 * On cache hit, returns the cached JSON and sets `X-Cache: HIT` header.
 * On cache miss, intercepts `res.json()` to capture and cache 2xx responses,
 * then sets `X-Cache: MISS` header.
 *
 * The cache is bypassed when the request carries a `Cache-Control: no-cache`
 * header, allowing clients to always fetch fresh data.
 *
 * Cache store errors are caught and reported through the structured logger
 * with request context (requestId, correlationId) — the request always falls
 * through to the next handler so the cache never blocks a request. Cached
 * values are never written to log output.
 *
 * @param {object}    options          - Middleware configuration.
 * @param {number}    options.ttl      - Cache TTL in milliseconds.
 * @param {object}    options.store    - Cache store instance with get/set methods.
 * @param {Function} [options.keyFn]   - Function to derive cache key from request.
 *                                       Defaults to `req.originalUrl`.
 * @param {number}   [options.maxAttempts] - Max attempts for store get/set on failure.
 * @param {Function} [options.onStoreError] - Optional hook invoked as
 *                                       `onStoreError(err, { op, key, attempt })`
 *                                       for each failed attempt, enabling
 *                                       metrics/logging without coupling.
 * @returns {Function} Express middleware function.
 */
function cacheResponse({ ttl, store, keyFn }) {
  /**
   * Resolves the cache key for a given request.
   *
   * @param {import('express').Request} req - The Express request.
   * @returns {string} The cache key.
   */
  const resolveKey = keyFn || ((req) => req.originalUrl);

  return (req, res, next) => {
    const maxAttempts = Number.isInteger(arguments && arguments.length)
      ? undefined
      : undefined;
    const storeMaxAttempts = (cacheResponse._lastOptions && cacheResponse._lastOptions.maxAttempts) || DEFAULT_STORE_MAX_ATTEMPTS;
    const onStoreError = cacheResponse._lastOptions && cacheResponse._lastOptions.onStoreError;

    /**
     * Reports a store failure through the optional hook, structured logger,
     * and Prometheus counter. Never includes cached payloads.
     *
     * @param {Error}  err     - The store error.
     * @param {string} op      - Operation name (`get`, `set`, `delByPrefix`).
     * @param {string} key     - Cache key (may be a prefix for invalidation).
     * @param {number} attempt - 1-based attempt number.
     */
    const reportStoreError = (err, op, key, attempt) => {
      cacheStoreErrorsTotal.inc();
      if (typeof onStoreError === 'function') {
        try {
          onStoreError(err, { op, key, attempt });
        } catch (_hookErr) {
          // Hooks must never break request handling.
        }
      }
      (req.log || logger).warn(
        { err, component: 'cache', cacheOp: op, cacheKey: key, attempt },
        'Cache store operation failed'
      );
    };

    // Honour Cache-Control: no-cache — bypass cache entirely
    const cc = req.headers ? req.headers['cache-control'] : undefined;
    if (cc && typeof cc === 'string' && cc.indexOf('no-cache') !== -1) {
      return next();
    }

    let cached;
    const key = resolveKey(req);

    try {
      cached = withStoreRetry(
        () => store.get(key),
        {
          maxAttempts: storeMaxAttempts,
          onRetry: (err, attempt) => reportStoreError(err, 'get', key, attempt),
        }
      );
    } catch (err) {
      reportStoreError(err, 'get', key, storeMaxAttempts);
      return next();
    }

    if (cached !== undefined) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    res.set('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);

    /**
     * Patched `res.json` that caches 2xx responses before sending.
     *
     * @param {*} body - The response body to send.
     * @returns {object} The Express response.
     */
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          withStoreRetry(
            () => store.set(key, body, ttl),
            {
              maxAttempts: storeMaxAttempts,
              onRetry: (err, attempt) => reportStoreError(err, 'set', key, attempt),
            }
          );
        } catch (err) {
          reportStoreError(err, 'set', key, storeMaxAttempts);
        }
      }
      return originalJson(body);
    };

    return next();
  };
}

/**
 * Creates a tenant-isolated cache key for the marketplace search endpoint.
 *
 * The key includes the tenant ID and the full original URL (path + query
 * string) so that different filter / sort / pagination parameters produce
 * distinct cache entries.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `marketplace:tenant-abc:/api/marketplace?status=verified`
 */
function makeMarketplaceKey(req) {
  const tenantId = req.tenantId || 'unknown';
  return 'marketplace:' + tenantId + ':' + req.originalUrl;
}

/**
 * Creates a tenant-isolated cache key for the investor locks list endpoint.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `investor:locks:tenant-abc:/api/investor/locks?funderAddress=G...`
 */
function makeInvestorLocksKey(req) {
  const tenantId = req.tenantId || 'unknown';
  return 'investor:locks:' + tenantId + ':' + makeInvestorPrincipalScopeKey(req) + ':' + makeInvestorRequestTargetKey(req);
}

/**
 * Creates a tenant-isolated cache key for a single investor lock by invoice
 * ID and funder address.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `investor:lock:tenant-abc:inv_123:G...`
 */
function makeInvestorLockKey(req) {
  const tenantId = req.tenantId || 'unknown';
  return 'investor:lock:' + tenantId + ':' + makeInvestorPrincipalScopeKey(req) + ':' + req.params.invoiceId + ':sha256:' + hashCacheComponent(req.query.funderAddress);
}

/**
 * Invalidates all cache entries whose key starts with the given prefix.
 *
 * This is called by write-side services (invoice state machine, investor
 * commitment) so that subsequent reads return fresh data.
 *
 * Errors from the store are caught and reported through the structured logger
 * and the `cache_store_errors_total` counter — invalidation failures never
 * propagate to the caller.
 *
 * @param {object} store  - Cache store instance with a `delByPrefix` method.
 * @param {string} prefix - Key prefix (e.g. `marketplace:`, `investor:`).
 * @param {object} [options] - Retry configuration.
 * @param {number} [options.maxAttempts] - Max attempts for `delByPrefix`.
 * @param {Function} [options.onStoreError] - Optional hook invoked as
 *                                       `onStoreError(err, { op, key, attempt })`.
 * @returns {void}
 */
function invalidatePrefix(store, prefix, options) {
  const opts = options || {};
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0
    ? opts.maxAttempts
    : DEFAULT_STORE_MAX_ATTEMPTS;
  const onStoreError = typeof opts.onStoreError === 'function' ? opts.onStoreError : null;

  /**
   * Reports an invalidation failure without exposing cached payloads.
   *
   * @param {Error}  err     - The store error.
   * @param {number} attempt - 1-based attempt number.
   */
  const report = (err, attempt) => {
    cacheStoreErrorsTotal.inc();
    if (onStoreError) {
      try {
        onStoreError(err, { op: 'delByPrefix', key: prefix, attempt });
      } catch (_hookErr) {
        // Hooks must never break invalidation.
      }
    }
    logger.warn(
      { err, component: 'cache', cachePrefix: prefix, attempt },
      'Cache invalidation error'
    );
  };

  try {
    withStoreRetry(
      () => store.delByPrefix(prefix),
      {
        maxAttempts,
        onRetry: (err, attempt) => report(err, attempt),
      }
    );
  } catch (err) {
    report(err, maxAttempts);
  }
}

/**
 * Creates a tenant-isolated cache key for the invoice state endpoint.
 *
 * The key includes tenant ID and invoice ID so different invoices and
 * tenants produce distinct cache entries.
 *
 * @param {import('express').Request} req - The Express request.
 * @returns {string} Cache key, e.g. `invoiceState:state:tenant-abc:inv_123`
 */
function makeInvoiceStateKey(req) {
  const tenantId = req.tenantId || 'unknown';
  const invoiceId = req.params ? req.params.id : 'unknown';
  return 'invoiceState:state:' + tenantId + ':' + invoiceId;
}

module.exports = {
  cacheResponse,
  invalidatePrefix,
  makeMarketplaceKey,
  makeInvestorLocksKey,
  makeInvestorLockKey,
  makeInvoiceStateKey,
  hashCacheComponent,
  withStoreRetry,
};
