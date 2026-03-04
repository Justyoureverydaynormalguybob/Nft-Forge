// ============================================
// XERIS CLIENT-SIDE TRANSACTION BUILDER
// ============================================
// Builds Solana-compatible wire-format transactions
// in the browser for wallet signing.
// ============================================

const XerisTx = (() => {
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    function base58Decode(str) {
        if (!str || str.length === 0) return new Uint8Array(0);
        let zeros = 0;
        while (zeros < str.length && str[zeros] === '1') zeros++;
        const size = Math.ceil((str.length - zeros) * 733 / 1000) + 1;
        const bytes = new Uint8Array(size);
        let length = 0;
        for (let i = zeros; i < str.length; i++) {
            const idx = B58.indexOf(str[i]);
            if (idx < 0) throw new Error('Invalid base58: ' + str[i]);
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
        const result = new Uint8Array(zeros + length);
        for (let i = 0; i < length; i++) result[zeros + i] = bytes[size - length + i];
        return result;
    }

    function base58Encode(bytes) {
        if (bytes.length === 0) return '';
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
        for (let i = size - length; i < size; i++) result += B58[b58[i]];
        return result;
    }

    function encodeCompactU16(value) {
        const buf = [];
        while (true) {
            let byte = value & 0x7f;
            value >>= 7;
            if (value > 0) byte |= 0x80;
            buf.push(byte);
            if (value === 0) break;
        }
        return new Uint8Array(buf);
    }

    function writeU64LE(value) {
        const buf = new Uint8Array(8);
        const lo = value % 0x100000000;
        const hi = Math.floor(value / 0x100000000);
        buf[0] = lo & 0xff; buf[1] = (lo >> 8) & 0xff;
        buf[2] = (lo >> 16) & 0xff; buf[3] = (lo >> 24) & 0xff;
        buf[4] = hi & 0xff; buf[5] = (hi >> 8) & 0xff;
        buf[6] = (hi >> 16) & 0xff; buf[7] = (hi >> 24) & 0xff;
        return buf;
    }

    function writeU32LE(value) {
        const buf = new Uint8Array(4);
        buf[0] = value & 0xff; buf[1] = (value >> 8) & 0xff;
        buf[2] = (value >> 16) & 0xff; buf[3] = (value >> 24) & 0xff;
        return buf;
    }

    function encodeBincodeString(str) {
        const strBytes = new TextEncoder().encode(str);
        return concatBytes(writeU64LE(strBytes.length), strBytes);
    }

    function concatBytes(...arrays) {
        const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }
        return result;
    }

    // Encode NativeTransfer instruction (variant 11)
    function encodeNativeTransfer(from, to, amountLamports) {
        return concatBytes(
            writeU32LE(11),
            encodeBincodeString(from),
            encodeBincodeString(to),
            writeU64LE(amountLamports)
        );
    }

    // Build Solana-compatible message
    function buildMessage(signerPubkey32, instructionData, blockhash32) {
        const defaultProgram = new Uint8Array(32); // all zeros
        return concatBytes(
            new Uint8Array([1, 0, 1]),       // header
            encodeCompactU16(2),             // 2 account keys
            signerPubkey32,                  // signer
            defaultProgram,                  // program
            blockhash32,                     // recent blockhash
            encodeCompactU16(1),             // 1 instruction
            new Uint8Array([1]),             // programIdIndex = 1
            encodeCompactU16(1),             // 1 account
            new Uint8Array([0]),             // account index 0
            encodeCompactU16(instructionData.length),
            instructionData
        );
    }

    // Build unsigned transaction (for wallet signing)
    function buildUnsignedTx(messageBytes) {
        const emptySig = new Uint8Array(64); // placeholder
        return concatBytes(
            encodeCompactU16(1),
            emptySig,
            messageBytes
        );
    }

    // Assemble signed transaction from signature + message
    function assembleSignedTx(signature64, messageBytes) {
        return concatBytes(
            encodeCompactU16(1),
            signature64,
            messageBytes
        );
    }

    // Fetch recent blockhash via server proxy
    async function fetchRecentBlockhash() {
        const res = await fetch('/api/chain/blockhash');
        const data = await res.json();
        if (!data.blockhash) throw new Error('No blockhash returned');
        return data.blockhash;
    }

    // Build a NativeTransfer payment transaction for wallet signing
    async function buildPaymentTx(fromAddress, toAddress, amountLamports) {
        const blockhashStr = await fetchRecentBlockhash();
        const signer32 = base58Decode(fromAddress);
        const blockhash32 = base58Decode(blockhashStr);

        if (signer32.length !== 32) throw new Error('Invalid signer address');
        if (blockhash32.length !== 32) throw new Error('Invalid blockhash');

        const instrData = encodeNativeTransfer(fromAddress, toAddress, amountLamports);
        const message = buildMessage(signer32, instrData, blockhash32);
        const unsignedTx = buildUnsignedTx(message);

        return { unsignedTx, message, blockhash: blockhashStr };
    }

    // Generic instruction encoder: variant u32 + concatenated data parts
    function encodeInstruction(variant, dataParts) {
        const parts = [writeU32LE(variant), ...dataParts];
        return concatBytes(...parts);
    }

    // Encode bincode Vec<u8> (u64 length prefix + raw bytes)
    function encodeBincodeVec(bytes) {
        return concatBytes(writeU64LE(bytes.length), bytes);
    }

    return {
        base58Decode,
        base58Encode,
        encodeCompactU16,
        writeU32LE,
        writeU64LE,
        encodeBincodeString,
        encodeBincodeVec,
        encodeInstruction,
        encodeNativeTransfer,
        concatBytes,
        buildMessage,
        buildUnsignedTx,
        assembleSignedTx,
        fetchRecentBlockhash,
        buildPaymentTx,
        LAMPORTS_PER_XRS: 1_000_000_000
    };
})();
