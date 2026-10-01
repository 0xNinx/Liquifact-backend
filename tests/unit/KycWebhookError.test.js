/**
 * KycWebhookError state-invariant tests (issue #1373).
 *
 * This error is the contract between `kycWebhookService` and the shared
 * `kycWebhookErrorHandler`: the service sets a status and code, and the
 * handler later reads them to choose the response code, the retry hint, and
 * the metrics label. Those values are therefore invariants, not ordinary
 * properties, and these tests pin them —
 *
 *   - the accepted input surface (including the two edge shapes that existing
 *     callers genuinely rely on: an empty message and an absent code),
 *   - what is rejected, so a status can never reach `res.status(...)` invalid,
 *   - that `name`, `status`, and `code` cannot be reassigned or redefined once
 *     the error exists, and
 *   - that the serialised/enumerable footprint the handler and telemetry rely
 *     on is unchanged.
 *
 * @jest-environment node
 */

'use strict';

const KycWebhookError = require('../../src/errors/KycWebhookError');

describe('KycWebhookError state invariants', () => {
  describe('accepted input', () => {
    it('carries the message, status, and code it was constructed with', () => {
      const err = new KycWebhookError('Invalid webhook signature', 401, 'invalid_signature');

      expect(err).toBeInstanceOf(KycWebhookError);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Invalid webhook signature');
      expect(err.status).toBe(401);
      expect(err.code).toBe('invalid_signature');
      expect(err.name).toBe('KycWebhookError');
    });

    it('accepts every status the KYC webhook path actually raises', () => {
      for (const status of [400, 401, 403, 429, 500, 503]) {
        expect(new KycWebhookError('x', status, 'code').status).toBe(status);
      }
    });

    it('accepts both ends of the permitted status range', () => {
      expect(new KycWebhookError('x', 400, 'code').status).toBe(400);
      expect(new KycWebhookError('x', 599, 'code').status).toBe(599);
    });

    it('accepts an empty message (rendered as an empty detail)', () => {
      // Regression guard: the handler maps `err.message` to `detail`, and a
      // real caller/test uses '' to check that path.
      const err = new KycWebhookError('', 400, 'test_code');

      expect(err.message).toBe('');
      expect(err.status).toBe(400);
    });

    it('accepts an absent code, keeping the key present but undefined', () => {
      // The handler omits `code` from the problem body when it is undefined;
      // it must stay an own property so `'code' in err` keeps behaving as it
      // always has for downstream readers.
      const err = new KycWebhookError('Error', 400, undefined);

      expect(err.code).toBeUndefined();
      expect('code' in err).toBe(true);
    });

    it('preserves a message built from sanitised provider data', () => {
      const err = new KycWebhookError(
        'Unknown provider status: unknown_status',
        400,
        'unknown_status',
      );

      expect(err.message).toContain('unknown_status');
    });
  });

  describe('rejected input', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 400],
      ['an object', { reason: 'nope' }],
      ['an array', ['nope']],
      ['a boolean', true],
    ])('rejects %s as the message', (_label, message) => {
      expect(() => new KycWebhookError(message, 400, 'code')).toThrow(TypeError);
    });

    it('rejects a numeric status supplied as a string instead of coercing it', () => {
      expect(() => new KycWebhookError('x', '400', 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', '503', 'code')).toThrow(TypeError);
    });

    it('rejects out-of-range statuses', () => {
      expect(() => new KycWebhookError('x', 200, 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', 399, 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', 600, 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', 0, 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', -1, 'code')).toThrow(TypeError);
    });

    it('rejects non-integer and missing statuses', () => {
      expect(() => new KycWebhookError('x', 404.5, 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', Number.NaN, 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', Number.POSITIVE_INFINITY, 'code')).toThrow(TypeError);
      expect(() => new KycWebhookError('x', undefined, 'code')).toThrow(TypeError);
    });

    it('rejects a null status rather than treating it as absent', () => {
      expect(() => new KycWebhookError('x', null, 'code')).toThrow(TypeError);
    });

    it('rejects an empty-string code', () => {
      // An empty code is not "no code": it is a lookup key that can never
      // match RETRYABLE_CODES and produces a blank metrics label.
      expect(() => new KycWebhookError('x', 400, '')).toThrow(TypeError);
    });

    it('rejects non-string codes', () => {
      expect(() => new KycWebhookError('x', 400, 0)).toThrow(TypeError);
      expect(() => new KycWebhookError('x', 400, null)).toThrow(TypeError);
      expect(() => new KycWebhookError('x', 400, { code: 'x' })).toThrow(TypeError);
      expect(() => new KycWebhookError('x', 400, ['code'])).toThrow(TypeError);
    });

    it('throws TypeError specifically, and never a partially-built error', () => {
      let caught;
      try {
        new KycWebhookError('x', 999, 'code');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught).not.toBeInstanceOf(KycWebhookError);
    });
  });

  describe('immutability of the routing invariants', () => {
    it('ignores an attempt to reassign status', () => {
      const err = new KycWebhookError('x', 400, 'code');

      expect(() => {
        err.status = 500;
      }).toThrow(TypeError);
      expect(err.status).toBe(400);
    });

    it('ignores an attempt to reassign code', () => {
      const err = new KycWebhookError('x', 400, 'code');

      expect(() => {
        err.code = 'tampered';
      }).toThrow(TypeError);
      expect(err.code).toBe('code');
    });

    it('ignores an attempt to reassign name', () => {
      const err = new KycWebhookError('x', 400, 'code');

      expect(() => {
        err.name = 'SomethingElse';
      }).toThrow(TypeError);
      expect(err.name).toBe('KycWebhookError');
    });

    it('cannot have its invariants redefined', () => {
      const err = new KycWebhookError('x', 400, 'code');

      expect(() =>
        Object.defineProperty(err, 'status', {
          value: 500,
          writable: true,
          enumerable: true,
          configurable: true,
        }),
      ).toThrow(TypeError);
      expect(err.status).toBe(400);
    });

    it('cannot have its invariants deleted', () => {
      const err = new KycWebhookError('x', 400, 'code');

      expect(() => {
        delete err.status;
      }).toThrow(TypeError);
      expect(err.status).toBe(400);
    });

    it('leaves the error extensible for unrelated annotations', () => {
      // Only the routing invariants are locked; handlers are still free to
      // hang correlation context off the error for logging.
      const err = new KycWebhookError('x', 400, 'code');
      err.correlationId = 'corr-1';

      expect(err.correlationId).toBe('corr-1');
    });

    it('keeps invariants stable across repeated reads', () => {
      const err = new KycWebhookError('x', 503, 'missing_secret');
      const first = [err.status, err.code, err.name];
      const second = [err.status, err.code, err.name];

      expect(first).toEqual(second);
      expect(first).toEqual([503, 'missing_secret', 'KycWebhookError']);
    });
  });

  describe('serialisation and telemetry footprint', () => {
    it('keeps name, status, and code enumerable', () => {
      const err = new KycWebhookError('x', 400, 'code');

      expect(Object.keys(err).sort()).toEqual(['code', 'name', 'status']);
    });

    it('serialises to a stable JSON shape', () => {
      const err = new KycWebhookError('x', 429, 'RATE_LIMITED');

      expect(JSON.parse(JSON.stringify(err))).toEqual({
        name: 'KycWebhookError',
        status: 429,
        code: 'RATE_LIMITED',
      });
    });

    it('exposes a string name for telemetry redaction', () => {
      // telemetryRedaction reads `err.name` and falls back to 'Error' when it
      // is not a string, so this must never become a non-string.
      const err = new KycWebhookError('x', 500, 'persistence_error');
      expect(typeof err.name).toBe('string');
    });
  });

  describe('diagnostics without leaking values', () => {
    it('names the offending argument in the message', () => {
      expect(() => new KycWebhookError('x', 999, 'code')).toThrow(/status/);
      expect(() => new KycWebhookError(42, 400, 'code')).toThrow(/message/);
      expect(() => new KycWebhookError('x', 400, 0)).toThrow(/code/);
    });

    it('reports the accepted status range', () => {
      expect(() => new KycWebhookError('x', 200, 'code')).toThrow(/400/);
      expect(() => new KycWebhookError('x', 200, 'code')).toThrow(/599/);
    });

    it('does not echo an object passed as the message', () => {
      const leak = { signature: 'sig-do-not-log', secret: 'whsec_do_not_log' };
      let message = '';
      try {
        new KycWebhookError(leak, 401, 'invalid_signature');
      } catch (err) {
        message = err.message;
      }
      expect(message).not.toMatch(/sig-do-not-log/);
      expect(message).not.toMatch(/whsec_do_not_log/);
      expect(message).toMatch(/object/);
    });

    it('describes a string value by length rather than content', () => {
      expect(() => new KycWebhookError('x', '404', 'code')).toThrow(/3 characters/);
      expect(() => new KycWebhookError('x', '', 'code')).toThrow(/an empty string/);
    });
  });

  describe('exported range constants', () => {
    it('exposes the validated status bounds', () => {
      expect(KycWebhookError.MIN_STATUS).toBe(400);
      expect(KycWebhookError.MAX_STATUS).toBe(599);
    });
  });
});
