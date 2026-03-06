// ============================================
// NFT FORGE — AI AGENT ENGINE
// ============================================
// Autonomous art dealer agents that browse,
// evaluate, buy, and relist NFTs on the
// marketplace. Registered via Ari Protocol
// with owner-set spending limits.
// ============================================

const crypto = require('crypto');

// Agent strategies
const STRATEGIES = {
    bargain_hunter: {
        name: 'Bargain Hunter',
        description: 'Buys NFTs listed below estimated value, relists at market price',
        evaluate: (listing, nft, agentConfig) => {
            const maxPrice = agentConfig.maxBuyPrice || 5;
            const priceXRS = listing.priceXRS;
            if (priceXRS > maxPrice) return { buy: false, reason: `Price ${priceXRS} XRS exceeds limit ${maxPrice} XRS` };
            if (priceXRS > agentConfig.spendingLimit) return { buy: false, reason: 'Would exceed spending limit' };
            // Buy if price is below threshold
            return {
                buy: true,
                reason: `Good deal at ${priceXRS} XRS (limit: ${maxPrice} XRS)`,
                relistPrice: Math.round(priceXRS * 1.5 * 100) / 100
            };
        }
    },
    collector: {
        name: 'Art Collector',
        description: 'Collects NFTs matching specific keywords or styles',
        evaluate: (listing, nft, agentConfig) => {
            const keywords = (agentConfig.keywords || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
            if (keywords.length === 0) return { buy: false, reason: 'No keywords configured' };
            const text = `${nft.name} ${nft.promptText}`.toLowerCase();
            const matched = keywords.filter(k => text.includes(k));
            if (matched.length === 0) return { buy: false, reason: 'No keyword match' };
            if (listing.priceXRS > (agentConfig.maxBuyPrice || 10)) return { buy: false, reason: 'Too expensive' };
            if (listing.priceXRS > agentConfig.spendingLimit) return { buy: false, reason: 'Would exceed spending limit' };
            return {
                buy: true,
                reason: `Matched keywords: ${matched.join(', ')}`,
                relistPrice: null // Collector holds, doesn't relist
            };
        }
    },
    flipper: {
        name: 'Quick Flipper',
        description: 'Buys anything cheap and relists immediately at markup',
        evaluate: (listing, nft, agentConfig) => {
            const maxPrice = agentConfig.maxBuyPrice || 2;
            const markup = agentConfig.markupPercent || 50;
            if (listing.priceXRS > maxPrice) return { buy: false, reason: `Price ${listing.priceXRS} XRS too high` };
            if (listing.priceXRS > agentConfig.spendingLimit) return { buy: false, reason: 'Would exceed spending limit' };
            return {
                buy: true,
                reason: `Flip opportunity: buy at ${listing.priceXRS}, sell at ${(listing.priceXRS * (1 + markup / 100)).toFixed(2)}`,
                relistPrice: Math.round(listing.priceXRS * (1 + markup / 100) * 100) / 100
            };
        }
    }
};

class AgentEngine {
    constructor(db, chain, txBuilder) {
        this.db = db;
        this.chain = chain;
        this.txBuilder = txBuilder;
        this.running = false;
        this.intervalId = null;
        this.CYCLE_INTERVAL = 30000; // 30 seconds between agent cycles
    }

    start() {
        if (this.running) return;
        this.running = true;
        console.log('[AGENT] Engine started — cycling every 30s');
        this.intervalId = setInterval(() => this.runCycle(), this.CYCLE_INTERVAL);
        // Run first cycle after a short delay
        setTimeout(() => this.runCycle(), 5000);
    }

    stop() {
        this.running = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        console.log('[AGENT] Engine stopped');
    }

    async runCycle() {
        try {
            // Get all active agents
            const agents = await this.db.agents.find({ status: 'active' });
            if (agents.length === 0) return;

            // Get active listings
            const listingsResult = await this.db.listings.list({
                filter: { status: 'active' },
                limit: 50,
                sort: { field: 'createdAt', order: 'desc' }
            });
            const listings = listingsResult.items;
            if (listings.length === 0) return;

            for (const agent of agents) {
                try {
                    await this.processAgent(agent, listings);
                } catch (e) {
                    console.error(`[AGENT] Error processing agent ${agent.id}: ${e.message}`);
                    await this.logActivity(agent.id, 'error', { error: e.message });
                }
            }
        } catch (e) {
            console.error(`[AGENT] Cycle error: ${e.message}`);
        }
    }

    async processAgent(agent, listings) {
        const strategy = STRATEGIES[agent.strategy];
        if (!strategy) return;

        const config = agent.config || {};
        const totalSpent = agent.totalSpent || 0;
        const remainingBudget = (config.spendingLimit || 0) - totalSpent;

        if (remainingBudget <= 0) {
            return; // Budget exhausted
        }

        // Don't buy own listings
        const eligibleListings = listings.filter(l => l.sellerAddress !== agent.ownerAddress);

        let evaluated = 0;
        let bought = 0;

        for (const listing of eligibleListings) {
            if (bought >= (config.maxBuysPerCycle || 1)) break;
            evaluated++;

            // Get NFT data
            const nft = await this.db.nfts.getById(listing.nftId);
            if (!nft) continue;

            // Run strategy evaluation
            const configWithBudget = { ...config, spendingLimit: remainingBudget };
            const decision = strategy.evaluate(listing, nft, configWithBudget);

            await this.logActivity(agent.id, 'evaluate', {
                listingId: listing.id,
                nftName: nft.name,
                priceXRS: listing.priceXRS,
                decision: decision.buy ? 'BUY' : 'PASS',
                reason: decision.reason
            });

            if (decision.buy) {
                const success = await this.executeBuy(agent, listing, nft, decision);
                if (success) {
                    bought++;
                    // Update agent's total spent
                    const newSpent = totalSpent + listing.priceXRS;
                    await this.db.agents.update(agent.id, {
                        totalSpent: newSpent,
                        lastActionAt: new Date().toISOString()
                    });
                }
            }
        }

        if (evaluated > 0) {
            console.log(`[AGENT] ${agent.name}: evaluated ${evaluated} listings, bought ${bought}`);
        }
    }

    async executeBuy(agent, listing, nft, decision) {
        try {
            await this.logActivity(agent.id, 'buy_attempt', {
                listingId: listing.id,
                nftId: nft.id,
                nftName: nft.name,
                priceXRS: listing.priceXRS
            });

            // Transfer NFT ownership to agent's owner (agent buys for its owner)
            await this.db.listings.update(listing.id, { status: 'pending' });
            await this.db.transferNFT(listing.nftId, agent.ownerAddress);
            await this.db.completeListing(listing.id);

            // Record the trade
            await this.db.recordTrade({
                listingId: listing.id,
                nftId: listing.nftId,
                buyerAddress: agent.ownerAddress,
                sellerAddress: listing.sellerAddress,
                priceLamports: listing.priceLamports,
                paymentTxSignature: `agent:${agent.id}`
            });

            await this.logActivity(agent.id, 'buy_success', {
                listingId: listing.id,
                nftId: nft.id,
                nftName: nft.name,
                priceXRS: listing.priceXRS
            });

            // If strategy says relist, create a new listing
            if (decision.relistPrice) {
                try {
                    await this.db.createListing({
                        nftId: nft.id,
                        sellerAddress: agent.ownerAddress,
                        priceXRS: decision.relistPrice
                    });
                    await this.logActivity(agent.id, 'relist', {
                        nftId: nft.id,
                        nftName: nft.name,
                        relistPrice: decision.relistPrice
                    });
                } catch (e) {
                    console.error(`[AGENT] Relist failed: ${e.message}`);
                }
            }

            console.log(`[AGENT] ${agent.name} bought "${nft.name}" for ${listing.priceXRS} XRS`);
            return true;
        } catch (e) {
            // Revert listing status on failure
            try { await this.db.listings.update(listing.id, { status: 'active' }); } catch (_) {}
            await this.logActivity(agent.id, 'buy_failed', {
                listingId: listing.id,
                error: e.message
            });
            console.error(`[AGENT] Buy failed: ${e.message}`);
            return false;
        }
    }

    async logActivity(agentId, action, details) {
        try {
            await this.db.agentActivity.create({
                agentId,
                action,
                details: JSON.stringify(details),
                createdAt: new Date().toISOString()
            });
        } catch (e) {
            console.error(`[AGENT] Failed to log activity: ${e.message}`);
        }
    }

    getStrategies() {
        return Object.entries(STRATEGIES).map(([key, s]) => ({
            id: key,
            name: s.name,
            description: s.description
        }));
    }
}

module.exports = { AgentEngine, STRATEGIES };
