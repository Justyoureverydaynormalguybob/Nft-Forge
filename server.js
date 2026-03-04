// ============================================
// NFT-XERIS — EXPRESS SERVER
// ============================================
// AI-generated NFT minting platform on Xeris chain.
// Mock contract layer with on-chain proofs.
// ============================================

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const ChainConnector = require('./chain');
const txBuilder = require('./tx-builder');
const db = require('./database');
const mockAI = require('./mock-ai');
const ipfs = require('./ipfs');

// ─── CONFIGURATION ───────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT) || 2.5;

const app = express();
const chain = new ChainConnector();

// Load or generate server keypair (escrow wallet)
const serverKeypair = txBuilder.loadKeypair(db.DATA_DIR);
console.log(`[SERVER] Escrow wallet: ${serverKeypair.address}`);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://gateway.pinata.cloud", "blob:"],
            connectSrc: ["'self'"]
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
    if (!address || typeof address !== 'string' || address.length < 20) {
        return res.status(400).json({ error: 'Invalid wallet address' });
    }
    const challenge = `Sign this message to connect to Xeris NFT Platform\nAddress: ${address}\nNonce: ${crypto.randomBytes(16).toString('hex')}\nTimestamp: ${Date.now()}`;
    pendingChallenges.set(address, { challenge, createdAt: Date.now() });
    // Clean old challenges (>5 min)
    for (const [addr, data] of pendingChallenges) {
        if (Date.now() - data.createdAt > 300000) pendingChallenges.delete(addr);
    }
    res.json({ challenge });
});

// Connect wallet (verify signature or simplified auth for dev)
app.post('/api/auth/connect', (req, res) => {
    const { address, signature } = req.body;
    if (!address || typeof address !== 'string' || address.length < 20) {
        return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // In production: verify Ed25519 signature against challenge
    // For now: accept any valid-looking address (wallet browser handles auth)
    // The wallet browser itself authenticates the user via device keys
    const pending = pendingChallenges.get(address);
    if (pending) {
        pendingChallenges.delete(address);
    }

    // Ensure user record exists
    const user = db.getOrCreateUser(address);

    const token = jwt.sign({ address, userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
        token,
        user: { id: user.id, address: user.address, username: user.username }
    });
});

// Get current user
app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = db.users.find({ address: req.user.address })[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
});

// ─── MINT ROUTES ─────────────────────────────────────────────────────

