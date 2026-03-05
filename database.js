// ============================================
// NFT-FORGE — DATABASE LAYER
// ============================================
// Uses PostgreSQL when DATABASE_URL is set,
// falls back to JSON files for local dev.
// ============================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USE_PG = !!process.env.DATABASE_URL;
if (USE_PG) {
    // Log host only — never log credentials
    const dbHost = process.env.DATABASE_URL.replace(/^.*@/, '').replace(/\/.*$/, '');
    console.log(`[DB] DATABASE_URL found (host: ${dbHost})`);
} else {
    console.log('[DB] DATABASE_URL NOT SET — using JSON files');
}

// ─── POSTGRES STORE ─────────────────────────────────────────────────

let pool = null;

function getPool() {
    if (pool) return pool;
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    return pool;
}

async function initPostgres() {
    const db = getPool();

    // Test connection first
    try {
        const result = await db.query('SELECT NOW()');
        console.log('[DB] PostgreSQL connected at', result.rows[0].now);
    } catch (e) {
        console.error('[DB] PostgreSQL connection FAILED:', e.message);
        throw e;
    }

    // Run each CREATE TABLE separately (some PG providers reject multi-statement)
    const statements = [
        `CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            address TEXT UNIQUE NOT NULL,
            username TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            data JSONB DEFAULT '{}'
        )`,
        `CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            symbol TEXT,
            creator_address TEXT,
            description TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            max_supply INT DEFAULT 0,
            mint_count INT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            data JSONB DEFAULT '{}'
        )`,
        `CREATE TABLE IF NOT EXISTS nfts (
            id TEXT PRIMARY KEY,
            collection_id TEXT,
            token_number INT,
            owner_address TEXT NOT NULL,
            creator_address TEXT NOT NULL,
            name TEXT NOT NULL,
            prompt_text TEXT DEFAULT '',
            image_cid TEXT DEFAULT '',
            metadata_cid TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            metadata_url TEXT DEFAULT '',
            minted_at TIMESTAMPTZ DEFAULT NOW(),
            data JSONB DEFAULT '{}'
        )`,
        `CREATE TABLE IF NOT EXISTS listings (
            id TEXT PRIMARY KEY,
            nft_id TEXT NOT NULL,
            seller_address TEXT NOT NULL,
            price_xrs DOUBLE PRECISION,
            price_lamports BIGINT,
            status TEXT DEFAULT 'active',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            data JSONB DEFAULT '{}'
        )`,
        `CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            listing_id TEXT,
            nft_id TEXT NOT NULL,
            buyer_address TEXT NOT NULL,
            seller_address TEXT NOT NULL,
            price_lamports BIGINT,
            payment_tx_signature TEXT DEFAULT '',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            data JSONB DEFAULT '{}'
        )`,
        `CREATE INDEX IF NOT EXISTS idx_nfts_owner ON nfts(owner_address)`,
        `CREATE INDEX IF NOT EXISTS idx_nfts_creator ON nfts(creator_address)`,
        `CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status)`,
        `CREATE INDEX IF NOT EXISTS idx_users_address ON users(address)`
    ];

    for (const sql of statements) {
        await db.query(sql);
    }

    console.log('[DB] PostgreSQL tables initialized');
}

// ─── PG STORE CLASS (same interface as JsonStore) ────────────────────

class PgStore {
    constructor(table, fieldMap) {
        this.table = table;
        this.fieldMap = fieldMap; // maps camelCase -> snake_case
        this.reverseMap = {};
        for (const [camel, snake] of Object.entries(fieldMap)) {
            this.reverseMap[snake] = camel;
        }
    }

    _toRow(record) {
        const row = {};
        const allowedCols = new Set(Object.values(this.fieldMap));
        for (const [key, val] of Object.entries(record)) {
            const col = this.fieldMap[key] || key;
            // Only allow known column names — prevents SQL injection via keys
            if (!allowedCols.has(col)) continue;
            row[col] = val;
        }
        return row;
    }

    _fromRow(row) {
        if (!row) return null;
        const record = {};
        for (const [col, val] of Object.entries(row)) {
            const key = this.reverseMap[col] || col;
            record[key] = val;
        }
        return record;
    }

