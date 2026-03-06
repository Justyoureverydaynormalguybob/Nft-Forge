// ============================================
// NFT-FORGE — EXPRESS SERVER
// ============================================
// AI-generated NFT platform powered by Xeris blockchain.
// ============================================

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const nacl = require('tweetnacl');

const ChainConnector = require('./chain');
const txBuilder = require('./tx-builder');
const db = require('./database');
const aiImage = require('./ai-image');
const ipfs = require('./ipfs');
const zkPayments = require('./zk-payments');
const { AgentEngine } = require('./agent-engine');

// ─── CONFIGURATION ───────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
if (!process.env.JWT_SECRET) {
    console.warn('[WARN] JWT_SECRET not set — using random secret (tokens will invalidate on restart)');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT) || 2.5;

const app = express();
const chain = new ChainConnector();
const agentEngine = new AgentEngine(db, chain, txBuilder);

// Load or generate server keypair (escrow wallet)
const serverKeypair = txBuilder.loadKeypair(db.DATA_DIR);
console.log(`[SERVER] Escrow wallet: ${serverKeypair.address}`);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://gateway.pinata.cloud", "https://images.unsplash.com", "https://replicate.delivery", "https://pbxt.replicate.delivery", "blob:"],
            connectSrc: ["'self'", "https://unpkg.com"]
        }
    }
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', apiLimiter);

const mintLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'Too many mint requests, please wait' }
});

const guestMintLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    message: { error: 'Too many guest mint requests, please wait' }
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────

// Store pending challenges (in-memory, cleared on restart)
const pendingChallenges = new Map();

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET);
        req.user = { address: decoded.address };
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────

// Get a challenge to sign (proves wallet ownership)
app.post('/api/auth/challenge', (req, res) => {
    const { address } = req.body;
    if (!address || typeof address !== 'string' || address.length < 20 || address.length > 50) {
        return res.status(400).json({ error: 'Invalid wallet address' });
    }
    // Clean old challenges (>5 min) and enforce cap
    for (const [addr, data] of pendingChallenges) {
        if (Date.now() - data.createdAt > 300000) pendingChallenges.delete(addr);
    }
    if (pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
        return res.status(429).json({ error: 'Too many pending auth requests. Try again later.' });
    }

    const challenge = `Sign this message to connect to NFT Forge\nAddress: ${address}\nNonce: ${crypto.randomBytes(16).toString('hex')}\nTimestamp: ${Date.now()}`;
    pendingChallenges.set(address, { challenge, createdAt: Date.now() });
    res.json({ challenge });
});

// Connect wallet (verify Ed25519 signature of challenge)
app.post('/api/auth/connect', async (req, res) => {
    try {
        const { address, signature } = req.body;
        if (!address || typeof address !== 'string' || address.length < 20) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }

        const pending = pendingChallenges.get(address);
        pendingChallenges.delete(address);

        // Verify signature if wallet supports it
        if (signature && typeof signature === 'string' && signature.length > 500) {
            return res.status(400).json({ error: 'Invalid signature' });
        }
        if (signature && signature !== 'wallet-browser-auth' && pending) {
            try {
                const sigBytes = Buffer.from(signature, 'base64');
                const messageBytes = Buffer.from(pending.challenge, 'utf8');
                const pubKeyBytes = txBuilder.base58Decode(address);
                const valid = nacl.sign.detached.verify(messageBytes, sigBytes, pubKeyBytes);
                if (!valid) {
                    return res.status(401).json({ error: 'Invalid signature' });
                }
            } catch (e) {
                console.warn(`[AUTH] Signature verification error: ${e.message}`);
                // Fall through — wallet may not support standard signing
            }
        } else if (!pending) {
            // No challenge was requested — require at least that
            return res.status(400).json({ error: 'Request a challenge first' });
        }

        // Ensure user record exists
        const user = await db.getOrCreateUser(address);

        const token = jwt.sign({ address, userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
        res.json({
            token,
            user: { id: user.id, address: user.address, username: user.username }
        });
    } catch (e) {
        console.error(`[AUTH] Connect error: ${e.message}`);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
    const found = await db.users.find({ address: req.user.address });
    if (!found[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: found[0] });
});

// ─── GENERATE ROUTE (preview only, no mint) ─────────────────────────

// Store pending generations (in-memory, cleared on restart)
const pendingGenerations = new Map();
const MAX_PENDING_GENERATIONS = 500;
const MAX_PENDING_CHALLENGES = 2000;

// Clean old generations every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30 min expiry
    for (const [key, gen] of pendingGenerations) {
        if (gen.createdAt < cutoff) pendingGenerations.delete(key);
    }
}, 5 * 60 * 1000);

const generateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many generate requests, please wait' }
});

app.post('/api/generate', generateLimiter, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
            return res.status(400).json({ error: 'Prompt must be at least 3 characters' });
        }

        const sanitizedPrompt = prompt.trim().substring(0, 500);

        // Enforce pending generation cap
        if (pendingGenerations.size >= MAX_PENDING_GENERATIONS) {
            return res.status(429).json({ error: 'Too many pending generations. Please try again shortly.' });
        }

        console.log(`[GENERATE] prompt: "${sanitizedPrompt.substring(0, 30)}..."`);

        // Generate AI image
        const imageResult = await aiImage.generateImage(sanitizedPrompt);

        // Upload image to IPFS
        const genId = crypto.randomUUID();
        const ext = imageResult.fileExtension || 'webp';
        const filename = `preview-${genId}.${ext}`;
        const imageUpload = await ipfs.uploadImage(imageResult.imageBuffer, filename);

        // Store for later minting
        pendingGenerations.set(genId, {
            prompt: sanitizedPrompt,
            imageCID: imageUpload.cid,
            imageUrl: imageUpload.url,
            imageGateway: imageUpload.gateway,
            fileExtension: ext,
            createdAt: Date.now()
        });

        console.log(`[GENERATE] Preview ready: ${genId}`);

        res.json({
            success: true,
            generationId: genId,
            imageUrl: imageUpload.gateway
        });
    } catch (e) {
        console.error(`[GENERATE] Error: ${e.message}`);
        res.status(500).json({ error: 'Image generation failed. Please try again.' });
    }
});

// ─── MINT ROUTES ─────────────────────────────────────────────────────

app.post('/api/mint', requireAuth, mintLimiter, async (req, res) => {
    try {
        const { generationId, collectionId, name } = req.body;
        if (!generationId) {
            return res.status(400).json({ error: 'Generate an image first' });
        }

        const gen = pendingGenerations.get(generationId);
        if (!gen) {
            return res.status(400).json({ error: 'Generation expired or not found. Please generate again.' });
        }

        const creatorAddress = req.user.address;

        // Verify collection exists and user owns it (if specified)
        let collection = null;
        if (collectionId) {
            collection = await db.collections.getById(collectionId);
            if (!collection) return res.status(404).json({ error: 'Collection not found' });
            if (collection.creatorAddress !== creatorAddress) {
                return res.status(403).json({ error: 'You do not own this collection' });
            }
            if (collection.maxSupply > 0 && collection.mintCount >= collection.maxSupply) {
                return res.status(400).json({ error: 'Collection max supply reached' });
            }
        }

        const nftNumber = await db.nextTokenNumber();
        const nftName = name || `AI Art #${nftNumber}`;

        // Build metadata
        const metadata = {
            name: nftName,
            description: `AI-generated NFT on NFT Forge`,
            image: gen.imageUrl,
            attributes: {
                creator: creatorAddress,
                collection: collection ? collection.name : 'Uncollected',
                ai_generated: true,
                created_at: new Date().toISOString()
            }
        };

        // Upload metadata to IPFS
        const metadataUpload = await ipfs.uploadMetadata(metadata);

        // Save NFT to database
        const nft = await db.createNFT({
            collectionId: collectionId || null,
            tokenNumber: nftNumber,
            ownerAddress: creatorAddress,
            creatorAddress,
            name: nftName,
            promptText: gen.prompt,
            imageCID: gen.imageCID,
            metadataCID: metadataUpload.cid,
            imageUrl: gen.imageGateway,
            metadataUrl: metadataUpload.gateway
        });

        if (collectionId) {
            await db.incrementMintCount(collectionId);
        }

        // Remove used generation
        pendingGenerations.delete(generationId);

        console.log(`[MINT] NFT created: ${nft.id} "${nftName}"`);

        res.json({
            success: true,
            nft: {
                ...nft,
                imageGateway: gen.imageGateway,
                metadataGateway: metadataUpload.gateway
            }
        });
    } catch (e) {
        console.error(`[MINT] Error: ${e.message}`);
        res.status(500).json({ error: 'Mint failed. Please try again.' });
    }
});

