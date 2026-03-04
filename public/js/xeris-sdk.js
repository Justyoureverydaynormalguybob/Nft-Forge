// ============================================
// XERIS SDK — Browser Edition (from xeris-sdk v1.4.0)
// https://github.com/ZZachWWins/xeris-sdk
// ============================================
// Browser-compatible XerisDApp class for wallet
// integration via the Xeris Command Center wallet.
// Uses xeris-tx.js primitives for instruction encoding.
// ============================================

const LAMPORTS_PER_XRS = 1_000_000_000;
const TESTNET_SEED = '138.197.116.81';
const DEFAULT_RPC_PORT = 56001;
const DEFAULT_EXPLORER_PORT = 50008;

class XerisDApp {
    constructor(opts = {}) {
        const network = opts.network || 'testnet';
        const host = network === 'testnet' ? TESTNET_SEED : (opts.host || TESTNET_SEED);

        this._rpcUrl = opts.rpcUrl || `http://${host}:${DEFAULT_RPC_PORT}`;
        this._explorerUrl = opts.explorerUrl || `http://${host}:${DEFAULT_EXPLORER_PORT}`;
        this._network = network;
        this._provider = null;
        this._publicKey = null;
        this._connected = false;
        this._listeners = {};
    }

    // ─── PROPERTIES ─────────────────────────────────────────────

    get publicKey() { return this._publicKey; }
    get connected() { return this._connected; }
    get provider() { return this._provider; }
    get rpcUrl() { return this._rpcUrl; }
    get explorerUrl() { return this._explorerUrl; }

    // ─── PROVIDER DETECTION ─────────────────────────────────────

    static detectProvider() {
        if (typeof window === 'undefined') return null;
        if (window.xeris) return window.xeris;
        if (window.solana && window.solana.isXeris) return window.solana;
        if (window.solana) return window.solana;
        return null;
    }

    static waitForProvider(timeoutMs = 3000) {
        return new Promise((resolve) => {
            const existing = XerisDApp.detectProvider();
            if (existing) return resolve(existing);

            const interval = setInterval(() => {
                const p = XerisDApp.detectProvider();
                if (p) {
                    clearInterval(interval);
                    resolve(p);
                }
            }, 100);

            // Listen for wallet-standard ready event
            const handler = () => {
                const p = XerisDApp.detectProvider();
                if (p) {
                    clearInterval(interval);
                    resolve(p);
                }
            };
            window.addEventListener('wallet-standard:app-ready', handler, { once: true });

            setTimeout(() => {
                clearInterval(interval);
                window.removeEventListener('wallet-standard:app-ready', handler);
                resolve(null);
            }, timeoutMs);
        });
    }

    // ─── CONNECTION ─────────────────────────────────────────────

    async connect(opts = {}) {
        // Detect provider
        this._provider = XerisDApp.detectProvider();
        if (!this._provider) {
            this._provider = await XerisDApp.waitForProvider(2000);
        }

        if (!this._provider) {
            throw new Error(
                'Xeris wallet not found. Please install the Xeris Command Center browser extension or open in the Xeris Wallet Browser.'
            );
        }

        // Connect to wallet (triggers popup)
        const result = await this._provider.connect({
            onlyIfTrusted: opts.onlyIfTrusted || false
        });

        // Extract public key
        if (result && result.publicKey) {
            this._publicKey = typeof result.publicKey === 'string'
                ? result.publicKey
                : result.publicKey.toString();
        } else if (typeof result === 'string') {
            this._publicKey = result;
        } else {
            throw new Error('No public key returned from wallet');
        }

        this._connected = true;

        // Try to get RPC URL from provider
        if (this._provider.getRpcUrl) {
            try {
                const rpcUrl = await this._provider.getRpcUrl();
                if (rpcUrl) {
                    this._rpcUrl = rpcUrl;
                    // Derive explorer URL
                    const url = new URL(rpcUrl);
                    this._explorerUrl = `${url.protocol}//${url.hostname}:${DEFAULT_EXPLORER_PORT}`;
                }
            } catch (e) { /* use defaults */ }
        }

        // Subscribe to wallet events
        if (this._provider.on) {
            this._provider.on('disconnect', () => {
                this._connected = false;
                this._publicKey = null;
                this._emit('disconnect');
            });

            this._provider.on('accountChanged', (newPubkey) => {
                if (newPubkey) {
                    this._publicKey = typeof newPubkey === 'string'
                        ? newPubkey
                        : newPubkey.toString();
                    this._emit('accountChanged', this._publicKey);
                } else {
                    this._connected = false;
                    this._publicKey = null;
                    this._emit('disconnect');
                }
            });
        }

        this._emit('connect', this._publicKey);
        return this._publicKey;
    }

    async disconnect() {
        if (this._provider && this._provider.disconnect) {
            try { await this._provider.disconnect(); } catch (e) { /* ignore */ }
        }
        this._connected = false;
        this._publicKey = null;
        this._emit('disconnect');
    }