    async create(record) {
        record.id = record.id || crypto.randomUUID();
        const row = this._toRow(record);
        const cols = Object.keys(row);
        const vals = Object.values(row);
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        await getPool().query(
            `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
            vals
        );
        return record;
    }

    async getById(id) {
        const { rows } = await getPool().query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
        return this._fromRow(rows[0]);
    }

    async find(filter = {}) {
        const allowedCols = new Set(Object.values(this.fieldMap));
        const conditions = [];
        const vals = [];
        let i = 1;
        for (const [key, value] of Object.entries(filter)) {
            const col = this.fieldMap[key] || key;
            if (!allowedCols.has(col)) continue;
            conditions.push(`${col} = $${i++}`);
            vals.push(value);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const { rows } = await getPool().query(`SELECT * FROM ${this.table} ${where}`, vals);
        return rows.map(r => this._fromRow(r));
    }

    async update(id, updates) {
        const allowedCols = new Set(Object.values(this.fieldMap));
        const sets = [];
        const vals = [];
        let i = 1;
        for (const [key, value] of Object.entries(updates)) {
            const col = this.fieldMap[key] || key;
            if (!allowedCols.has(col)) continue;
            sets.push(`${col} = $${i++}`);
            vals.push(value);
        }
        vals.push(id);
        const { rows } = await getPool().query(
            `UPDATE ${this.table} SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
            vals
        );
        return this._fromRow(rows[0]);
    }

    async delete(id) {
        const { rowCount } = await getPool().query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
        return rowCount > 0;
    }

