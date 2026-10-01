const config = require('./index');

/**
 * Valid Stellar networks.
 * @constant {string[]}
 */
const VALID_NETWORKS = ['TESTNET', 'MAINNET', 'FUTURENET'];

/**
 * Canonical RPC URLs for each network.
 * @constant {Object.<string, string>}
 */
const NETWORK_RPC_MAP = Object.freeze({
  TESTNET: 'https://soroban-testnet.stellar.org',
  MAINNET: 'https://soroban.stellar.org',
  FUTURENET: 'https://rpc-futurenet.stellar.org',
});

/**
 * Canonical network passphrases for each network.
 * @constant {Object.<string, string>}
 */
const NETWORK_PASSPHRASE_MAP = Object.freeze({
  TESTNET: 'Test SDF Network ; September 2015',
  MAINNET: 'Public Global Stellar Network ; September 2014',
  FUTURENET: 'Test SDF Future Network ; October 2022',
});

/**
 * Cached stellar configuration to prevent race conditions on concurrent reads.
 * @type {Object|null}
 * @private
 */
let cachedStellarConfig = null;

/**
 * @invariant v1.0 - Cached config is immutable after first successful read
 * @invariant v1.0 - Concurrent calls to getStellarConfig return identical results
 * @invariant v1.0 - Network/RPC mismatch is validated at boot time
 */

/**
 * Validates Stellar network configuration against environment variables.
 * Ensures network and RPC URL are a matched pair to prevent on-chain validation failures.
 *
 * @throws {Error} If STELLAR_NETWORK or SOROBAN_RPC_URL is missing or mismatched.
 * @returns {{network: string, rpcUrl: string, passphrase: string}} Validated configuration.
 */
function validateStellarConfig() {
  const network = process.env.STELLAR_NETWORK;
  const rpcUrl = process.env.SOROBAN_RPC_URL;

  if (!network) {
    throw new Error('STELLAR_NETWORK is required');
  }
  if (!rpcUrl) {
    throw new Error('SOROBAN_RPC_URL is required');
  }
  if (!VALID_NETWORKS.includes(network)) {
    throw new Error(`Invalid STELLAR_NETWORK: ${network}`);
  }

  const expectedRpc = NETWORK_RPC_MAP[network];
  if (rpcUrl !== expectedRpc) {
    throw new Error(
      `Mismatch: STELLAR_NETWORK=${network} requires SOROBAN_RPC_URL="${expectedRpc}", but got "${rpcUrl}". This combination would cause on-chain validation failures.`
    );
  }

  return {
    network,
    rpcUrl,
    passphrase: NETWORK_PASSPHRASE_MAP[network],
  };
}

/**
 * Returns the canonical passphrase for a known network.
 *
 * @param {string} network - Network name (TESTNET, MAINNET, FUTURENET).
 * @throws {Error} If network is unknown.
 * @returns {string} Network passphrase.
 */
function getNetworkPassphrase(network) {
  if (!network || !VALID_NETWORKS.includes(network)) {
    throw new Error(`Unknown network: ${network}`);
  }
  return NETWORK_PASSPHRASE_MAP[network];
}

/**
 * Returns the canonical RPC URL for a known network.
 *
 * @param {string} network - Network name (TESTNET, MAINNET, FUTURENET).
 * @throws {Error} If network is unknown.
 * @returns {string} RPC URL.
 */
function getExpectedRpc(network) {
  if (!network || !VALID_NETWORKS.includes(network)) {
    throw new Error(`Unknown network: ${network}`);
  }
  return NETWORK_RPC_MAP[network];
}

/**
 * Get Stellar-specific configuration.
 * Uses singleton caching to ensure concurrent calls return identical results.
 * Ensures fail-fast behavior if config wasn't validated on boot.
 *
 * @returns {{rpcUrl: string, networkPassphrase: string}} The Stellar configuration object.
 */
function getStellarConfig() {
  if (cachedStellarConfig) {
    return cachedStellarConfig;
  }

  const { SOROBAN_RPC_URL, NETWORK_PASSPHRASE } = config.get();
  const stellarConfig = Object.freeze({
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  cachedStellarConfig = stellarConfig;
  return stellarConfig;
}

module.exports = {
  getStellarConfig,
  validateStellarConfig,
  getNetworkPassphrase,
  getExpectedRpc,
  VALID_NETWORKS,
  NETWORK_RPC_MAP,
  NETWORK_PASSPHRASE_MAP,
};