// ============================================
// XERIS PROOF - CHAIN CONNECTOR v7.0
// ============================================
// Real transaction signing for Xeris Network
// Solana-compatible Ed25519 transactions
// ============================================

const http = require('http');
const crypto = require('crypto');

// ─── NETWORK CONFIGURATION (from config.js) ─────────────────────────

const { network, isTestnet } = require('./config');

const EXPLORER_URL = network.explorerUrl;
const NETWORK_URL = network.networkUrl;
const LAMPORTS_PER_XRS = 1_000_000_000;

console.log(`[CHAIN] Xeris Network v7: ${EXPLORER_URL}`);

// ─── HTTP HELPER ─────────────────────────────────────────────────────

function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);

        const bodyStr = options.body
            ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
            : null;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 80,
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
                ...options.headers
            },
            timeout: options.timeout || 15000
        };

        const req = http.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data, json: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data, json: null });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });

        if (bodyStr) {
            req.write(bodyStr);
        }
        req.end();
    });
}

// ─── JSON-RPC HELPER ─────────────────────────────────────────────────

async function rpcCall(method, params = []) {
    const res = await httpRequest(EXPLORER_URL, {
        method: 'POST',
        body: {
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params
        },
        timeout: 10000
    });

    if (res.json && res.json.result !== undefined) {
        return res.json.result;
    }
    if (res.json && res.json.error) {
        throw new Error(res.json.error.message || 'RPC error');
    }
    throw new Error('Invalid RPC response');
}

// ─── BASE58 ENCODING ─────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
    if (buffer.length === 0) return '';
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

    const size = Math.ceil((bytes.length - zeros) * 138 / 100) + 1;
    const b58 = new Uint8Array(size);

    let length = 0;
    for (let i = zeros; i < bytes.length; i++) {
        let carry = bytes[i];
        let j = 0;
        for (let k = size - 1; k >= 0; k--, j++) {
            if (carry === 0 && j >= length) break;
            carry += 256 * b58[k];
            b58[k] = carry % 58;
            carry = Math.floor(carry / 58);
        }
        length = j;
    }

    let result = '1'.repeat(zeros);
    for (let i = size - length; i < size; i++) {
        result += BASE58_ALPHABET[b58[i]];
    }
    return result;
}

function base58Decode(str) {
    if (str.length === 0) return Buffer.alloc(0);

    let zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros++;

    const size = Math.ceil((str.length - zeros) * 733 / 1000) + 1;
    const bytes = new Uint8Array(size);

    let length = 0;
    for (let i = zeros; i < str.length; i++) {
        const index = BASE58_ALPHABET.indexOf(str[i]);
        if (index < 0) throw new Error('Invalid base58 character');

        let carry = index;
        let j = 0;
        for (let k = size - 1; k >= 0; k--, j++) {
            if (carry === 0 && j >= length) break;
            carry += 58 * bytes[k];
            bytes[k] = carry % 256;
            carry = Math.floor(carry / 256);
        }
        length = j;
    }

    const result = Buffer.alloc(zeros + length);
    for (let i = 0; i < length; i++) {
        result[zeros + i] = bytes[size - length + i];
    }
    return result;
}

// ─── CHAIN CONNECTOR CLASS ───────────────────────────────────────────

class ChainConnector {
    constructor() {
        this.explorerUrl = EXPLORER_URL;
        this.networkUrl = NETWORK_URL;
        this.networkName = network.name;
        this.isTestnet = isTestnet;
    }

    async getRecentBlockhash() {
        try {
            const blocks = await this.getBlocks(1);
            if (blocks.length > 0 && blocks[0].hash) {
                const raw = blocks[0].hash;
                let hashStr;
                if (Array.isArray(raw) && raw.length === 32) {
                    hashStr = base58Encode(Buffer.from(raw));
                } else if (typeof raw === 'string' && raw.length > 0) {
                    hashStr = raw;
                } else {
                    throw new Error('Unexpected hash format: ' + typeof raw);
                }
                console.log(`[CHAIN] Blockhash: ${hashStr.substring(0, 16)}...`);
                return hashStr;
            }
        } catch (e) {
            console.log(`[CHAIN] /blocks blockhash failed: ${e.message}`);
        }

        try {
            const result = await rpcCall('getRecentBlockhash');
            const hash = result?.value?.blockhash || result?.blockhash;
            if (hash) return hash;
        } catch (e) {}

        try {
            const result = await rpcCall('getLatestBlockhash');
            const hash = result?.value?.blockhash || result?.blockhash;
            if (hash) return hash;
        } catch (e) {}

        throw new Error('Could not get blockhash');
    }

    async getBalance(address) {
        if (!address) return { balance: 0, balanceXRS: 0, staked: 0, stakedXRS: 0 };
        console.log(`[CHAIN] Getting balance: ${address.substring(0, 12)}...`);

        try {
            const res = await httpRequest(`${this.explorerUrl}/v2/account/${address}`, { timeout: 8000 });
            if (res.json?.success && res.json.data) {
                const balance = parseInt(res.json.data.balance) || 0;
                const staked = parseInt(res.json.data.staked) || 0;
                return { balance, balanceXRS: balance / LAMPORTS_PER_XRS, staked, stakedXRS: staked / LAMPORTS_PER_XRS };
            }
        } catch (e) {}

        try {
            const res = await httpRequest(`${this.explorerUrl}/wallet/${address}`, { timeout: 8000 });
            if (res.json?.balance !== undefined) {
                const balance = parseInt(res.json.balance) || 0;
                const isXRS = res.json.unit === 'XRS';
                return {
                    balance: isXRS ? balance * LAMPORTS_PER_XRS : balance,
                    balanceXRS: isXRS ? balance : balance / LAMPORTS_PER_XRS,
                    staked: 0, stakedXRS: 0
                };
            }
        } catch (e) {}

        return { balance: 0, balanceXRS: 0, staked: 0, stakedXRS: 0 };
    }

