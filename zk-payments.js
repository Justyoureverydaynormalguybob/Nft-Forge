// ============================================
// NFT FORGE — ZK PRIVATE PAYMENTS
// ============================================
// Wraps xeris-sdk ZK transfers for private
// marketplace purchases. Falls back to regular
// transfers if ZK is unavailable.
// ============================================

let XerisSDK = null;

function initSDK() {
    if (XerisSDK) return XerisSDK;
    try {
        XerisSDK = require('xeris-sdk');
        console.log('[ZK] xeris-sdk loaded');
        return XerisSDK;
    } catch (e) {
        console.log('[ZK] xeris-sdk not available — ZK payments disabled');
        return null;
    }
}

function isZKAvailable() {
    return !!initSDK();
}

/**
 * Build a ZK private transfer transaction.
 * Amount is hidden on-chain behind a cryptographic commitment.
 *
 * @param {object} opts
 * @param {string} opts.senderAddress - Sender base58 address
 * @param {string} opts.recipientAddress - Recipient base58 address
 * @param {number} opts.amountLamports - Amount in lamports (hidden on-chain)
 * @param {string} opts.recentBlockhash - Recent blockhash
 * @param {Buffer} opts.senderPublicKey - 32-byte public key
 * @param {function} opts.signFn - Signing function (message) => signature
 * @returns {object} { commitment, nullifier, txBase64, proof }
 */
async function buildZKTransfer(opts) {
    const sdk = initSDK();

    if (sdk && typeof sdk.zkTransfer === 'function') {
        // Use real xeris-sdk ZK transfer
        try {
            const result = await sdk.zkTransfer({
                from: opts.senderAddress,
                to: opts.recipientAddress,
                amount: opts.amountLamports,
                recentBlockhash: opts.recentBlockhash,
            });
            console.log(`[ZK] Built ZK transfer: commitment=${result.commitment?.substring(0, 16)}...`);
            return {
                zkEnabled: true,
                commitment: result.commitment,
                nullifier: result.nullifier,
                txBase64: result.tx_base64 || result.txBase64,
                proof: result.proof,
                amountHidden: true
            };
        } catch (e) {
            console.error(`[ZK] SDK zkTransfer failed: ${e.message}`);
        }
    }

    // If SDK has a different API shape, try alternative patterns
    if (sdk) {
        // Try: new XerisSDK.Transaction() pattern
        try {
            if (sdk.Transaction || sdk.ZKTransfer || sdk.PrivateTransfer) {
                const TxClass = sdk.ZKTransfer || sdk.PrivateTransfer || sdk.Transaction;
                const tx = new TxClass({
                    from: opts.senderAddress,
                    to: opts.recipientAddress,
                    amount: opts.amountLamports,
                    recentBlockhash: opts.recentBlockhash,
                    private: true
                });
                if (typeof tx.build === 'function') {
                    const built = await tx.build();
                    return {
                        zkEnabled: true,
                        commitment: built.commitment || built.hash,
                        nullifier: built.nullifier,
                        txBase64: built.tx_base64 || built.txBase64 || built.serialize?.(),
                        proof: built.proof,
                        amountHidden: true
                    };
                }
            }
        } catch (e) {
            console.log(`[ZK] Alternative SDK pattern failed: ${e.message}`);
        }
    }

    // Fallback: build a commitment locally (for demo/hackathon)
    // This creates a SHA-256 commitment of the amount that we store,
    // while the actual transfer uses a regular NativeTransfer
    const crypto = require('crypto');
    const secret = crypto.randomBytes(32);
    const commitment = crypto.createHash('sha256')
        .update(Buffer.concat([
            secret,
            Buffer.from(opts.amountLamports.toString()),
            Buffer.from(opts.senderAddress),
            Buffer.from(opts.recipientAddress)
        ]))
        .digest('hex');

    const nullifier = crypto.createHash('sha256')
        .update(Buffer.concat([secret, Buffer.from('nullifier')]))
        .digest('hex');

    console.log(`[ZK] Fallback commitment: ${commitment.substring(0, 16)}... (real ZK unavailable)`);

    return {
        zkEnabled: false,
        commitment,
        nullifier,
        txBase64: null, // Caller should use regular transfer
        proof: null,
        secret: secret.toString('hex'),
        amountHidden: false,
        fallback: true
    };
}

/**
 * Verify a ZK payment commitment matches expected values.
 * Used by the server to validate that a buyer's ZK proof is legit.
 */
function verifyCommitment(commitment, { amountLamports, senderAddress, recipientAddress, secret }) {
    if (!secret) return false;
    const crypto = require('crypto');
    const expected = crypto.createHash('sha256')
        .update(Buffer.concat([
            Buffer.from(secret, 'hex'),
            Buffer.from(amountLamports.toString()),
            Buffer.from(senderAddress),
            Buffer.from(recipientAddress)
        ]))
        .digest('hex');
    return commitment === expected;
}

module.exports = {
    buildZKTransfer,
    verifyCommitment,
    isZKAvailable,
    initSDK
};
