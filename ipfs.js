// ============================================
// NFT-XERIS — IPFS UPLOAD MODULE
// ============================================
// Primary: Pinata SDK for decentralized storage
// Fallback: Local file storage with server URLs
// ============================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGES_DIR = path.join(__dirname, 'data', 'images');
const METADATA_DIR = path.join(__dirname, 'data', 'metadata');

// Ensure directories exist
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
if (!fs.existsSync(METADATA_DIR)) fs.mkdirSync(METADATA_DIR, { recursive: true });

let pinata = null;

function initPinata() {
    if (pinata) return pinata;
    if (!process.env.PINATA_API_KEY || !process.env.PINATA_SECRET_KEY) return null;

    try {
        const PinataSDK = require('@pinata/sdk');
        pinata = new PinataSDK(process.env.PINATA_API_KEY, process.env.PINATA_SECRET_KEY);
        console.log('[IPFS] Pinata SDK initialized');
        return pinata;
    } catch (e) {
        console.log(`[IPFS] Pinata not available: ${e.message}`);
        return null;
    }
}

function isConfigured() {
    return !!initPinata();
}

function getGatewayUrl(cid) {
    return `https://gateway.pinata.cloud/ipfs/${cid}`;
}

/**
 * Upload image buffer to IPFS (or local fallback).
 * @param {Buffer} buffer - Image data
 * @param {string} filename - Filename (e.g., "nft-abc123.svg")
 * @returns {{ cid: string, url: string, gateway: string, local: boolean }}
 */
async function uploadImage(buffer, filename) {
    const sdk = initPinata();

    if (sdk) {
        try {
            const { Readable } = require('stream');
            const stream = Readable.from(buffer);
            stream.path = filename; // Pinata needs this for the filename
            const result = await sdk.pinFileToIPFS(stream, {
                pinataMetadata: { name: filename }
            });
            const cid = result.IpfsHash;
            console.log(`[IPFS] Uploaded image: ${cid}`);
            return {
                cid,
                url: `ipfs://${cid}`,
                gateway: getGatewayUrl(cid),
                local: false
            };
        } catch (e) {
            console.error(`[IPFS] Pinata upload failed, falling back to local: ${e.message}`);
        }
    }

    // Local fallback
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    const localFilename = `${hash}-${filename}`;
    const localPath = path.join(IMAGES_DIR, localFilename);
    fs.writeFileSync(localPath, buffer);
    console.log(`[IPFS] Saved locally: ${localFilename}`);

    return {
        cid: hash,
        url: `/api/images/${localFilename}`,
        gateway: `/api/images/${localFilename}`,
        local: true
    };
}

/**
 * Upload metadata JSON to IPFS (or local fallback).
 * @param {object} metadata - NFT metadata object
 * @returns {{ cid: string, url: string }}
 */
async function uploadMetadata(metadata) {
    const sdk = initPinata();
    const jsonStr = JSON.stringify(metadata, null, 2);

    if (sdk) {
        try {
            const result = await sdk.pinJSONToIPFS(metadata, {
                pinataMetadata: { name: metadata.name || 'nft-metadata' }
            });
            const cid = result.IpfsHash;
            console.log(`[IPFS] Uploaded metadata: ${cid}`);
            return {
                cid,
                url: `ipfs://${cid}`,
                gateway: getGatewayUrl(cid)
            };
        } catch (e) {
            console.error(`[IPFS] Pinata metadata upload failed: ${e.message}`);
        }
    }

    // Local fallback
    const hash = crypto.createHash('sha256').update(jsonStr).digest('hex').substring(0, 16);
    const filename = `${hash}.json`;
    fs.writeFileSync(path.join(METADATA_DIR, filename), jsonStr);
    console.log(`[IPFS] Saved metadata locally: ${filename}`);

    return {
        cid: hash,
        url: `/api/metadata/${filename}`,
        gateway: `/api/metadata/${filename}`
    };
}

module.exports = {
    uploadImage,
    uploadMetadata,
    isConfigured,
    getGatewayUrl,
    IMAGES_DIR,
    METADATA_DIR
};