    async getBlocks(limit = 10) {
        try {
            const res = await httpRequest(`${this.explorerUrl}/v2/blocks?limit=${limit}`, { timeout: 10000 });
            if (res.json?.success && Array.isArray(res.json.data)) return res.json.data;
        } catch (e) {}

        try {
            const res = await httpRequest(`${this.explorerUrl}/blocks?limit=${limit}`, { timeout: 10000 });
            if (Array.isArray(res.json)) return res.json;
        } catch (e) {}

        try {
            const res = await httpRequest(`${this.networkUrl}/blocks?limit=${limit}`, { timeout: 10000 });
            if (Array.isArray(res.json)) return res.json;
        } catch (e) {}

        return [];
    }

    async getLatestBlock() {
        const blocks = await this.getBlocks(1);
        if (blocks.length > 0) {
            return {
                height: blocks[0].slot || blocks[0].blockNumber || 0,
                hash: blocks[0].hash,
                timestamp: blocks[0].poh_timestamp || Date.now()
            };
        }
        return null;
    }

    async getChainInfo() {
        try {
            const res = await httpRequest(`${this.explorerUrl}/v2/stats`, { timeout: 8000 });
            if (res.json?.success && res.json.data) {
                const d = res.json.data;
                return {
                    blockHeight: d.block_height || d.current_slot || 0,
                    currentSlot: d.current_slot || 0,
                    totalTransactions: d.total_transactions || 0,
                    totalAccounts: d.total_accounts || 0,
                    tps: d.tps_estimate || 0,
                    network: this.networkName,
                    badge: network.badge,
                    connected: true
                };
            }
        } catch (e) {}

        const latest = await this.getLatestBlock();
        return {
            blockHeight: latest?.height || 0,
            network: this.networkName,
            badge: network.badge,
            connected: !!latest
        };
    }

    async confirmTransaction(signature, maxAttempts = 5, delayMs = 2000) {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const result = await rpcCall('getTransaction', [signature]);
                if (result && result.slot) {
                    console.log(`[CHAIN] Confirmed tx in slot ${result.slot} (attempt ${i + 1})`);
                    return { confirmed: true, slot: result.slot, blockTime: result.blockTime };
                }
            } catch (e) {}

            try {
                const res = await httpRequest(`${this.explorerUrl}/v2/tx/${signature}`, { timeout: 5000 });
                if (res.json?.success && res.json.data?.block_slot) {
                    console.log(`[CHAIN] Confirmed tx in slot ${res.json.data.block_slot} via REST (attempt ${i + 1})`);
                    return { confirmed: true, slot: res.json.data.block_slot, blockTime: res.json.data.poh_timestamp };
                }
            } catch (e) {}

            if (i < maxAttempts - 1) {
                console.log(`[CHAIN] Tx not confirmed yet, retrying in ${delayMs}ms (attempt ${i + 1}/${maxAttempts})`);
                await this._sleep(delayMs);
            }
        }
        console.log(`[CHAIN] Could not confirm tx after ${maxAttempts} attempts`);
        return { confirmed: false, slot: null, blockTime: null };
    }

    async submitSignedTransaction(params) {
        const { txBase64, signature } = params;
        console.log(`[CHAIN] Submitting pre-signed transaction...`);

        let submitted = false;
        let blockNumber = null;

        try {
            const res = await httpRequest(`${this.networkUrl}/submit`, {
                method: 'POST',
                body: { tx_base64: txBase64 },
                timeout: 20000
            });
            console.log(`[CHAIN] Submit status: ${res.status}`);
            if (res.status === 200) {
                if (res.json && res.json.error) {
                    console.log(`[CHAIN] Node rejected tx: ${res.json.error}`);
                    submitted = false;
                } else {
                    submitted = true;
                }
            }
        } catch (e) {
            console.log(`[CHAIN] Submit error: ${e.message}`);
        }

        if (submitted && signature) {
            const confirmation = await this.confirmTransaction(signature);
            if (confirmation.confirmed) {
                blockNumber = confirmation.slot;
            }
        }

        if (!blockNumber) {
            await this._sleep(1500);
            try {
                const latest = await this.getLatestBlock();
                blockNumber = latest?.height || null;
            } catch (e) {
                blockNumber = null;
            }
        }

        return {
            success: submitted,
            submitted,
            blockNumber,
            timestamp: Date.now(),
            network: this.networkName
        };
    }

    async _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    lamportsToXRS(l) { return (parseInt(l) || 0) / LAMPORTS_PER_XRS; }
    xrsToLamports(x) { return Math.floor((parseFloat(x) || 0) * LAMPORTS_PER_XRS); }
}

module.exports = ChainConnector;