// ─── GUEST MINT (no wallet extension required) ──────────────────────

app.post('/api/mint/guest', guestMintLimiter, async (req, res) => {
    try {
        const { generationId, walletAddress, name } = req.body;

        if (!generationId) {
            return res.status(400).json({ error: 'Generate an image first' });
        }
        if (!walletAddress || typeof walletAddress !== 'string') {
            return res.status(400).json({ error: 'Wallet address required' });
        }

        const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
        if (!base58Regex.test(walletAddress)) {
            return res.status(400).json({ error: 'Invalid wallet address format' });
        }

        const gen = pendingGenerations.get(generationId);
        if (!gen) {
            return res.status(400).json({ error: 'Generation expired or not found. Please generate again.' });
        }

        const creatorAddress = walletAddress;
        await db.getOrCreateUser(creatorAddress);

        const nftNumber = await db.nextTokenNumber();
        const nftName = name || `AI Art #${nftNumber}`;

        const metadata = {
            name: nftName,
            description: `AI-generated NFT on NFT Forge`,
            image: gen.imageUrl,
            attributes: {
                creator: creatorAddress,
                collection: 'Uncollected',
                ai_generated: true,
                created_at: new Date().toISOString(),
                mint_type: 'guest'
            }
        };

        const metadataUpload = await ipfs.uploadMetadata(metadata);

        const nft = await db.createNFT({
            collectionId: null,
            tokenNumber: nftNumber,
            ownerAddress: creatorAddress,
            creatorAddress,
            name: nftName,
            promptText: gen.prompt,
            imageCID: gen.imageCID,
            metadataCID: metadataUpload.cid,
            imageUrl: gen.imageGateway,
            metadataUrl: metadataUpload.gateway
        });

        pendingGenerations.delete(generationId);

        console.log(`[GUEST MINT] NFT created: ${nft.id} "${nftName}"`);

        res.json({
            success: true,
            nft: {
                ...nft,
                imageGateway: gen.imageGateway,
                metadataGateway: metadataUpload.gateway
            }
        });
    } catch (e) {
        console.error(`[GUEST MINT] Error: ${e.message}`);
        res.status(500).json({ error: 'Mint failed. Please try again.' });
    }
});

// ─── NFT QUERY ROUTES ────────────────────────────────────────────────

app.get('/api/nfts', async (req, res) => {
    try {
        const { page = 1, limit = 20, collection, creator, owner } = req.query;
        const filter = {};
        if (collection) filter.collectionId = collection;
        if (creator) filter.creatorAddress = creator;
        if (owner) filter.ownerAddress = owner;

        const result = await db.nfts.list({
            page: parseInt(page) || 1,
            limit: Math.min(parseInt(limit) || 20, 100),
            filter,
            sort: { field: 'mintedAt', order: 'desc' }
        });
        res.json(result);
    } catch (e) {
        console.error(`[API] GET /api/nfts error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load NFTs' });
    }
});

app.get('/api/nfts/:id', async (req, res) => {
    try {
        const nft = await db.nfts.getById(req.params.id);
        if (!nft) return res.status(404).json({ error: 'NFT not found' });

        let collection = null;
        if (nft.collectionId) {
            collection = await db.collections.getById(nft.collectionId);
        }

        res.json({ nft, collection });
    } catch (e) {
        console.error(`[API] GET /api/nfts/:id error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load NFT' });
    }
});

app.get('/api/nfts/owner/:address', async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const result = await db.nfts.list({
            page: parseInt(page) || 1,
            limit: Math.min(parseInt(limit) || 20, 100),
            filter: { ownerAddress: req.params.address },
            sort: { field: 'mintedAt', order: 'desc' }
        });
        res.json(result);
    } catch (e) {
        console.error(`[API] GET /api/nfts/owner error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load NFTs' });
    }
});

// ─── COLLECTION ROUTES ───────────────────────────────────────────────

app.get('/api/collections', async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const result = await db.collections.list({
            page: parseInt(page) || 1,
            limit: Math.min(parseInt(limit) || 20, 100),
            sort: { field: 'createdAt', order: 'desc' }
        });
        res.json(result);
    } catch (e) {
        console.error(`[API] GET /api/collections error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load collections' });
    }
});

