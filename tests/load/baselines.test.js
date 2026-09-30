/**
 * tests/load/baselines.test.js
 *
 * Load baseline assertions for hot endpoints (marketplace, invest/opportunities).
 * These tests are gated behind ENABLE_LOAD_BASELINES=true to prevent execution in the default test suite.
 *
 * Run with:
 *   ENABLE_LOAD_BASELINES=true npm test -- baselines.test.js
 *
 * The suite validates p99 latency and error-rate ceilings against preconfigured thresholds.
 */

const autocannon = require('autocannon');
const { loadLoadTestConfig, getLoadScenarios } = require('./config');

describe('Load baseline assertions', () => {
  // Skip this entire suite unless explicitly enabled to prevent slowing down the default test path.
  const isEnabled = process.env.ENABLE_LOAD_BASELINES === 'true';
  const describeTest = isEnabled ? describe : describe.skip;

  describeTest('Marketplace and invest endpoints', () => {
    let config;
    let allScenarios;
    let targetScenarios;

    beforeAll(() => {
      config = loadLoadTestConfig();
      allScenarios = getLoadScenarios(config);
      // Filter to hot endpoints: marketplace and invest-opportunities
      targetScenarios = allScenarios.filter((s) =>
        s.name === 'marketplace' || s.name === 'invest-opportunities'
      );
    });

    test.each(targetScenarios)('$name: asserts p99 latency and error-rate thresholds', async (scenario) => {
      const threshold = config.thresholds[scenario.name];
      expect(threshold).toBeDefined();

      const result = await runScenario(config, scenario);
      const p99LatencyMs = result.latency.p99 || result.latency.p99_9;
      const errorRate = ((result.errors + result.non2xx) / result.requests.total) * 100;

      // Assert p99 latency ceiling
      expect(p99LatencyMs).toBeLessThanOrEqual(threshold.p99LatencyMs);

      // Assert error-rate ceiling
      expect(errorRate).toBeLessThanOrEqual(threshold.maxErrorRate);
    });
  });
});

/**
 * Execute one autocannon scenario.
 *
 * @param {object} config Runtime configuration.
 * @param {{name: string, method: string, path: string, headers: object, body?: string}} scenario Scenario definition.
 * @returns {Promise<object>}
 */
function runScenario(config, scenario) {
  return autocannon({
    url: new URL(scenario.path, config.baseUrl).toString(),
    method: scenario.method,
    headers: scenario.headers,
    body: scenario.body,
    connections: config.connections,
    duration: config.durationSeconds,
    timeout: config.timeoutSeconds,
  });
}
