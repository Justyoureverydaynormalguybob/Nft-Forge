// ============================================
// NFT-XERIS — JSON FILE DATABASE
// ============================================
// Atomic-write JSON storage for NFT platform.
// Same pattern as XerisProof's database-json.js.
// ============================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── GENERIC JSON STORE ──────────────────────────────────────────────

class JsonStore {
    constructor(filename) {
        this.filepath = path.join(DATA_DIR, filename);
        this.data = [];
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filepath)) {
                this.data = JSON.parse(fs.readFileSync(this.filepath, 'utf8'));
            }
        } catch (e) {
            console.error(`[DB] Failed to load ${this.filepath}: ${e.message}`);
            this.data = [];
        }
    }

    _save() {
        const tmp = this.filepath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.filepath);
    }

    create(record) {
        record.id = record.id || crypto.randomUUID();
        this.data.push(record);
        this._save();
        return record;
    }

    getById(id) {
        return this.data.find(r => r.id === id) || null;
    }

    find(filter = {}) {
        return this.data.filter(record => {
            for (const [key, value] of Object.entries(filter)) {
                if (record[key] !== value) return false;
            }
            return true;
        });
    }

    update(id, updates) {
        const idx = this.data.findIndex(r => r.id === id);
        if (idx === -1) return null;
        Object.assign(this.data[idx], updates);
        this._save();
        return this.data[idx];
    }

    delete(id) {
        const idx = this.data.findIndex(r => r.id === id);
        if (idx === -1) return false;
        this.data.splice(idx, 1);
        this._save();
        return true;
    }

    list({ page = 1, limit = 20, filter = {}, sort = null } = {}) {
        let results = this.find(filter);

        if (sort) {
            const { field, order = 'desc' } = sort;
            results.sort((a, b) => {
                if (order === 'asc') return a[field] > b[field] ? 1 : -1;
                return a[field] < b[field] ? 1 : -1;
            });
        }

        const total = results.length;
        const start = (page - 1) * limit;
        const items = results.slice(start, start + limit);

        return { items, total, page, limit, pages: Math.ceil(total / limit) };
    }

    count(filter = {}) {
        return this.find(filter).length;
    }
}

// ─── DATABASE TABLES ─────────────────────────────────────────────────

const users = new JsonStore('users.json');
const collections = new JsonStore('collections.json');
const nfts = new JsonStore('nfts.json');
const listings = new JsonStore('listings.json');
const trades = new JsonStore('trades.json');

// ─── USER HELPERS ────────────────────────────────────────────────────

function getOrCreateUser(address) {
    let user = users.find({ address })[0];
    if (!user) {
        user = users.create({
            address,
            username: address.substring(0, 8) + '...',
            createdAt: new Date().toISOString()
        });
    }
    return user;
}

// ─── COLLECTION HELPERS ──────────────────────────────────────────────

function createCollection({ name, symbol, creatorAddress, description, imageUrl, maxSupply }) {
    return collections.create({
        name,
        symbol: symbol || name.substring(0, 4).toUpperCase(),
        creatorAddress,
        description: description || '',
        imageUrl: imageUrl || '',
        maxSupply: maxSupply || 0,
        mintCount: 0,
        createdAt: new Date().toISOString()
    });
}

function incrementMintCount(collectionId) {
    const col = collections.getById(collectionId);
    if (!col) return null;
    return collections.update(collectionId, { mintCount: (col.mintCount || 0) + 1 });
}

// ─── NFT HELPERS ─────────────────────────────────────────────────────

function createNFT({ collectionId, tokenNumber, ownerAddress, creatorAddress, name, promptText, imageCID, metadataCID, imageUrl, metadataUrl }) {
    return nfts.create({
        collectionId: collectionId || null,
        tokenNumber: tokenNumber || nfts.data.length + 1,
        ownerAddress,
        creatorAddress,
        name,
        promptText: promptText || '',
        imageCID: imageCID || '',
        metadataCID: metadataCID || '',
        imageUrl: imageUrl || '',
        metadataUrl: metadataUrl || '',
        mintedAt: new Date().toISOString()
    });
}

function transferNFT(nftId, newOwnerAddress) {
    return nfts.update(nftId, { ownerAddress: newOwnerAddress });
}

// ─── LISTING HELPERS ─────────────────────────────────────────────────

function createListing({ nftId, sellerAddress, priceXRS }) {
    const priceLamports = Math.floor(priceXRS * 1_000_000_000);
    return listings.create({
        nftId,
        sellerAddress,
        priceXRS,
        priceLamports,
        status: 'active',
        createdAt: new Date().toISOString()
    });
}

function cancelListing(listingId) {
    return listings.update(listingId, { status: 'cancelled' });
}

function completeListing(listingId) {
    return listings.update(listingId, { status: 'sold' });
}

// ─── TRADE HELPERS ───────────────────────────────────────────────────

function recordTrade({ listingId, nftId, buyerAddress, sellerAddress, priceLamports, paymentTxSignature }) {
    return trades.create({
        listingId,
        nftId,
        buyerAddress,
        sellerAddress,
        priceLamports,
        paymentTxSignature: paymentTxSignature || '',
        createdAt: new Date().toISOString()
    });
}

// ─── EXPORTS ─────────────────────────────────────────────────────────

module.exports = {
    users,
    collections,
    nfts,
    listings,
    trades,
    getOrCreateUser,
    createCollection,
    incrementMintCount,
    createNFT,
    transferNFT,
    createListing,
    cancelListing,
    completeListing,
    recordTrade,
    DATA_DIR
};