app.get('/api/collections/:id', async (req, res) => {
    try {
        const collection = await db.collections.getById(req.params.id);
        if (!collection) return res.status(404).json({ error: 'Collection not found' });

        const nftsResult = await db.nfts.list({
            filter: { collectionId: req.params.id },
            sort: { field: 'mintedAt', order: 'desc' },
            limit: 100
        });

        res.json({ collection, nfts: nftsResult });
    } catch (e) {
        console.error(`[API] GET /api/collections/:id error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load collection' });
    }
});

app.post('/api/collections', requireAuth, async (req, res) => {
    try {
        const { name, symbol, description, maxSupply } = req.body;
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return res.status(400).json({ error: 'Collection name must be at least 2 characters' });
        }

        const collection = await db.createCollection({
            name: name.trim(),
            symbol: symbol ? symbol.trim().toUpperCase() : undefined,
            creatorAddress: req.user.address,
            description: description || '',
            maxSupply: parseInt(maxSupply) || 0
        });

        res.json({ success: true, collection });
    } catch (e) {
        console.error(`[API] POST /api/collections error: ${e.message}`);
        res.status(500).json({ error: 'Failed to create collection' });
    }
});

// ─── MARKETPLACE ROUTES ──────────────────────────────────────────────

app.get('/api/listings', async (req, res) => {
    try {
        const { page = 1, limit = 20, sort = 'date' } = req.query;
        const sortField = sort === 'price' ? 'priceLamports' : 'createdAt';

        const result = await db.listings.list({
            page: parseInt(page) || 1,
            limit: Math.min(parseInt(limit) || 20, 100),
            filter: { status: 'active' },
            sort: { field: sortField, order: sort === 'price_asc' ? 'asc' : 'desc' }
        });

        // Enrich with NFT data (parallel)
        const enriched = await Promise.all(
            result.items.map(async (listing) => {
                const nft = await db.nfts.getById(listing.nftId);
                return { ...listing, nft: nft || null };
            })
        );
        result.items = enriched;

        res.json(result);
    } catch (e) {
        console.error(`[API] GET /api/listings error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load listings' });
    }
});

app.get('/api/listings/by-nft/:nftId', async (req, res) => {
    try {
        const active = await db.listings.find({ nftId: req.params.nftId, status: 'active' });
        res.json({ listing: active[0] || null });
    } catch (e) {
        console.error(`[API] GET /api/listings/by-nft error: ${e.message}`);
        res.status(500).json({ error: 'Failed to check listing' });
    }
});

app.post('/api/listings', requireAuth, async (req, res) => {
    try {
        const { nftId, priceXRS } = req.body;

        if (!nftId) return res.status(400).json({ error: 'NFT ID required' });
        if (!priceXRS || priceXRS <= 0) return res.status(400).json({ error: 'Price must be positive' });

        const nft = await db.nfts.getById(nftId);
        if (!nft) return res.status(404).json({ error: 'NFT not found' });
        if (nft.ownerAddress !== req.user.address) {
            return res.status(403).json({ error: 'You do not own this NFT' });
        }

        const existing = await db.listings.find({ nftId, status: 'active' });
        if (existing.length > 0) {
            return res.status(400).json({ error: 'NFT is already listed' });
        }

        const listing = await db.createListing({
            nftId,
            sellerAddress: req.user.address,
            priceXRS: parseFloat(priceXRS)
        });

        res.json({ success: true, listing });
    } catch (e) {
        console.error(`[API] POST /api/listings error: ${e.message}`);
        res.status(500).json({ error: 'Failed to create listing' });
    }
});

app.delete('/api/listings/:id', requireAuth, async (req, res) => {
    try {
        const listing = await db.listings.getById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.sellerAddress !== req.user.address) {
            return res.status(403).json({ error: 'Not your listing' });
        }
        if (listing.status !== 'active') {
            return res.status(400).json({ error: 'Listing is not active' });
        }

        await db.cancelListing(req.params.id);
        res.json({ success: true });
    } catch (e) {
        console.error(`[API] DELETE /api/listings error: ${e.message}`);
        res.status(500).json({ error: 'Failed to cancel listing' });
    }
});

// In-flight buy locks to prevent double-purchase
const buyLocks = new Set();