    // ─── EVENT SYSTEM ───────────────────────────────────────────

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    }

    _emit(event, ...args) {
        if (!this._listeners[event]) return;
        this._listeners[event].forEach(cb => {
            try { cb(...args); } catch (e) { console.error('Event listener error:', e); }
        });
    }

    // ─── REQUIRE CONNECTED ──────────────────────────────────────

    _requireConnected() {
        if (!this._connected || !this._publicKey) {
            throw new Error('Wallet not connected. Call connect() first.');
        }
    }

    // ─── JSON-RPC HELPER ────────────────────────────────────────

    async _jsonRpc(method, params = []) {
        const res = await fetch(this._explorerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method,
                params
            })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        return data.result;
    }

    // ─── BLOCKHASH ──────────────────────────────────────────────

    async _getLatestBlockhash() {
        // Try via server proxy first (avoids CORS)
        try {
            const res = await fetch('/api/chain/blockhash');
            const data = await res.json();
            if (data.blockhash) return data.blockhash;
        } catch (e) { /* fallback to direct */ }

        // Direct JSON-RPC
        const result = await this._jsonRpc('getLatestBlockhash');
        const hash = result.value ? result.value.blockhash : result.blockhash || result;
        return typeof hash === 'string' ? hash : hash.toString();
    }

    // ─── TRANSACTION SENDING ────────────────────────────────────

    async sendInstruction(instructionData) {
        this._requireConnected();

        const blockhash = await this._getLatestBlockhash();

        // Convert hex blockhash to base58 if needed
        let blockhashB58 = blockhash;
        if (/^[0-9a-fA-F]+$/.test(blockhash) && blockhash.length === 64) {
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                bytes[i] = parseInt(blockhash.substring(i * 2, i * 2 + 2), 16);
            }
            blockhashB58 = XerisTx.base58Encode(bytes);
        }

        const signer32 = XerisTx.base58Decode(this._publicKey);
        const blockhash32 = XerisTx.base58Decode(blockhashB58);

        if (signer32.length !== 32) throw new Error('Invalid signer public key');
        if (blockhash32.length !== 32) throw new Error('Invalid blockhash');

        // Build the Solana-compatible message
        const message = XerisTx.buildMessage(signer32, instructionData, blockhash32);

        // Try signAndSendTransaction first (wallet signs + submits)
        if (this._provider.signAndSendTransaction) {
            try {
                const unsignedTx = XerisTx.buildUnsignedTx(message);
                const result = await this._provider.signAndSendTransaction(unsignedTx);
                return {
                    signature: result.signature || result
                };
            } catch (e) {
                // Fall through to signTransaction
                if (!this._provider.signTransaction) throw e;
            }
        }

        // Fallback: sign transaction, then submit ourselves
        if (this._provider.signTransaction) {
            const unsignedTx = XerisTx.buildUnsignedTx(message);
            const signedTx = await this._provider.signTransaction(unsignedTx);

            // Convert to base64 for submission
            let txBase64;
            if (signedTx instanceof Uint8Array || signedTx instanceof ArrayBuffer) {
                const bytes = new Uint8Array(signedTx);
                txBase64 = btoa(String.fromCharCode(...bytes));
            } else if (typeof signedTx === 'string') {
                txBase64 = signedTx;
            } else {
                throw new Error('Unexpected signed transaction format');
            }

            // Submit to RPC
            const res = await fetch(this._rpcUrl + '/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tx_base64: txBase64 })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Transaction submission failed');
            return { signature: data.signature || data.hash || data };
        }

        throw new Error('Wallet does not support transaction signing');
    }

    // ─── SIGN MESSAGE (for auth) ────────────────────────────────

    async signMessage(message) {
        this._requireConnected();
        if (!this._provider.signMessage) {
            throw new Error('Wallet does not support message signing');
        }
        const msgBytes = typeof message === 'string'
            ? new TextEncoder().encode(message)
            : message;
        const result = await this._provider.signMessage(msgBytes);
        return result;
    }

    // ─── HIGH-LEVEL TRANSACTION METHODS ─────────────────────────

    async transferXrs(to, amountXrs) {
        this._requireConnected();
        const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
        const instrData = XerisTx.encodeNativeTransfer(this._publicKey, to, lamports);
        return this.sendInstruction(instrData);
    }

    async stakeXrs(amountXrs) {
        this._requireConnected();
        if (amountXrs < 1000) throw new Error('Minimum stake is 1,000 XRS');
        const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
        const instrData = XerisTx.encodeInstruction(9, [
            XerisTx.encodeBincodeString(this._publicKey),
            XerisTx.writeU64LE(lamports)
        ]);
        return this.sendInstruction(instrData);
    }

    async unstakeXrs(amountXrs) {
        this._requireConnected();
        const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
        const instrData = XerisTx.encodeInstruction(10, [
            XerisTx.encodeBincodeString(this._publicKey),
            XerisTx.writeU64LE(lamports)
        ]);
        return this.sendInstruction(instrData);
    }

    async transferToken(tokenId, to, amount, decimals = 9) {
        this._requireConnected();
        const scaledAmount = Math.round(amount * Math.pow(10, decimals));
        const instrData = XerisTx.encodeInstruction(1, [
            XerisTx.encodeBincodeString(tokenId),
            XerisTx.encodeBincodeString(this._publicKey),
            XerisTx.encodeBincodeString(to),
            XerisTx.writeU64LE(scaledAmount)
        ]);
        return this.sendInstruction(instrData);
    }

    async wrapXrs(amountXrs) {
        this._requireConnected();
        const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
        const instrData = XerisTx.encodeInstruction(13, [
            XerisTx.writeU64LE(lamports)
        ]);
        return this.sendInstruction(instrData);
    }

    async unwrapXrs(amountXrs) {
        this._requireConnected();
        const lamports = Math.round(amountXrs * LAMPORTS_PER_XRS);
        const instrData = XerisTx.encodeInstruction(14, [
            XerisTx.writeU64LE(lamports)
        ]);
        return this.sendInstruction(instrData);
    }

    async callContract(contractId, method, args) {
        this._requireConnected();
        const argsJson = JSON.stringify(args);
        const argsBytes = new TextEncoder().encode(argsJson);
        const instrData = XerisTx.encodeInstruction(4, [
            XerisTx.encodeBincodeString(contractId),
            XerisTx.encodeBincodeString(method),
            XerisTx.encodeBincodeVec(argsBytes)
        ]);
        return this.sendInstruction(instrData);
    }

    async swapTokens(poolId, tokenIn, amountIn, minAmountOut) {
        return this.callContract(poolId, 'swap', {
            token_in: tokenIn,
            amount_in: amountIn,
            min_amount_out: minAmountOut
        });
    }

    async buyOnLaunchpad(launchpadId, xrsAmountLamports, minTokensOut) {
        return this.callContract(launchpadId, 'buy_tokens', {
            xrs_amount: xrsAmountLamports,
            min_tokens_out: minTokensOut
        });
    }

    async sellOnLaunchpad(launchpadId, tokenAmount, minXrsOut) {
        return this.callContract(launchpadId, 'sell_tokens', {
            token_amount: tokenAmount,
            min_xrs_out: minXrsOut
        });
    }

    async addLiquidity(poolId, amountA, amountB) {
        return this.callContract(poolId, 'add_liquidity', {
            amount_a: amountA,
            amount_b: amountB
        });
    }

    async removeLiquidity(poolId, lpAmount) {
        return this.callContract(poolId, 'remove_liquidity', {
            lp_amount: lpAmount
        });
    }

    // ─── READ-ONLY QUERIES ──────────────────────────────────────

    async getBalance(address) {
        const addr = address || this._publicKey;
        if (!addr) throw new Error('No address provided');
        const result = await this._jsonRpc('getBalance', [addr]);
        return typeof result === 'object' ? result.value : result;
    }

    async getTokenAccounts(address) {
        const addr = address || this._publicKey;
        const res = await fetch(`${this._rpcUrl}/token/accounts/${addr}`);
        return res.json();
    }

    async getAccountInfo(address) {
        const addr = address || this._publicKey;
        const res = await fetch(`${this._explorerUrl}/v2/account/${addr}`);
        return res.json();
    }

    async getLaunchpads() {
        const res = await fetch(`${this._rpcUrl}/launchpads`);
        return res.json();
    }

    async getLaunchpadQuote(launchpadId, xrsAmountLamports) {
        const res = await fetch(`${this._rpcUrl}/launchpad/${launchpadId}/quote?xrs_amount=${xrsAmountLamports}`);
        return res.json();
    }

    async getContracts() {
        const res = await fetch(`${this._rpcUrl}/contracts`);
        return res.json();
    }

    async getContract(contractId) {
        const res = await fetch(`${this._rpcUrl}/contract/${contractId}`);
        return res.json();
    }

    async getSwapQuote(contractId, params) {
        const qs = new URLSearchParams(params).toString();
        const res = await fetch(`${this._rpcUrl}/contract/${contractId}/quote?${qs}`);
        return res.json();
    }

    async getTokenList() {
        const res = await fetch(`${this._rpcUrl}/tokens`);
        return res.json();
    }

    async getStats() {
        const res = await fetch(`${this._explorerUrl}/v2/stats`);
        return res.json();
    }

    async getTransaction(signature) {
        const res = await fetch(`${this._explorerUrl}/v2/tx/${signature}`);
        return res.json();
    }

    async airdrop(amountXrs) {
        this._requireConnected();
        const res = await fetch(`${this._rpcUrl}/airdrop/${this._publicKey}/${amountXrs}`);
        return res.json();
    }

    // ─── STATIC FACTORY ─────────────────────────────────────────

    static testnet() {
        return new XerisDApp({ network: 'testnet' });
    }

    static mainnet(host) {
        return new XerisDApp({ network: 'mainnet', host });
    }
}