app.post('/api/mint', requireAuth, mintLimiter, async (req, res) => {
    try {
        const { prompt, collectionId, name } = req.body;
        if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
            return res.status(400).json({ error: 'Prompt must be at least 3 characters' });
        }

        const creatorAddress = req.user.address;
        const sanitizedPrompt = prompt.trim().substring(0, 500);

        // Verify collection exists and belongs to creator (if specified)
        let collection = null;
        if (collectionId) {
            collection = db.collections.getById(collectionId);
            if (!collection) return res.status(404).json({ error: 'Collection not found' });
            if (collection.maxSupply > 0 && collection.mintCount >= collection.maxSupply) {
                return res.status(400).json({ error: 'Collection max supply reached' });
            }
        }

        console.log(`[MINT] Generating NFT for ${creatorAddress.substring(0, 12)}... prompt: "${sanitizedPrompt.substring(0, 30)}..."`);

        // 1. Generate image
        const imageResult = mockAI.generateImage(sanitizedPrompt);

        // 2. Upload image to IPFS
        const nftNumber = db.nfts.data.length + 1;
        const filename = `nft-${nftNumber}.svg`;
        const imageUpload = await ipfs.uploadImage(imageResult.imageBuffer, filename);

        // 3. Build metadata
        const nftName = name || `AI Art #${nftNumber}`;
        const metadata = {
            name: nftName,
            description: `Generated from prompt: ${sanitizedPrompt}`,
            image: imageUpload.url,
            attributes: {
                prompt: sanitizedPrompt,
                creator: creatorAddress,
                collection: collection ? collection.name : 'Uncollected',
                created_at: new Date().toISOString()
            },
            xeris_proof: {}
        };

        // 4. Upload metadata to IPFS
        const metadataUpload = await ipfs.uploadMetadata(metadata);

        // 5. Build proof hash
        const proofHash = crypto.createHash('sha256')
            .update(imageUpload.cid + metadataUpload.cid + creatorAddress + Date.now().toString())
            .digest('hex');

        // 6. Record on-chain proof via NativeTransfer
        let mintTxSignature = '';
        let certAddress = '';
        let blockSlot = null;

        try {
            const blockhash = await chain.getRecentBlockhash();
            const certTx = txBuilder.buildCertificationTx(proofHash, blockhash, serverKeypair);
            certAddress = certTx.certAddress;

            const submitResult = await chain.submitSignedTransaction({
                txBase64: certTx.base64,
                signature: certTx.signatureBase58
            });

            if (submitResult.success) {
                mintTxSignature = certTx.signatureBase58;
                blockSlot = submitResult.blockNumber;
                console.log(`[MINT] On-chain proof recorded: ${mintTxSignature.substring(0, 16)}... slot ${blockSlot}`);
            } else {
                console.log('[MINT] On-chain proof failed, continuing with off-chain only');
            }
        } catch (e) {
            console.error(`[MINT] Chain proof error: ${e.message}`);
        }

        // Update metadata with proof info
        metadata.xeris_proof = {
            cert_address: certAddress,
            tx_signature: mintTxSignature,
            block_slot: blockSlot,
            proof_hash: proofHash
        };

        // 7. Save NFT to database
        const nft = db.createNFT({
            collectionId: collectionId || null,
            tokenNumber: nftNumber,
            ownerAddress: creatorAddress,
            creatorAddress,
            name: nftName,
            promptText: sanitizedPrompt,
            imageCID: imageUpload.cid,
            metadataCID: metadataUpload.cid,
            imageUrl: imageUpload.gateway,
            metadataUrl: metadataUpload.gateway,
            mintTxSignature,
            certAddress,
            proofHash
        });

        // Increment collection mint count
        if (collectionId) {
            db.incrementMintCount(collectionId);
        }

        console.log(`[MINT] NFT created: ${nft.id} "${nftName}"`);

        res.json({
            success: true,
            nft: {
                ...nft,
                imageGateway: imageUpload.gateway,
                metadataGateway: metadataUpload.gateway,
                onChain: !!mintTxSignature,
                blockSlot
            }
        });
    } catch (e) {
        console.error(`[MINT] Error: ${e.message}`);
        res.status(500).json({ error: 'Mint failed: ' + e.message });
    }
});

// ─── NFT QUERY ROUTES ────────────────────────────────────────────────

app.get('/api/nfts', (req, res) => {
    const { page = 1, limit = 20, collection, creator, owner } = req.query;
    const filter = {};
    if (collection) filter.collectionId = collection;
    if (creator) filter.creatorAddress = creator;
    if (owner) filter.ownerAddress = owner;

    const result = db.nfts.list({
        page: parseInt(page),
        limit: Math.min(parseInt(limit) || 20, 100),
        filter,
        sort: { field: 'mintedAt', order: 'desc' }
    });
    res.json(result);
});

app.get('/api/nfts/:id', (req, res) => {
    const nft = db.nfts.getById(req.params.id);
    if (!nft) return res.status(404).json({ error: 'NFT not found' });

    // Include collection info
    let collection = null;
    if (nft.collectionId) {
        collection = db.collections.getById(nft.collectionId);
    }

    res.json({ nft, collection });
});

app.get('/api/nfts/owner/:address', (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const result = db.nfts.list({
        page: parseInt(page),
        limit: Math.min(parseInt(limit) || 20, 100),
        filter: { ownerAddress: req.params.address },
        sort: { field: 'mintedAt', order: 'desc' }
    });
    res.json(result);
});

