// ============================================
// XERIS - SOLANA-COMPATIBLE BINARY TX BUILDER
// ============================================
// Builds proper wire-format transactions that
// the Xeris chain actually processes and indexes.
// ============================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LAMPORTS_PER_XRS = 1_000_000_000;
const CERTIFICATION_FEE_XRS = 0.001;
const CERTIFICATION_FEE_LAMPORTS = Math.round(CERTIFICATION_FEE_XRS * LAMPORTS_PER_XRS);

// ─── BASE58 ──────────────────────────────────────────────────────────

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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
    for (let i = size - length; i < size; i++) result += B58_ALPHABET[b58[i]];
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
        const idx = B58_ALPHABET.indexOf(str[i]);
        if (idx < 0) throw new Error('Invalid base58 character: ' + str[i]);
        let carry = idx;
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
    for (let i = 0; i < length; i++) result[zeros + i] = bytes[size - length + i];
    return result;
}

// ─── COMPACT U16 ENCODING (Solana wire format) ──────────────────────

function encodeCompactU16(value) {
    const buf = [];
    while (true) {
        let byte = value & 0x7f;
        value >>= 7;
        if (value > 0) byte |= 0x80;
        buf.push(byte);
        if (value === 0) break;
    }
    return Buffer.from(buf);
}

// ─── CONVERT ANY HASH FORMAT TO 32 RAW BYTES ────────────────────────

function toBytes32(input) {
    if (Buffer.isBuffer(input) && input.length === 32) return input;
    if (Array.isArray(input) && input.length === 32) return Buffer.from(input);
    if (typeof input === 'string') {
        if (/^[0-9a-fA-F]{64}$/.test(input)) return Buffer.from(input, 'hex');
        if (/^[0-9a-fA-F]+$/.test(input) && input.length <= 64) {
            return Buffer.from(input.padEnd(64, '0'), 'hex');
        }
        try {
            const decoded = base58Decode(input);
            if (decoded.length === 32) return decoded;
            if (decoded.length > 32) return decoded.slice(0, 32);
            const padded = Buffer.alloc(32);
            decoded.copy(padded);
            return padded;
        } catch (e) {
            // Not valid base58 — fall through to error below
        }
    }
    throw new Error('Cannot convert to 32-byte hash: ' + typeof input + ' len=' + (input?.length || 0));
}

// ─── WRITE U64/U32 LITTLE-ENDIAN ────────────────────────────────────

function writeU64LE(value) {
    const buf = Buffer.alloc(8);
    const big = BigInt(value);
    buf.writeBigUInt64LE(big);
    return buf;
}

function writeU32LE(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0, 0);
    return buf;
}

// ─── BINCODE ENCODING HELPERS ────────────────────────────────────────

function encodeBincodeString(str) {
    const strBytes = Buffer.from(str, 'utf8');
    return Buffer.concat([writeU64LE(strBytes.length), strBytes]);
}

function encodeNativeTransfer(from, to, amountLamports) {
    return Buffer.concat([
        writeU32LE(11),
        encodeBincodeString(from),
        encodeBincodeString(to),
        writeU64LE(amountLamports),
    ]);
}

// ─── BUILD XERIS TRANSFER TRANSACTION ────────────────────────────────

function buildXerisTransferTransaction(senderPubkey, recipientAddress, lamports, recentBlockhash, signFn) {
    const sender32 = toBytes32(senderPubkey);
    const blockhash32 = toBytes32(recentBlockhash);
    const DEFAULT_PROGRAM = Buffer.alloc(32);

    const senderBase58 = base58Encode(sender32);
    const recipientBase58 = typeof recipientAddress === 'string' && /^[1-9A-HJ-NP-Za-km-z]+$/.test(recipientAddress)
        ? recipientAddress
        : base58Encode(toBytes32(recipientAddress));

    const instrData = encodeNativeTransfer(senderBase58, recipientBase58, lamports);

    const message = Buffer.concat([
        Buffer.from([1, 0, 1]),
        encodeCompactU16(2),
        sender32,
        DEFAULT_PROGRAM,
        blockhash32,
        encodeCompactU16(1),
        Buffer.from([1]),
        encodeCompactU16(1),
        Buffer.from([0]),
        encodeCompactU16(instrData.length),
        instrData
    ]);

    const signature = signFn(message);
    if (signature.length !== 64) {
        throw new Error('Ed25519 signature must be 64 bytes, got ' + signature.length);
    }

    const transaction = Buffer.concat([
        encodeCompactU16(1),
        signature,
        message
    ]);

    return {
        transaction,
        signature,
        signatureBase58: base58Encode(signature),
        message,
        base64: transaction.toString('base64'),
        sender: senderBase58,
        recipient: recipientBase58,
        amount: lamports,
        amountXRS: lamports / LAMPORTS_PER_XRS
    };
}