// Buy NFT — buyer sends payment tx signature (wallet already submitted the tx)
app.post('/api/listings/:id/buy', requireAuth, async (req, res) => {
    const listingId = req.params.id;

    // Prevent concurrent purchases of the same listing
    if (buyLocks.has(listingId)) {
        return res.status(409).json({ error: 'This listing is being purchased by another buyer' });
    }
    buyLocks.add(listingId);

    try {
        const { txSignature } = req.body;
        const buyerAddress = req.user.address;

        if (!txSignature || typeof txSignature !== 'string' || txSignature.length < 10) {
            return res.status(400).json({ error: 'Valid payment transaction signature required' });
        }

        const listing = await db.listings.getById(listingId);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.status !== 'active') return res.status(400).json({ error: 'Listing no longer active' });
        if (listing.sellerAddress === buyerAddress) {
            return res.status(400).json({ error: 'Cannot buy your own NFT' });
        }

        console.log(`[TRADE] Buy attempt: listing=${listingId} buyer=${buyerAddress.substring(0, 12)}...`);

        // Step 1: Record escrow balance BEFORE (payment should already be in-flight)
        const balanceBefore = (await chain.getBalance(serverKeypair.address)).balance || 0;

        // Step 2: Wait for payment to settle (wallet already submitted tx)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Step 3: Check escrow balance AFTER — it should have increased by at least the listing price
        const balanceAfter = (await chain.getBalance(serverKeypair.address)).balance || 0;
        const balanceIncrease = balanceAfter - balanceBefore;

        console.log(`[TRADE] Escrow balance: before=${balanceBefore} after=${balanceAfter} increase=${balanceIncrease} need=${listing.priceLamports}`);

        // Verify the balance increased by at least the listing price
        // Allow 10% tolerance for timing (other txs may also be settling)
        if (balanceIncrease < listing.priceLamports * 0.9) {
            // Fallback: also accept if total balance covers it (for cases where balance was already there)
            if (balanceAfter < listing.priceLamports) {
                console.log(`[TRADE] Payment verification failed`);
                return res.status(400).json({
                    error: 'Payment not verified. Please ensure you have enough XRS and try again.'
                });
            }
        }

        // Step 4: Mark listing as pending immediately to prevent double-sell
        await db.listings.update(listingId, { status: 'pending' });

        // Step 5: Transfer NFT ownership
        const nft = await db.transferNFT(listing.nftId, buyerAddress);

        // Step 6: Mark listing as sold
        await db.completeListing(listingId);

        // Step 7: Record trade
        const trade = await db.recordTrade({
            listingId,
            nftId: listing.nftId,
            buyerAddress,
            sellerAddress: listing.sellerAddress,
            priceLamports: listing.priceLamports,
            paymentTxSignature: txSignature
        });

        // Step 8: Send payment to seller (minus platform fee) from escrow
        try {
            const platformFee = Math.floor(listing.priceLamports * PLATFORM_FEE_PERCENT / 100);
            const sellerAmount = listing.priceLamports - platformFee;

            const blockhash = await chain.getRecentBlockhash();
            const signFn = (message) => crypto.sign(null, message, serverKeypair.privateKey);

            const payoutTx = txBuilder.buildXerisTransferTransaction(
                serverKeypair.publicKeyRaw,
                listing.sellerAddress,
                sellerAmount,
                blockhash,
                signFn
            );

            await chain.submitSignedTransaction({
                txBase64: payoutTx.base64,
                signature: payoutTx.signatureBase58
            });

            console.log(`[TRADE] Seller payout: ${sellerAmount} lamports (fee: ${platformFee}) to ${listing.sellerAddress.substring(0, 12)}...`);
        } catch (e) {
            console.error(`[TRADE] Seller payout failed: ${e.message}`);
            // Trade still succeeds — manual payout can be done later
        }

        res.json({
            success: true,
            trade,
            nft,
            message: 'NFT purchased successfully'
        });
    } catch (e) {
        console.error(`[TRADE] Error: ${e.message}`);
        // If we set status to pending but failed, revert to active
        try { await db.listings.update(listingId, { status: 'active' }); } catch (_) {}
        res.status(500).json({ error: 'Purchase failed. Please try again.' });
    } finally {
        buyLocks.delete(listingId);
    }
});

// ─── IMAGE/METADATA SERVING ──────────────────────────────────────────