// ─── COLLECTION ROUTES ───────────────────────────────────────────────

app.get('/api/collections', (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const result = db.collections.list({
        page: parseInt(page),
        limit: Math.min(parseInt(limit) || 20, 100),
        sort: { field: 'createdAt', order: 'desc' }
    });
    res.json(result);
});

app.get('/api/collections/:id', (req, res) => {
    const collection = db.collections.getById(req.params.id);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    const nftsResult = db.nfts.list({
        filter: { collectionId: req.params.id },
        sort: { field: 'mintedAt', order: 'desc' },
        limit: 100
    });

    res.json({ collection, nfts: nftsResult });
});

app.post('/api/collections', requireAuth, (req, res) => {
    const { name, symbol, description, maxSupply } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).json({ error: 'Collection name must be at least 2 characters' });
    }

    const collection = db.createCollection({
        name: name.trim(),
        symbol: symbol ? symbol.trim().toUpperCase() : undefined,
        creatorAddress: req.user.address,
        description: description || '',
        maxSupply: parseInt(maxSupply) || 0
    });

    res.json({ success: true, collection });
});

// ─── MARKETPLACE ROUTES ──────────────────────────────────────────────

app.get('/api/listings', (req, res) => {
    const { page = 1, limit = 20, sort = 'date' } = req.query;
    const sortField = sort === 'price' ? 'priceLamports' : 'createdAt';

    const result = db.listings.list({
        page: parseInt(page),
        limit: Math.min(parseInt(limit) || 20, 100),
        filter: { status: 'active' },
        sort: { field: sortField, order: sort === 'price_asc' ? 'asc' : 'desc' }
    });

    // Enrich with NFT data
    result.items = result.items.map(listing => {
        const nft = db.nfts.getById(listing.nftId);
        return { ...listing, nft: nft || null };
    });

    res.json(result);
});

app.post('/api/listings', requireAuth, (req, res) => {
    const { nftId, priceXRS } = req.body;

    if (!nftId) return res.status(400).json({ error: 'NFT ID required' });
    if (!priceXRS || priceXRS <= 0) return res.status(400).json({ error: 'Price must be positive' });

    const nft = db.nfts.getById(nftId);
    if (!nft) return res.status(404).json({ error: 'NFT not found' });
    if (nft.ownerAddress !== req.user.address) {
        return res.status(403).json({ error: 'You do not own this NFT' });
    }

    // Check if already listed
    const existing = db.listings.find({ nftId, status: 'active' });
    if (existing.length > 0) {
        return res.status(400).json({ error: 'NFT is already listed' });
    }

    const listing = db.createListing({
        nftId,
        sellerAddress: req.user.address,
        priceXRS: parseFloat(priceXRS)
    });

    res.json({ success: true, listing });
});

app.delete('/api/listings/:id', requireAuth, (req, res) => {
    const listing = db.listings.getById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.sellerAddress !== req.user.address) {
        return res.status(403).json({ error: 'Not your listing' });
    }
    if (listing.status !== 'active') {
        return res.status(400).json({ error: 'Listing is not active' });
    }

    db.cancelListing(req.params.id);
    res.json({ success: true });
});