    async list({ page = 1, limit = 20, filter = {}, sort = null } = {}) {
        const allowedCols = new Set(Object.values(this.fieldMap));
        const conditions = [];
        const vals = [];
        let i = 1;
        for (const [key, value] of Object.entries(filter)) {
            const col = this.fieldMap[key] || key;
            if (!allowedCols.has(col)) continue;
            conditions.push(`${col} = $${i++}`);
            vals.push(value);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rawOrderCol = sort ? (this.fieldMap[sort.field] || sort.field) : 'created_at';
        const orderCol = allowedCols.has(rawOrderCol) ? rawOrderCol : 'created_at';
        const orderDir = sort?.order === 'asc' ? 'ASC' : 'DESC';
        const offset = (page - 1) * limit;

        const countRes = await getPool().query(`SELECT COUNT(*) FROM ${this.table} ${where}`, vals);
        const total = parseInt(countRes.rows[0].count);

        const dataRes = await getPool().query(
            `SELECT * FROM ${this.table} ${where} ORDER BY ${orderCol} ${orderDir} LIMIT $${i++} OFFSET $${i}`,
            [...vals, limit, offset]
        );
        const items = dataRes.rows.map(r => this._fromRow(r));

        return { items, total, page, limit, pages: Math.ceil(total / limit) };
    }

    async count(filter = {}) {
        const allowedCols = new Set(Object.values(this.fieldMap));
        const conditions = [];
        const vals = [];
        let i = 1;
        for (const [key, value] of Object.entries(filter)) {
            const col = this.fieldMap[key] || key;
            if (!allowedCols.has(col)) continue;
            conditions.push(`${col} = $${i++}`);
            vals.push(value);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const { rows } = await getPool().query(`SELECT COUNT(*) FROM ${this.table} ${where}`, vals);
        return parseInt(rows[0].count);
    }

    // Compatibility: used by server.js for stats (db.nfts.data.length)
    get data() {
        // Return a proxy that provides .length asynchronously won't work,
        // so we use a sync wrapper that caches. Updated on create/delete.
        return this._cache || [];
    }

    async refreshCache() {
        const { rows } = await getPool().query(`SELECT * FROM ${this.table}`);
        this._cache = rows.map(r => this._fromRow(r));
        return this._cache;
    }
}

// ─── JSON FILE STORE (original, for local dev) ──────────────────────

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

// ─── FIELD MAPS (camelCase → snake_case) ────────────────────────────

const USER_FIELDS = {
    id: 'id', address: 'address', username: 'username',
    createdAt: 'created_at'
};

const COLLECTION_FIELDS = {
    id: 'id', name: 'name', symbol: 'symbol',
    creatorAddress: 'creator_address', description: 'description',
    imageUrl: 'image_url', maxSupply: 'max_supply',
    mintCount: 'mint_count', createdAt: 'created_at'
};

const NFT_FIELDS = {
    id: 'id', collectionId: 'collection_id', tokenNumber: 'token_number',
    ownerAddress: 'owner_address', creatorAddress: 'creator_address',
    name: 'name', promptText: 'prompt_text',
    imageCID: 'image_cid', metadataCID: 'metadata_cid',
    imageUrl: 'image_url', metadataUrl: 'metadata_url',
    mintedAt: 'minted_at'
};

const LISTING_FIELDS = {
    id: 'id', nftId: 'nft_id', sellerAddress: 'seller_address',
    priceXRS: 'price_xrs', priceLamports: 'price_lamports',
    status: 'status', createdAt: 'created_at'
};

const TRADE_FIELDS = {
    id: 'id', listingId: 'listing_id', nftId: 'nft_id',
    buyerAddress: 'buyer_address', sellerAddress: 'seller_address',
    priceLamports: 'price_lamports',
    paymentTxSignature: 'payment_tx_signature',
    createdAt: 'created_at'
};

// ─── CREATE STORES ──────────────────────────────────────────────────

let users, collections, nfts, listings, trades;

if (USE_PG) {
    console.log('[DB] Using PostgreSQL');
    users = new PgStore('users', USER_FIELDS);
    collections = new PgStore('collections', COLLECTION_FIELDS);
    nfts = new PgStore('nfts', NFT_FIELDS);
    listings = new PgStore('listings', LISTING_FIELDS);
    trades = new PgStore('trades', TRADE_FIELDS);
} else {
    console.log('[DB] Using JSON file storage (no DATABASE_URL)');
    users = new JsonStore('users.json');
    collections = new JsonStore('collections.json');
    nfts = new JsonStore('nfts.json');
    listings = new JsonStore('listings.json');
    trades = new JsonStore('trades.json');
}

// ─── USER HELPERS ───────────────────────────────────────────────────

async function getOrCreateUser(address) {
    const found = await users.find({ address });
    if (found[0]) return found[0];
    return users.create({
        address,
        username: address.substring(0, 8) + '...',
        createdAt: new Date().toISOString()
    });
}

// ─── COLLECTION HELPERS ─────────────────────────────────────────────

async function createCollection({ name, symbol, creatorAddress, description, imageUrl, maxSupply }) {
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

async function incrementMintCount(collectionId) {
    const col = await collections.getById(collectionId);
    if (!col) return null;
    return collections.update(collectionId, { mintCount: (col.mintCount || 0) + 1 });
}

// ─── NFT HELPERS ────────────────────────────────────────────────────

async function createNFT({ collectionId, tokenNumber, ownerAddress, creatorAddress, name, promptText, imageCID, metadataCID, imageUrl, metadataUrl }) {
    const count = await nfts.count();
    return nfts.create({
        collectionId: collectionId || null,
        tokenNumber: tokenNumber || count + 1,
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

async function transferNFT(nftId, newOwnerAddress) {
    return nfts.update(nftId, { ownerAddress: newOwnerAddress });
}

// ─── LISTING HELPERS ────────────────────────────────────────────────

async function createListing({ nftId, sellerAddress, priceXRS }) {
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

async function cancelListing(listingId) {
    return listings.update(listingId, { status: 'cancelled' });
}

async function completeListing(listingId) {
    return listings.update(listingId, { status: 'sold' });
}

// ─── TRADE HELPERS ──────────────────────────────────────────────────

async function recordTrade({ listingId, nftId, buyerAddress, sellerAddress, priceLamports, paymentTxSignature }) {
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

// ─── INIT (call on startup) ─────────────────────────────────────────

async function initDB() {
    if (USE_PG) {
        await initPostgres();
    }
}

// ─── EXPORTS ────────────────────────────────────────────────────────

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
    initDB,
    DATA_DIR
};