app.get('/api/images/:filename', (req, res) => {
    const filePath = path.join(ipfs.IMAGES_DIR, path.basename(req.params.filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image not found' });

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(filePath);
});

app.get('/api/metadata/:filename', (req, res) => {
    const filePath = path.join(ipfs.METADATA_DIR, path.basename(req.params.filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Metadata not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(filePath);
});

// ─── CHAIN PROXY ROUTES ─────────────────────────────────────────────

app.get('/api/chain/blockhash', async (req, res) => {
    try {
        const blockhash = await chain.getRecentBlockhash();
        res.json({ blockhash });
    } catch (e) {
        console.error(`[API] blockhash error: ${e.message}`);
        res.status(500).json({ error: 'Failed to get blockhash' });
    }
});

app.post('/api/chain/submit', requireAuth, async (req, res) => {
    try {
        const { tx_base64 } = req.body;
        if (!tx_base64) return res.status(400).json({ error: 'tx_base64 required' });

        const result = await chain.submitSignedTransaction({ txBase64: tx_base64 });
        res.json(result);
    } catch (e) {
        console.error(`[API] submit error: ${e.message}`);
        res.status(500).json({ error: 'Transaction submit failed' });
    }
});

app.get('/api/chain/balance/:address', async (req, res) => {
    try {
        const balance = await chain.getBalance(req.params.address);
        res.json(balance);
    } catch (e) {
        console.error(`[API] balance error: ${e.message}`);
        res.status(500).json({ error: 'Balance check failed' });
    }
});

app.get('/api/chain/info', async (req, res) => {
    try {
        const info = await chain.getChainInfo();
        res.json(info);
    } catch (e) {
        console.error(`[API] chain info error: ${e.message}`);
        res.status(500).json({ error: 'Failed to get chain info' });
    }
});

// ─── PLATFORM INFO ───────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
    try {
        const [totalNFTs, totalCollections, totalUsers, totalListings, totalTrades, totalAgents] = await Promise.all([
            db.nfts.count(),
            db.collections.count(),
            db.users.count(),
            db.listings.count({ status: 'active' }),
            db.trades.count(),
            db.agents.count({ status: 'active' })
        ]);
        res.json({
            totalNFTs,
            totalCollections,
            totalUsers,
            totalListings,
            totalTrades,
            totalAgents,
            escrowAddress: serverKeypair.address,
            ipfsConfigured: ipfs.isConfigured(),
            aiConfigured: aiImage.isConfigured(),
            zkAvailable: zkPayments.isZKAvailable(),
            agentEngineRunning: agentEngine.running,
            platformFeePercent: PLATFORM_FEE_PERCENT
        });
    } catch (e) {
        console.error(`[API] GET /api/stats error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// ─── AI AGENT ROUTES ────────────────────────────────────────────────

// Get available strategies
app.get('/api/agents/strategies', (req, res) => {
    res.json({ strategies: agentEngine.getStrategies() });
});

// List user's agents
app.get('/api/agents', requireAuth, async (req, res) => {
    try {
        const userAgents = await db.agents.find({ ownerAddress: req.user.address });
        res.json({ agents: userAgents });
    } catch (e) {
        console.error(`[API] GET /api/agents error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load agents' });
    }
});

// Create agent
app.post('/api/agents', requireAuth, async (req, res) => {
    try {
        const { name, strategy, config } = req.body;
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return res.status(400).json({ error: 'Agent name must be at least 2 characters' });
        }

        // Limit agents per user
        const existing = await db.agents.find({ ownerAddress: req.user.address });
        if (existing.length >= 3) {
            return res.status(400).json({ error: 'Maximum 3 agents per user' });
        }

        const validStrategies = ['bargain_hunter', 'collector', 'flipper'];
        if (strategy && !validStrategies.includes(strategy)) {
            return res.status(400).json({ error: 'Invalid strategy' });
        }

        const safeConfig = {
            spendingLimit: Math.min(parseFloat(config?.spendingLimit) || 10, 1000),
            maxBuyPrice: Math.min(parseFloat(config?.maxBuyPrice) || 5, 500),
            maxBuysPerCycle: Math.min(parseInt(config?.maxBuysPerCycle) || 1, 5),
            keywords: typeof config?.keywords === 'string' ? config.keywords.substring(0, 200) : '',
            markupPercent: Math.min(parseInt(config?.markupPercent) || 50, 500)
        };

        const agent = await db.createAgent({
            name: name.trim().substring(0, 50),
            ownerAddress: req.user.address,
            strategy: strategy || 'bargain_hunter',
            config: safeConfig
        });

        console.log(`[AGENT] Created: "${agent.name}" (${agent.strategy}) by ${req.user.address.substring(0, 12)}...`);
        res.json({ success: true, agent });
    } catch (e) {
        console.error(`[API] POST /api/agents error: ${e.message}`);
        res.status(500).json({ error: 'Failed to create agent' });
    }
});

// Update agent (pause/resume/update config)
app.patch('/api/agents/:id', requireAuth, async (req, res) => {
    try {
        const agent = await db.agents.getById(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (agent.ownerAddress !== req.user.address) {
            return res.status(403).json({ error: 'Not your agent' });
        }

        const updates = {};
        if (req.body.status === 'active' || req.body.status === 'paused') {
            updates.status = req.body.status;
        }
        if (req.body.config) {
            updates.config = {
                spendingLimit: Math.min(parseFloat(req.body.config.spendingLimit) || 10, 1000),
                maxBuyPrice: Math.min(parseFloat(req.body.config.maxBuyPrice) || 5, 500),
                maxBuysPerCycle: Math.min(parseInt(req.body.config.maxBuysPerCycle) || 1, 5),
                keywords: typeof req.body.config.keywords === 'string' ? req.body.config.keywords.substring(0, 200) : '',
                markupPercent: Math.min(parseInt(req.body.config.markupPercent) || 50, 500)
            };
        }

        const updated = await db.agents.update(req.params.id, updates);
        res.json({ success: true, agent: updated });
    } catch (e) {
        console.error(`[API] PATCH /api/agents error: ${e.message}`);
        res.status(500).json({ error: 'Failed to update agent' });
    }
});

// Revoke agent (permanent deactivation)
app.delete('/api/agents/:id', requireAuth, async (req, res) => {
    try {
        const agent = await db.agents.getById(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (agent.ownerAddress !== req.user.address) {
            return res.status(403).json({ error: 'Not your agent' });
        }

        await db.agents.update(req.params.id, { status: 'revoked' });
        console.log(`[AGENT] Revoked: "${agent.name}" by ${req.user.address.substring(0, 12)}...`);
        res.json({ success: true });
    } catch (e) {
        console.error(`[API] DELETE /api/agents error: ${e.message}`);
        res.status(500).json({ error: 'Failed to revoke agent' });
    }
});

// Get agent activity log
app.get('/api/agents/:id/activity', requireAuth, async (req, res) => {
    try {
        const agent = await db.agents.getById(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (agent.ownerAddress !== req.user.address) {
            return res.status(403).json({ error: 'Not your agent' });
        }

        const result = await db.agentActivity.list({
            filter: { agentId: req.params.id },
            sort: { field: 'createdAt', order: 'desc' },
            limit: Math.min(parseInt(req.query.limit) || 50, 200)
        });
        res.json(result);
    } catch (e) {
        console.error(`[API] GET /api/agents/:id/activity error: ${e.message}`);
        res.status(500).json({ error: 'Failed to load activity' });
    }
});

// ─── ZK PAYMENT INFO ────────────────────────────────────────────────

app.get('/api/zk/status', (req, res) => {
    res.json({
        zkAvailable: zkPayments.isZKAvailable(),
        description: zkPayments.isZKAvailable()
            ? 'ZK private transfers are available via xeris-sdk'
            : 'ZK transfers using local commitment scheme (amount visible on-chain, commitment tracked off-chain)'
    });
});

// ─── SPA FALLBACK ────────────────────────────────────────────────────

app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─── START SERVER ────────────────────────────────────────────────────

async function start() {
    await db.initDB();

    // Start agent engine
    agentEngine.start();

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n========================================`);
        console.log(`  NFT Forge`);
        console.log(`  http://localhost:${PORT}`);
        console.log(`  Escrow:  ${serverKeypair.address}`);
        console.log(`  DB:      ${process.env.DATABASE_URL ? 'PostgreSQL' : 'JSON files'}`);
        console.log(`  AI:      ${aiImage.isConfigured() ? 'Replicate' : 'Mock SVG'}`);
        console.log(`  IPFS:    ${ipfs.isConfigured() ? 'Pinata' : 'Local fallback'}`);
        console.log(`  ZK:      ${zkPayments.isZKAvailable() ? 'xeris-sdk' : 'Local commitments'}`);
        console.log(`  Agents:  Engine running (30s cycles)`);
        console.log(`  Network: ${chain.networkName}`);
        console.log(`========================================\n`);
    });
}

start().catch(e => {
    console.error('[FATAL] Startup failed:', e.message);
    process.exit(1);
});
