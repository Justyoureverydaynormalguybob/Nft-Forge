// ============================================
// XERIS PROOF - NETWORK CONFIGURATION
// ============================================
// Exports: { network, isTestnet, ACTIVE_NETWORK }
// ============================================

const NETWORKS = {
    testnet: {
        name: 'Xeris Testnet',
        host: '138.197.116.81',
        explorerPort: 50008,
        networkPort: 56001,
        badge: 'TESTNET',
        chainId: 'xeris-testnet-v1',
        ssl: false
    },
    mainnet: {
        name: 'Xeris Mainnet',
        host: 'rpc.xeris.io',
        explorerPort: 50008,
        networkPort: 56001,
        badge: 'MAINNET',
        chainId: 'xeris-mainnet-v1',
        ssl: true
    }
};

const ACTIVE_NETWORK = process.env.XERIS_NETWORK || 'testnet';
const net = NETWORKS[ACTIVE_NETWORK];
const proto = net.ssl ? 'https' : 'http';

const network = {
    ...net,
    explorerUrl: `${proto}://${net.host}:${net.explorerPort}`,
    networkUrl: `${proto}://${net.host}:${net.networkPort}`
};

const isTestnet = ACTIVE_NETWORK === 'testnet';

module.exports = {
    network,
    isTestnet,
    ACTIVE_NETWORK,
    NETWORKS
};