// ─── SERVER KEYPAIR MANAGEMENT ───────────────────────────────────────

const KEYPAIR_FILE = 'server-keypair.json';

function generateKeypair(dataDir) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubJwk = publicKey.export({ format: 'jwk' });
    const privJwk = privateKey.export({ format: 'jwk' });
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const pubRaw = Buffer.from(pubDer.slice(-32));

    const keypairData = {
        publicKeyJwk: pubJwk,
        privateKeyJwk: privJwk,
        address: base58Encode(pubRaw),
        publicKeyBytes: Array.from(pubRaw),
        createdAt: new Date().toISOString()
    };

    const filePath = path.join(dataDir, KEYPAIR_FILE);
    fs.writeFileSync(filePath, JSON.stringify(keypairData, null, 2));
    try { fs.chmodSync(filePath, 0o600); } catch (e) {}
    console.log(`[TX] Generated server keypair: ${keypairData.address}`);
    console.log(`[TX] Saved to: ${filePath}`);

    return {
        publicKey,
        privateKey,
        publicKeyRaw: pubRaw,
        address: keypairData.address
    };
}

function loadKeypair(dataDir) {
    if (process.env.SERVER_KEYPAIR) {
        try {
            const data = JSON.parse(process.env.SERVER_KEYPAIR);
            const publicKey = crypto.createPublicKey({ key: data.publicKeyJwk, format: 'jwk' });
            const privateKey = crypto.createPrivateKey({ key: data.privateKeyJwk, format: 'jwk' });
            const pubRaw = Buffer.from(data.publicKeyBytes);
            console.log(`[TX] Loaded server keypair from env: ${data.address}`);
            return { publicKey, privateKey, publicKeyRaw: pubRaw, address: data.address };
        } catch (e) {
            console.error(`[TX] Failed to parse SERVER_KEYPAIR env: ${e.message}`);
        }
    }

    const filePath = path.join(dataDir, KEYPAIR_FILE);
    if (!fs.existsSync(filePath)) {
        console.log('[TX] No server keypair found, generating new one...');
        return generateKeypair(dataDir);
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const publicKey = crypto.createPublicKey({ key: data.publicKeyJwk, format: 'jwk' });
        const privateKey = crypto.createPrivateKey({ key: data.privateKeyJwk, format: 'jwk' });
        const pubRaw = Buffer.from(data.publicKeyBytes);
        console.log(`[TX] Loaded server keypair: ${data.address}`);
        return { publicKey, privateKey, publicKeyRaw: pubRaw, address: data.address };
    } catch (e) {
        console.error(`[TX] Failed to load keypair: ${e.message}, generating new one...`);
        return generateKeypair(dataDir);
    }
}

// ─── DERIVE CERTIFICATION ADDRESS FROM EVIDENCE HASH ─────────────────

function deriveCertAddress(evidenceHash) {
    const hashBytes = crypto.createHash('sha256')
        .update('xeris-cert:' + evidenceHash)
        .digest();
    return {
        bytes: hashBytes,
        address: base58Encode(hashBytes)
    };
}

// ─── BUILD CERTIFICATION TRANSACTION ─────────────────────────────────

function buildCertificationTx(evidenceHash, recentBlockhash, serverKeypair, feeXRS) {
    const feeLamports = Math.round((feeXRS || CERTIFICATION_FEE_XRS) * LAMPORTS_PER_XRS);
    const certAddr = deriveCertAddress(evidenceHash);

    console.log(`[TX] Building cert tx: ${evidenceHash.substring(0, 16)}... → ${certAddr.address.substring(0, 16)}...`);

    const signFn = (message) => crypto.sign(null, message, serverKeypair.privateKey);

    const result = buildXerisTransferTransaction(
        serverKeypair.publicKeyRaw,
        certAddr.address,
        feeLamports,
        recentBlockhash,
        signFn
    );

    result.certAddress = certAddr.address;
    result.evidenceHash = evidenceHash;
    return result;
}

module.exports = {
    buildXerisTransferTransaction,
    buildCertificationTx,
    deriveCertAddress,
    generateKeypair,
    loadKeypair,
    base58Encode,
    base58Decode,
    toBytes32,
    encodeNativeTransfer,
    encodeBincodeString,
    encodeCompactU16,
    writeU64LE,
    writeU32LE,
    LAMPORTS_PER_XRS,
    CERTIFICATION_FEE_XRS,
    CERTIFICATION_FEE_LAMPORTS
};