// Buy NFT — buyer submits signed NativeTransfer tx to escrow
app.post('/api/listings/:id/buy', requireAuth, async (req, res) => {
    try {
        const { txBase64 } = req.body;
        const buyerAddress = req.user.address;

        const listing = db.listings.getById(req.params.id);
        if (!listing) return res.status(404).json({ error: 'Listing not found' });
        if (listing.status !== 'active') return res.status(400).json({ error: 'Listing no longer active' });
        if (listing.sellerAddress === buyerAddress) {
            return res.status(400).json({ error: 'Cannot buy your own NFT' });
        }

        // Submit buyer's payment transaction to chain
        let paymentTxSignature = '';
        if (txBase64) {
            const submitResult = await chain.submitSignedTransaction({ txBase64 });
            if (!submitResult.success) {
                return res.status(400).json({ error: 'Payment transaction failed to submit' });
            }
            paymentTxSignature = submitResult.signature || '';
            console.log(`[TRADE] Payment submitted: ${paymentTxSignature}`);
        }

        // Transfer NFT ownership in DB
        const nft = db.transferNFT(listing.nftId, buyerAddress);

        // Mark listing as sold
        db.completeListing(listing.id);

        // Record trade
        const trade = db.recordTrade({
            listingId: listing.id,
            nftId: listing.nftId,
            buyerAddress,
            sellerAddress: listing.sellerAddress,
            priceLamports: listing.priceLamports,
            paymentTxSignature
        });

        // Send payment to seller (minus platform fee) from escrow
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

            console.log(`[TRADE] Seller payout: ${sellerAmount} lamports to ${listing.sellerAddress.substring(0, 12)}...`);
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
        res.status(500).json({ error: 'Purchase failed: ' + e.message });
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

// ─── VERIFICATION ROUTE ──────────────────────────────────────────────

app.get('/api/verify/:nftId', async (req, res) => {
    const nft = db.nfts.getById(req.params.nftId);
    if (!nft) return res.status(404).json({ error: 'NFT not found' });

    const verification = {
        nftId: nft.id,
        name: nft.name,
        certAddress: nft.certAddress,
        proofHash: nft.proofHash,
        mintTxSignature: nft.mintTxSignature,
        imageCID: nft.imageCID,
        metadataCID: nft.metadataCID,
        onChain: false,
        balance: 0
    };

    if (nft.certAddress) {
        try {
            const balanceInfo = await chain.getBalance(nft.certAddress);
            verification.balance = balanceInfo.balance;
            verification.onChain = balanceInfo.balance > 0;
        } catch (e) {
            console.error(`[VERIFY] Balance check failed: ${e.message}`);
        }
    }

    res.json(verification);
});

// ─── CHAIN PROXY ROUTES ─────────────────────────────────────────────

app.get('/api/chain/blockhash', async (req, res) => {
    try {
        const blockhash = await chain.getRecentBlockhash();
        res.json({ blockhash });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get blockhash: ' + e.message });
    }
});

app.post('/api/chain/submit', async (req, res) => {
    try {
        const { tx_base64 } = req.body;
        if (!tx_base64) return res.status(400).json({ error: 'tx_base64 required' });

        const result = await chain.submitSignedTransaction({ txBase64: tx_base64 });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: 'Submit failed: ' + e.message });
    }
});

app.get('/api/chain/balance/:address', async (req, res) => {
    try {
        const balance = await chain.getBalance(req.params.address);
        res.json(balance);
    } catch (e) {
        res.status(500).json({ error: 'Balance check failed: ' + e.message });
    }
});

app.get('/api/chain/info', async (req, res) => {
    try {
        const info = await chain.getChainInfo();
        res.json(info);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── PLATFORM INFO ───────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
    res.json({
        totalNFTs: db.nfts.data.length,
        totalCollections: db.collections.data.length,
        totalUsers: db.users.data.length,
        totalListings: db.listings.find({ status: 'active' }).length,
        totalTrades: db.trades.data.length,
        escrowAddress: serverKeypair.address,
        ipfsConfigured: ipfs.isConfigured(),
        platformFeePercent: PLATFORM_FEE_PERCENT
    });
});

// ─── SPA FALLBACK ────────────────────────────────────────────────────

app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─── START SERVER ────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`  NFT-XERIS Platform`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Escrow: ${serverKeypair.address}`);
    console.log(`  IPFS: ${ipfs.isConfigured() ? 'Pinata' : 'Local fallback'}`);
    console.log(`  Network: ${chain.networkName}`);
    console.log(`========================================\n`);
});
