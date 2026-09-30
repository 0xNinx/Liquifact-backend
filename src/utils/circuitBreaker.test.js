const { CircuitBreaker, CircuitBreakerState } = require('./circuitBreaker');

describe('CircuitBreaker', () => {
    let cb;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        cb = new CircuitBreaker({
            failureThreshold: 3,
            recoveryTimeout: 5000
        });
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    describe('state transitions', () => {
        it('should execute successfully in CLOSED state', async () => {
            const operation = jest.fn().mockResolvedValue('success');
            const result = await cb.execute(operation);

            expect(result).toBe('success');
            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(0);
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should transition from CLOSED to OPEN after reaching failure threshold', async () => {
            const operation = jest.fn().mockRejectedValue(new Error('failure'));

            await expect(cb.execute(operation)).rejects.toThrow('failure');
            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(1);

            await expect(cb.execute(operation)).rejects.toThrow('failure');
            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(2);

            await expect(cb.execute(operation)).rejects.toThrow('failure');
            expect(cb.state).toBe(CircuitBreakerState.OPEN);
            expect(cb.failureCount).toBe(3);
        });

        it('should fail fast when in OPEN state without calling operation', async () => {
            cb.state = CircuitBreakerState.OPEN;
            cb.nextAttemptTime = Date.now() + 5000;

            const operation = jest.fn();

            let caughtError;
            try {
                await cb.execute(operation);
            } catch (err) {
                caughtError = err;
            }

            expect(caughtError).toBeDefined();
            expect(caughtError.message).toBe('Circuit Breaker is OPEN. Operation failed fast.');
            expect(caughtError.code).toBe('CIRCUIT_OPEN');
            expect(operation).not.toHaveBeenCalled();
        });

        it('should use fallback logic if provided and circuit is OPEN', async () => {
            cb = new CircuitBreaker({
                failureThreshold: 1,
                recoveryTimeout: 10000,
                fallbackLogic: () => 'fallback data'
            });

            const operation = jest.fn().mockRejectedValue(new Error('failure'));

            const result1 = await cb.execute(operation);
            expect(result1).toBe('fallback data');
            expect(cb.state).toBe(CircuitBreakerState.OPEN);

            const result2 = await cb.execute(operation);
            expect(result2).toBe('fallback data');
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should transition to HALF_OPEN after recovery timeout', async () => {
            cb.state = CircuitBreakerState.OPEN;
            cb.nextAttemptTime = Date.now() - 1;

            const operation = jest.fn().mockResolvedValue('success in half open');

            const result = await cb.execute(operation);

            expect(result).toBe('success in half open');
            expect(operation).toHaveBeenCalledTimes(1);
            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(0);
        });

        it('should transition back to OPEN if HALF_OPEN operation fails', async () => {
            cb.state = CircuitBreakerState.OPEN;
            cb.nextAttemptTime = Date.now() - 1;

            const operation = jest.fn().mockRejectedValue(new Error('failed again'));

            await expect(cb.execute(operation)).rejects.toThrow('failed again');

            expect(operation).toHaveBeenCalledTimes(1);
            expect(cb.state).toBe(CircuitBreakerState.OPEN);
            expect(cb.failureCount).toBe(1);
        });

        it('should trigger onStateChange callback upon state transitions', async () => {
            const onStateChange = jest.fn();
            cb = new CircuitBreaker({
                failureThreshold: 1,
                recoveryTimeout: 5000,
                onStateChange
            });

            const operation = jest.fn().mockRejectedValue(new Error('failure'));

            await expect(cb.execute(operation)).rejects.toThrow('failure');
            expect(onStateChange).toHaveBeenCalledWith(CircuitBreakerState.CLOSED, CircuitBreakerState.OPEN);

            await expect(cb.execute(operation)).rejects.toThrow('Circuit Breaker is OPEN. Operation failed fast.');
            expect(onStateChange).toHaveBeenCalledTimes(1);

            jest.setSystemTime(Date.now() + 5001);
            operation.mockResolvedValue('success');
            await cb.execute(operation);

            expect(onStateChange).toHaveBeenCalledWith(CircuitBreakerState.OPEN, CircuitBreakerState.HALF_OPEN);
            expect(onStateChange).toHaveBeenCalledWith(CircuitBreakerState.HALF_OPEN, CircuitBreakerState.CLOSED);
            expect(onStateChange).toHaveBeenCalledTimes(3);
        });
    });

    describe('name option', () => {
        it('should default to "default" when no name is provided', () => {
            expect(cb.name).toBe('default');
        });

        it('should accept a custom name for metric label distinction', () => {
            const sorobanBreaker = new CircuitBreaker({ name: 'soroban' });
            expect(sorobanBreaker.name).toBe('soroban');

            const redisBreaker = new CircuitBreaker({ name: 'redis' });
            expect(redisBreaker.name).toBe('redis');
        });
    });

    describe('reset()', () => {
        it('should force breaker back to CLOSED when in OPEN state', async () => {
            const operation = jest.fn().mockRejectedValue(new Error('fail'));
            cb.failureThreshold = 1;
            await expect(cb.execute(operation)).rejects.toThrow('fail');
            expect(cb.state).toBe(CircuitBreakerState.OPEN);

            cb.reset();

            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(0);
        });

        it('should clear failure count and allow subsequent operations', async () => {
            const operation = jest.fn().mockRejectedValue(new Error('fail'));
            cb.failureThreshold = 1;
            await expect(cb.execute(operation)).rejects.toThrow('fail');
            expect(cb.failureCount).toBe(1);

            cb.reset();

            expect(cb.failureCount).toBe(0);
            expect(cb.state).toBe(CircuitBreakerState.CLOSED);

            const goodOp = jest.fn().mockResolvedValue('ok');
            const result = await cb.execute(goodOp);
            expect(result).toBe('ok');
        });

        it('should work when breaker is already CLOSED (idempotent)', () => {
            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(0);

            cb.reset();

            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(0);
        });

        it('should work when breaker is HALF_OPEN', async () => {
            cb.state = CircuitBreakerState.OPEN;
            cb.nextAttemptTime = Date.now() - 1;
            const op = jest.fn().mockRejectedValue(new Error('fail'));
            await expect(cb.execute(op)).rejects.toThrow('fail');
            expect(cb.state).toBe(CircuitBreakerState.OPEN);

            cb.reset();
            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            expect(cb.failureCount).toBe(0);
        });

        it('should fire onStateChange callback when resetting from OPEN to CLOSED', async () => {
            const onStateChange = jest.fn();
            cb = new CircuitBreaker({ failureThreshold: 1, recoveryTimeout: 5000, onStateChange });

            const op = jest.fn().mockRejectedValue(new Error('fail'));
            await expect(cb.execute(op)).rejects.toThrow('fail');
            expect(cb.state).toBe(CircuitBreakerState.OPEN);

            onStateChange.mockClear();
            cb.reset();

            expect(onStateChange).toHaveBeenCalledTimes(1);
            expect(onStateChange).toHaveBeenCalledWith(CircuitBreakerState.OPEN, CircuitBreakerState.CLOSED);
        });

        it('should not fire onStateChange if already CLOSED (no actual transition)', () => {
            const onStateChange = jest.fn();
            cb = new CircuitBreaker({ failureThreshold: 1, onStateChange });

            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            cb.reset();

            expect(onStateChange).not.toHaveBeenCalled();
        });
    });

    describe('metrics emission', () => {
        it('should emit metrics on state transitions with breaker name and state labels', async () => {
            const metrics = require('../metrics');

            const operation = jest.fn().mockRejectedValue(new Error('fail'));
            cb.name = 'test-breaker';
            cb.failureThreshold = 1;

            await expect(cb.execute(operation)).rejects.toThrow('fail');

            const metric = metrics.sorobanCircuitBreakerStateTransitionsTotal;
            expect(metric).toBeDefined();
        });

        it('should emit metric for HALF_OPEN and back to CLOSED', async () => {
            const metrics = require('../metrics');

            cb.name = 'test-breaker';
            cb.state = CircuitBreakerState.OPEN;
            cb.nextAttemptTime = Date.now() - 1;

            const op = jest.fn().mockResolvedValue('recovered');
            await cb.execute(op);

            expect(cb.state).toBe(CircuitBreakerState.CLOSED);
            const metric = metrics.sorobanCircuitBreakerStateTransitionsTotal;
            expect(metric).toBeDefined();
        });
    });

    describe('metrics shim path (no prom-client)', () => {
        it('should work when metrics module throws on require', () => {
            const RealDateNow = Date.now;
            jest.resetModules();

            jest.isolateModules(() => {
                jest.mock('../metrics', () => {
                    throw new Error('metrics unavailable');
                });

                const { CircuitBreaker: Cb, CircuitBreakerState: State } = require('./circuitBreaker');
                const breaker = new Cb({ failureThreshold: 1 });

                expect(breaker.state).toBe(State.CLOSED);
                expect(breaker.name).toBe('default');

                breaker._transitionState(State.OPEN);
                expect(breaker.state).toBe(State.OPEN);
            });

            Date.now = RealDateNow;
        });
    });

    describe('execute() contract preserved', () => {
        it('should return fallback on OPEN state when fallbackLogic is set', async () => {
            cb = new CircuitBreaker({
                failureThreshold: 1,
                fallbackLogic: () => 'cached-data'
            });

            const op = jest.fn().mockRejectedValue(new Error('fail'));
            const result = await cb.execute(op);

            expect(result).toBe('cached-data');
            expect(cb.state).toBe(CircuitBreakerState.OPEN);
        });

        it('should throw CIRCUIT_OPEN error when no fallback is provided', async () => {
            cb.state = CircuitBreakerState.OPEN;
            cb.nextAttemptTime = Date.now() + 10000;

            await expect(cb.execute(jest.fn()))
                .rejects
                .toThrow('Circuit Breaker is OPEN. Operation failed fast.');
        });
    });
});
