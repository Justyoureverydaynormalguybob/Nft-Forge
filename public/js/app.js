// ============================================
// NFT-XERIS — FRONTEND APP LOGIC
// Uses XerisDApp from xeris-sdk for wallet connect
// ============================================

const App = (() => {
    // Initialize XerisDApp (from xeris-sdk)
    const dapp = XerisDApp.testnet();

    let state = {
        connected: false,
        address: null,
        token: null,
        user: null,
        currentView: 'gallery'
    };

    // ─── API HELPERS ─────────────────────────────────────────────────

    function apiHeaders() {
        const h = { 'Content-Type': 'application/json' };
        if (state.token) h['Authorization'] = 'Bearer ' + state.token;
        return h;
    }

    async function api(method, path, body) {
        const opts = { method, headers: apiHeaders() };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(path, opts);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'API error');
        return data;
    }

    // ─── WALLET CONNECTION (via XerisDApp SDK) ────────────────────────

    async function connectWallet() {
        try {
            setStatus('Detecting wallet...');

            // Use XerisDApp.connect() — handles provider detection,
            // wallet popup, and event subscriptions automatically
            const address = await dapp.connect({ onlyIfTrusted: false });

            setStatus('Authenticating...');

            // Get challenge from server
            const { challenge } = await api('POST', '/api/auth/challenge', { address });

            // Sign the challenge with the wallet for proper auth
            let signature = 'wallet-browser-auth';
            try {
                const signResult = await dapp.signMessage(challenge);
                if (signResult && signResult.signature) {
                    const sigBytes = new Uint8Array(signResult.signature);
                    signature = btoa(String.fromCharCode(...sigBytes));
                } else if (typeof signResult === 'string') {
                    signature = signResult;
                }
            } catch (e) {
                // Wallet may not support signMessage — fall back to simple auth
                console.warn('signMessage not supported, using fallback auth');
            }

            // Authenticate with server
            const { token, user } = await api('POST', '/api/auth/connect', {
                address,
                signature
            });

            state.connected = true;
            state.address = address;
            state.token = token;
            state.user = user;

            localStorage.setItem('nft_token', token);
            localStorage.setItem('nft_address', address);

            // Listen for SDK disconnect/account change events
            dapp.on('disconnect', () => {
                disconnectWallet();
            });

            dapp.on('accountChanged', (newAddr) => {
                showToast('Account changed — reconnecting...', 'info');
                state.address = newAddr;
                localStorage.setItem('nft_address', newAddr);
                updateUI();
                showView(state.currentView);
            });

            updateUI();
            showToast('Wallet connected!', 'success');
            setStatus('');

            // Load balance in background
            loadBalance();
        } catch (e) {
            showToast('Connection failed: ' + e.message, 'error');
            setStatus('');
        }
    }

    async function disconnectWallet() {
        await dapp.disconnect();
        state.connected = false;
        state.address = null;
        state.token = null;
        state.user = null;
        localStorage.removeItem('nft_token');
        localStorage.removeItem('nft_address');
        updateUI();
        showView('gallery');
    }

    // Load and display wallet balance
    async function loadBalance() {
        if (!state.connected) return;
        try {
            const lamports = await dapp.getBalance();
            const xrs = (lamports / LAMPORTS_PER_XRS).toFixed(4);
            const balEl = document.getElementById('wallet-balance');
            if (balEl) balEl.textContent = xrs + ' XRS';
        } catch (e) {
            // Balance display is optional
        }
    }

    // Try to restore session from localStorage
    async function tryRestore() {
        const token = localStorage.getItem('nft_token');
        const address = localStorage.getItem('nft_address');
        if (!token || !address) return;

        state.token = token;
        state.address = address;

        try {
            const { user } = await api('GET', '/api/auth/me');
            state.connected = true;
            state.user = user;

            // Try to reconnect wallet provider silently
            try {
                await dapp.connect({ onlyIfTrusted: true });
            } catch (e) {
                // Provider not available — session-only mode
            }

            updateUI();
        } catch (e) {
            // Token expired
            localStorage.removeItem('nft_token');
            localStorage.removeItem('nft_address');
            state.token = null;
            state.address = null;
        }
    }

    // ─── VIEWS ───────────────────────────────────────────────────────

    function showView(view) {
        state.currentView = view;
        document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
        const target = document.getElementById('view-' + view);
        if (target) target.classList.add('active');

        // Update nav
        document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
        const navTab = document.querySelector(`.nav-tab[data-view="${view}"]`);
        if (navTab) navTab.classList.add('active');

        // Load view data
        if (view === 'gallery') loadGallery();
        else if (view === 'marketplace') loadMarketplace();
        else if (view === 'my-nfts') loadMyNFTs();
    }

    // ─── GALLERY ─────────────────────────────────────────────────────

    async function loadGallery() {
        const grid = document.getElementById('gallery-grid');
        grid.innerHTML = '<div class="loading">Loading...</div>';

        try {
            const data = await api('GET', '/api/nfts?limit=50');
            if (data.items.length === 0) {
                grid.innerHTML = '<div class="empty-state">No NFTs yet. Be the first to mint!</div>';
                return;
            }
            grid.innerHTML = data.items.map(nft => nftCard(nft)).join('');
        } catch (e) {
            grid.innerHTML = '<div class="error">Failed to load gallery</div>';
        }
    }

    function nftCard(nft) {
        const imgSrc = nft.imageUrl || '/api/images/placeholder.svg';
        return `
        <div class="nft-card" onclick="App.showNFTDetail('${nft.id}')">
            <div class="nft-image"><img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(nft.name)}" loading="lazy"/></div>
            <div class="nft-info">
                <div class="nft-name">${escapeHtml(nft.name)}</div>
                <div class="nft-creator">${shortAddr(nft.creatorAddress)}</div>
                ${nft.mintTxSignature ? '<span class="badge on-chain">On-Chain</span>' : '<span class="badge off-chain">Off-Chain</span>'}
            </div>
        </div>`;
    }

    // ─── NFT DETAIL ──────────────────────────────────────────────────

    async function showNFTDetail(nftId) {
        const modal = document.getElementById('nft-modal');
        const content = document.getElementById('nft-modal-content');
        modal.classList.add('active');

        try {
            const { nft, collection } = await api('GET', '/api/nfts/' + nftId);
            const isOwner = state.address && nft.ownerAddress === state.address;

            // Check if listed
            const listings = await api('GET', '/api/listings?limit=100');
            const activeListing = listings.items.find(l => l.nftId === nftId);

            content.innerHTML = `
            <div class="detail-image"><img src="${escapeHtml(nft.imageUrl)}" alt="${escapeHtml(nft.name)}"/></div>
            <div class="detail-info">
                <h2>${escapeHtml(nft.name)}</h2>
                <p class="prompt-text">"${escapeHtml(nft.promptText)}"</p>
                <div class="detail-meta">
                    <div><strong>Creator:</strong> ${shortAddr(nft.creatorAddress)}</div>
                    <div><strong>Owner:</strong> ${shortAddr(nft.ownerAddress)}</div>
                    ${collection ? `<div><strong>Collection:</strong> ${escapeHtml(collection.name)}</div>` : ''}
                    <div><strong>Minted:</strong> ${new Date(nft.mintedAt).toLocaleDateString()}</div>
                    ${nft.mintTxSignature ? `<div><strong>TX:</strong> <a href="https://xeris-explorer.vercel.app/" target="_blank">${nft.mintTxSignature.substring(0, 16)}...</a></div>` : ''}
                    ${nft.certAddress ? `<div><strong>Cert:</strong> ${shortAddr(nft.certAddress)}</div>` : ''}
                </div>
                <div class="detail-actions">
                    ${isOwner && !activeListing ? `<button class="btn btn-primary" onclick="App.showListForm('${nft.id}')">List for Sale</button>` : ''}
                    ${activeListing && !isOwner && state.connected ? `<button class="btn btn-buy" onclick="App.buyNFT('${activeListing.id}', ${activeListing.priceLamports})">Buy for ${activeListing.priceXRS} XRS</button>` : ''}
                    ${activeListing ? `<div class="listing-price">${activeListing.priceXRS} XRS</div>` : ''}
                    <button class="btn btn-secondary" onclick="App.verifyNFT('${nft.id}')">Verify On-Chain</button>
                </div>
                <div id="verify-result"></div>
                <div id="list-form" class="hidden"></div>
            </div>`;
        } catch (e) {
            content.innerHTML = '<div class="error">Failed to load NFT details</div>';
        }
    }

    function closeModal() {
        document.getElementById('nft-modal').classList.remove('active');
    }

    // ─── MINTING ─────────────────────────────────────────────────────

    async function mintNFT() {
        if (!state.connected) {
            showToast('Connect wallet first', 'error');
            return;
        }

        const promptInput = document.getElementById('mint-prompt');
        const nameInput = document.getElementById('mint-name');
        const prompt = promptInput.value.trim();
        const name = nameInput ? nameInput.value.trim() : '';

        if (prompt.length < 3) {
            showToast('Prompt must be at least 3 characters', 'error');
            return;
        }

        const mintBtn = document.getElementById('mint-btn');
        mintBtn.disabled = true;
        mintBtn.innerHTML = '<span class="spinner"></span> Minting...';
        setStatus('Generating AI image & minting on-chain...');

        try {
            const data = await api('POST', '/api/mint', { prompt, name: name || undefined });

            showToast('NFT minted successfully!', 'success');

            // Show preview
            const preview = document.getElementById('mint-preview');
            if (preview) {
                preview.innerHTML = `
                <div class="mint-result">
                    <img src="${escapeHtml(data.nft.imageGateway || data.nft.imageUrl)}" alt="${escapeHtml(data.nft.name)}"/>
                    <h3>${escapeHtml(data.nft.name)}</h3>
                    <p>${data.nft.onChain ? 'On-chain proof recorded!' : 'Minted (off-chain)'}</p>
                    <button class="btn btn-secondary" onclick="App.showNFTDetail('${data.nft.id}')">View Details</button>
                </div>`;
            }

            promptInput.value = '';
            if (nameInput) nameInput.value = '';
        } catch (e) {
            showToast('Mint failed: ' + e.message, 'error');
        } finally {
            mintBtn.disabled = false;
            mintBtn.innerHTML = '<i data-lucide="sparkles" style="width:16px;height:16px;"></i> Mint NFT';
            if (typeof lucide !== 'undefined') lucide.createIcons();
            setStatus('');
        }
    }

    // ─── MARKETPLACE ─────────────────────────────────────────────────

    async function loadMarketplace() {
        const grid = document.getElementById('marketplace-grid');
        grid.innerHTML = '<div class="loading">Loading listings...</div>';

        try {
            const data = await api('GET', '/api/listings?limit=50');
            if (data.items.length === 0) {
                grid.innerHTML = '<div class="empty-state">No active listings. Mint an NFT and list it!</div>';
                return;
            }
            grid.innerHTML = data.items.map(listing => listingCard(listing)).join('');
        } catch (e) {
            grid.innerHTML = '<div class="error">Failed to load marketplace</div>';
        }
    }

    function listingCard(listing) {
        const nft = listing.nft;
        if (!nft) return '';
        return `
        <div class="nft-card listing-card" onclick="App.showNFTDetail('${nft.id}')">
            <div class="nft-image"><img src="${escapeHtml(nft.imageUrl)}" alt="${escapeHtml(nft.name)}" loading="lazy"/></div>
            <div class="nft-info">
                <div class="nft-name">${escapeHtml(nft.name)}</div>
                <div class="listing-price">${listing.priceXRS} XRS</div>
                <div class="nft-creator">Seller: ${shortAddr(listing.sellerAddress)}</div>
            </div>
        </div>`;
    }

    // ─── MY NFTs ─────────────────────────────────────────────────────

    async function loadMyNFTs() {
        if (!state.connected) {
            document.getElementById('my-nfts-grid').innerHTML =
                '<div class="empty-state">Connect wallet to see your NFTs</div>';
            return;
        }

        const grid = document.getElementById('my-nfts-grid');
        grid.innerHTML = '<div class="loading">Loading your NFTs...</div>';

        try {
            const data = await api('GET', '/api/nfts/owner/' + state.address);
            if (data.items.length === 0) {
                grid.innerHTML = '<div class="empty-state">You don\'t own any NFTs yet. Go mint one!</div>';
                return;
            }
            grid.innerHTML = data.items.map(nft => nftCard(nft)).join('');
        } catch (e) {
            grid.innerHTML = '<div class="error">Failed to load your NFTs</div>';
        }
    }

    // ─── LISTING / BUYING ────────────────────────────────────────────

    function showListForm(nftId) {
        const form = document.getElementById('list-form');
        form.classList.remove('hidden');
        form.innerHTML = `
        <div class="list-form-inner">
            <h4>List for Sale</h4>
            <input type="number" id="list-price" placeholder="Price in XRS" min="0.001" step="0.001"/>
            <button class="btn btn-primary" onclick="App.createListing('${nftId}')">Confirm Listing</button>
        </div>`;
    }

    async function createListing(nftId) {
        const priceInput = document.getElementById('list-price');
        const price = parseFloat(priceInput.value);
        if (!price || price <= 0) {
            showToast('Enter a valid price', 'error');
            return;
        }

        try {
            await api('POST', '/api/listings', { nftId, priceXRS: price });
            showToast('NFT listed for ' + price + ' XRS!', 'success');
            closeModal();
            loadMarketplace();
        } catch (e) {
            showToast('Listing failed: ' + e.message, 'error');
        }
    }

    async function buyNFT(listingId, priceLamports) {
        if (!state.connected) {
            showToast('Connect wallet first', 'error');
            return;
        }

        if (!confirm('Buy this NFT for ' + (priceLamports / LAMPORTS_PER_XRS) + ' XRS?')) return;

        setStatus('Building payment transaction...');

        try {
            // Get escrow address from server
            const stats = await api('GET', '/api/stats');
            const escrowAddress = stats.escrowAddress;

            // Use XerisDApp to transfer XRS to escrow
            setStatus('Please approve transaction in wallet...');
            const result = await dapp.transferXrs(escrowAddress, priceLamports / LAMPORTS_PER_XRS);

            // Submit buy order with the tx signature
            setStatus('Confirming purchase...');
            const buyResult = await api('POST', '/api/listings/' + listingId + '/buy', {
                txSignature: result.signature
            });

            showToast('NFT purchased successfully!', 'success');
            closeModal();
            loadMyNFTs();
            loadBalance();
        } catch (e) {
            showToast('Purchase failed: ' + e.message, 'error');
        } finally {
            setStatus('');
        }
    }

    // ─── VERIFY ──────────────────────────────────────────────────────

    async function verifyNFT(nftId) {
        const el = document.getElementById('verify-result');
        el.innerHTML = '<div class="loading">Verifying on-chain...</div>';

        try {
            const data = await api('GET', '/api/verify/' + nftId);
            el.innerHTML = `
            <div class="verify-box ${data.onChain ? 'verified' : 'unverified'}">
                <strong>${data.onChain ? 'Verified On-Chain' : 'Not Found On-Chain'}</strong>
                ${data.certAddress ? `<div>Cert Address: ${shortAddr(data.certAddress)}</div>` : ''}
                ${data.proofHash ? `<div>Proof Hash: ${data.proofHash.substring(0, 24)}...</div>` : ''}
                ${data.balance > 0 ? `<div>Cert Balance: ${data.balance} lamports</div>` : ''}
            </div>`;
        } catch (e) {
            el.innerHTML = '<div class="error">Verification failed</div>';
        }
    }

    // ─── UI HELPERS ──────────────────────────────────────────────────

    function updateUI() {
        const connectBtn = document.getElementById('connect-btn');
        const userInfo = document.getElementById('user-info');
        const authActions = document.querySelectorAll('.auth-required');

        if (state.connected) {
            connectBtn.classList.add('hidden');
            userInfo.classList.remove('hidden');
            userInfo.innerHTML = `
                <span class="wallet-addr">${shortAddr(state.address)}</span>
                <span id="wallet-balance" class="wallet-balance"></span>
                <button class="btn btn-small" onclick="App.disconnectWallet()">Disconnect</button>`;
            authActions.forEach(el => el.classList.remove('hidden'));
            loadBalance();
        } else {
            connectBtn.classList.remove('hidden');
            userInfo.classList.add('hidden');
            authActions.forEach(el => el.classList.add('hidden'));
        }
    }

    function shortAddr(addr) {
        if (!addr) return '???';
        return addr.substring(0, 6) + '...' + addr.substring(addr.length - 4);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showToast(msg, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.textContent = msg;
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function setStatus(msg) {
        const el = document.getElementById('status-bar');
        if (el) el.textContent = msg;
    }

    // ─── INIT ────────────────────────────────────────────────────────

    async function init() {
        // Nav tabs
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => showView(tab.dataset.view));
        });

        // Keyboard shortcut: Escape closes modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });

        // Restore session
        await tryRestore();
        updateUI();

        // Load initial view
        showView('gallery');

        // Load platform stats
        try {
            const stats = await api('GET', '/api/stats');
            const el = document.getElementById('platform-stats');
            if (el) {
                el.innerHTML = `${stats.totalNFTs} NFTs &middot; ${stats.totalUsers} Users &middot; ${stats.totalListings} Listed`;
            }
        } catch (e) {}
    }

    return {
        init,
        connectWallet,
        disconnectWallet,
        showView,
        mintNFT,
        showNFTDetail,
        closeModal,
        showListForm,
        createListing,
        buyNFT,
        verifyNFT,
        loadGallery,
        loadMarketplace,
        loadMyNFTs
    };
})();

document.addEventListener('DOMContentLoaded', App.init);
