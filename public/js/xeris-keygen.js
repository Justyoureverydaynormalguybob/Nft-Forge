// ============================================
// XERIS KEYGEN — Browser BIP39 Wallet Generator
// Uses Web Crypto API + tweetnacl (CDN)
// ============================================

const XerisKeygen = (() => {

    /**
     * Generate a 12-word BIP39 mnemonic using Web Crypto API.
     * 128 bits entropy → SHA-256 checksum (4 bits) → 132 bits → 12 words
     */
    async function generateMnemonic() {
        if (typeof BIP39_WORDLIST === 'undefined' || BIP39_WORDLIST.length !== 2048) {
            throw new Error('BIP39 wordlist not loaded');
        }

        // 1. Generate 128 bits (16 bytes) of entropy
        const entropy = new Uint8Array(16);
        crypto.getRandomValues(entropy);

        // 2. SHA-256 hash for checksum
        const hashBuffer = await crypto.subtle.digest('SHA-256', entropy);
        const hashBytes = new Uint8Array(hashBuffer);

        // 3. Append first 4 bits of hash as checksum (128/32 = 4 checksum bits)
        // Combine entropy + checksum into a bit string
        let bits = '';
        for (const byte of entropy) {
            bits += byte.toString(2).padStart(8, '0');
        }
        // Add first 4 bits of hash
        bits += hashBytes[0].toString(2).padStart(8, '0').substring(0, 4);

        // 4. Split into 12 groups of 11 bits → word indices
        const words = [];
        for (let i = 0; i < 12; i++) {
            const index = parseInt(bits.substring(i * 11, (i + 1) * 11), 2);
            words.push(BIP39_WORDLIST[index]);
        }

        return words.join(' ');
    }

    /**
     * Derive a 64-byte seed from mnemonic using PBKDF2-HMAC-SHA512.
     * Passphrase is "mnemonic" (no user password).
     */
    async function mnemonicToSeed(mnemonic) {
        const encoder = new TextEncoder();
        const mnemonicBytes = encoder.encode(mnemonic.normalize('NFKD'));
        const salt = encoder.encode('mnemonic');

        const keyMaterial = await crypto.subtle.importKey(
            'raw', mnemonicBytes, 'PBKDF2', false, ['deriveBits']
        );

        const seedBits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt, iterations: 2048, hash: 'SHA-512' },
            keyMaterial,
            512 // 64 bytes
        );

        return new Uint8Array(seedBits);
    }

    /**
     * Derive an Ed25519 keypair from mnemonic.
     * seed (first 32 bytes) → nacl.sign.keyPair.fromSeed()
     */
    async function mnemonicToKeypair(mnemonic) {
        if (typeof nacl === 'undefined') {
            throw new Error('tweetnacl not loaded');
        }

        const seed = await mnemonicToSeed(mnemonic);
        const seedSlice = seed.slice(0, 32);
        const keypair = nacl.sign.keyPair.fromSeed(seedSlice);

        return {
            publicKey: keypair.publicKey,
            secretKey: keypair.secretKey
        };
    }

    /**
     * Get a base58-encoded address from a keypair's public key.
     * Uses XerisTx.base58Encode if available.
     */
    function getAddress(keypair) {
        if (typeof XerisTx !== 'undefined' && XerisTx.base58Encode) {
            return XerisTx.base58Encode(keypair.publicKey);
        }
        // Fallback base58 encoder
        return base58Encode(keypair.publicKey);
    }

    // Minimal base58 fallback (same alphabet as Bitcoin/Solana)
    function base58Encode(bytes) {
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let num = 0n;
        for (const byte of bytes) {
            num = num * 256n + BigInt(byte);
        }
        let encoded = '';
        while (num > 0n) {
            const remainder = num % 58n;
            num = num / 58n;
            encoded = ALPHABET[Number(remainder)] + encoded;
        }
        for (const byte of bytes) {
            if (byte === 0) encoded = '1' + encoded;
            else break;
        }
        return encoded;
    }

    /**
     * Full flow: generate mnemonic + derive keypair + get address.
     * Returns { mnemonic, keypair, address }
     */
    async function createWallet() {
        const mnemonic = await generateMnemonic();
        const keypair = await mnemonicToKeypair(mnemonic);
        const address = getAddress(keypair);
        return { mnemonic, keypair, address };
    }

    return {
        generateMnemonic,
        mnemonicToSeed,
        mnemonicToKeypair,
        getAddress,
        createWallet
    };
})();
