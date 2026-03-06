// ============================================
// NFT-FORGE — FRONTEND APP LOGIC
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
        currentView: 'mint'
    };

    // Re-render Lucide icons in dynamic content
    function renderIcons() {
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

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

            // Quick check: is any wallet provider available?
            const provider = XerisDApp.detectProvider();
            if (!provider) {
                setStatus('Waiting for wallet extension...');
                const waited = await XerisDApp.waitForProvider(2000);
                if (!waited) {
                    setStatus('');
                    showWalletNotFound();
                    return;
                }
            }

            const address = await dapp.connect({ onlyIfTrusted: false });

            setStatus('Authenticating...');

            const { challenge } = await api('POST', '/api/auth/challenge', { address });

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
                console.warn('signMessage not supported, using fallback auth');
            }

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

            dapp.on('disconnect', () => {
                disconnectWallet();
            });

            dapp.on('accountChanged', async (newAddr) => {
                showToast('Account changed — reconnecting...', 'info');
                // Clear old auth
                state.token = null;
                state.user = null;
                state.address = newAddr;
                localStorage.removeItem('nft_token');
                localStorage.setItem('nft_address', newAddr);

                // Re-authenticate with new address
                try {
                    const { challenge } = await api('POST', '/api/auth/challenge', { address: newAddr });
                    let sig = 'wallet-browser-auth';
                    try {
                        const signResult = await dapp.signMessage(challenge);
                        if (signResult && signResult.signature) {
                            sig = btoa(String.fromCharCode(...new Uint8Array(signResult.signature)));
                        } else if (typeof signResult === 'string') {
                            sig = signResult;
                        }
                    } catch (_) {}
                    const { token, user } = await api('POST', '/api/auth/connect', { address: newAddr, signature: sig });
                    state.token = token;
                    state.user = user;
                    state.connected = true;
                    localStorage.setItem('nft_token', token);
                } catch (e) {
                    console.warn('Re-auth failed on account change:', e.message);
                    state.connected = false;
                }
                updateUI();
                showView(state.currentView);
            });

            updateUI();
            showToast('Wallet connected!', 'success');
            setStatus('');

            loadBalance();
        } catch (e) {
            setStatus('');
            if (e.message && e.message.includes('wallet not found')) {
                showWalletNotFound();
            } else {
                showToast('Connection failed: ' + e.message, 'error');
            }
        }
    }

    function showWalletNotFound() {
        const modal = document.getElementById('nft-modal');
        const content = document.getElementById('nft-modal-content');
        modal.classList.add('active');
        content.innerHTML = `
            <div style="padding:40px 28px;text-align:center;">
                <div style="width:56px;height:56px;border-radius:50%;background:rgba(79,143,255,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">
                    <i data-lucide="wallet" style="width:28px;height:28px;color:var(--accent);"></i>
                </div>
                <h2 style="margin-bottom:8px;">No Wallet Detected</h2>
                <p style="color:var(--text-secondary);font-size:14px;margin-bottom:24px;">
                    To connect an existing wallet, install the <strong>Xeris Command Center</strong> browser extension.
                </p>
                <div style="display:flex;flex-direction:column;gap:10px;max-width:320px;margin:0 auto;">
                    <button class="btn btn-primary" style="justify-content:center;" onclick="App.closeModal();App.showView('mint');">
                        <i data-lucide="zap" style="width:16px;height:16px;"></i>
                        Create Without Wallet
                    </button>
                    <a href="https://github.com/nickvprince/Xeris-Command-Center/releases" target="_blank" class="btn btn-secondary" style="justify-content:center;text-decoration:none;">
                        <i data-lucide="download" style="width:16px;height:16px;"></i>
                        Get Xeris Command Center
                    </a>
                </div>
            </div>`;
        renderIcons();
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
        showView('mint');
    }

    async function loadBalance() {
        if (!state.connected) return;
        try {
            const lamports = await dapp.getBalance();
            const xrs = (lamports / LAMPORTS_PER_XRS).toFixed(4);
            const balEl = document.getElementById('wallet-balance');
            if (balEl) balEl.textContent = xrs + ' XRS';
        } catch (e) { /* optional */ }
    }

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

            try {
                await dapp.connect({ onlyIfTrusted: true });
            } catch (e) { /* session-only mode */ }

            updateUI();
        } catch (e) {
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

        document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
        const navTab = document.querySelector(`.nav-tab[data-view="${view}"]`);
        if (navTab) navTab.classList.add('active');

        if (view === 'gallery') loadGallery();
        else if (view === 'mint') updateMintButtons();
        else if (view === 'marketplace') loadMarketplace();
        else if (view === 'my-nfts') loadMyNFTs();
    }

    // ─── GALLERY ─────────────────────────────────────────────────────

    async function loadGallery() {
        const grid = document.getElementById('gallery-grid');
        grid.innerHTML = `<div class="loading"><div class="spinner-accent"></div>Loading gallery...</div>`;

        try {
            const data = await api('GET', '/api/nfts?limit=50');
            if (data.items.length === 0) {
                grid.innerHTML = `<div class="empty-state">
                    <i data-lucide="image-plus" class="empty-state-icon"></i>
                    <div>No NFTs yet. Be the first to create one!</div>
                </div>`;
                renderIcons();
                return;
            }
            grid.innerHTML = data.items.map(nft => nftCard(nft)).join('');
            renderIcons();
        } catch (e) {
            grid.innerHTML = `<div class="error">
                <i data-lucide="alert-circle" style="width:24px;height:24px;"></i>
                Failed to load gallery
            </div>`;
            renderIcons();
        }
    }

    function nftCard(nft) {
        const imgSrc = nft.imageUrl || '/api/images/placeholder.svg';
        return `
        <div class="nft-card" onclick="App.showNFTDetail('${nft.id}')">
            <div class="nft-image"><img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(nft.name)}" loading="lazy"/></div>
            <div class="nft-info">
                <div class="nft-name">${escapeHtml(nft.name)}</div>
                <div class="nft-creator">
                    <i data-lucide="user" style="width:11px;height:11px;"></i>
                    ${shortAddr(nft.creatorAddress)}
                </div>
            </div>
        </div>`;
    }

    // ─── NFT DETAIL ──────────────────────────────────────────────────

    async function showNFTDetail(nftId) {
        const modal = document.getElementById('nft-modal');
        const content = document.getElementById('nft-modal-content');
        modal.classList.add('active');
        content.innerHTML = `<div class="loading" style="padding:80px 20px;"><div class="spinner-accent"></div>Loading...</div>`;

        try {
            const [{ nft, collection }, listingData] = await Promise.all([
                api('GET', '/api/nfts/' + nftId),
                api('GET', '/api/listings/by-nft/' + nftId)
            ]);
            const isOwner = state.address && nft.ownerAddress === state.address;
            const activeListing = listingData.listing;

            let actionButtons = '';
            if (isOwner && !activeListing) {
                actionButtons = `<button class="btn btn-primary" onclick="App.showListForm('${nft.id}')"><i data-lucide="tag" style="width:14px;height:14px;"></i> List for Sale</button>`;
            } else if (isOwner && activeListing) {
                actionButtons = `<button class="btn btn-secondary" onclick="App.cancelListing('${activeListing.id}', '${nft.id}')"><i data-lucide="x-circle" style="width:14px;height:14px;"></i> Cancel Listing</button>`;
            } else if (activeListing && state.connected) {
                actionButtons = `<button class="btn btn-buy" onclick="App.buyNFT('${activeListing.id}', ${activeListing.priceLamports})"><i data-lucide="shopping-cart" style="width:14px;height:14px;"></i> Buy for ${activeListing.priceXRS} XRS</button>`;
            }

            content.innerHTML = `
            <div class="detail-image" onclick="event.stopPropagation();App.openLightbox('${escapeHtml(nft.imageUrl)}','${escapeHtml(nft.name)}')"><img src="${escapeHtml(nft.imageUrl)}" alt="${escapeHtml(nft.name)}"/></div>
            <div class="detail-info">
                <h2>${escapeHtml(nft.name)}</h2>
                <div class="detail-meta">
                    <div><i data-lucide="paintbrush" style="width:13px;height:13px;"></i> <strong>Creator:</strong> ${shortAddr(nft.creatorAddress)}</div>
                    <div><i data-lucide="user" style="width:13px;height:13px;"></i> <strong>Owner:</strong> ${shortAddr(nft.ownerAddress)}</div>
                    ${collection ? `<div><i data-lucide="folder" style="width:13px;height:13px;"></i> <strong>Collection:</strong> ${escapeHtml(collection.name)}</div>` : ''}
                    <div><i data-lucide="calendar" style="width:13px;height:13px;"></i> <strong>Minted:</strong> ${new Date(nft.mintedAt).toLocaleDateString()}</div>
                </div>
                <div class="detail-actions">
                    ${actionButtons}
                    ${activeListing ? `<div class="listing-price"><i data-lucide="coins" style="width:16px;height:16px;"></i> ${activeListing.priceXRS} XRS</div>` : ''}
                </div>
                <div id="list-form" class="hidden"></div>
            </div>`;
            renderIcons();
        } catch (e) {
            content.innerHTML = `<div class="error" style="padding:60px 20px;">
                <i data-lucide="alert-circle" style="width:24px;height:24px;"></i>
                Failed to load NFT details
            </div>`;
            renderIcons();
        }
    }

    function closeModal() {
        document.getElementById('nft-modal').classList.remove('active');
    }

    // ─── LIGHTBOX (fullscreen image viewer) ──────────────────────

    function openLightbox(imageUrl, title) {
        const lb = document.getElementById('lightbox');
        const img = document.getElementById('lightbox-img');
        const titleEl = document.getElementById('lightbox-title');
        img.src = imageUrl;
        titleEl.textContent = title || '';
        lb.classList.add('active');
        renderIcons();
    }

    function closeLightbox() {
        document.getElementById('lightbox').classList.remove('active');
    }

    // ─── GENERATION & MINTING ─────────────────────────────────────────

    let _currentGeneration = null; // { generationId, imageUrl }

    async function generateImage() {
        const promptInput = document.getElementById('mint-prompt');
        const prompt = promptInput.value.trim();

        if (prompt.length < 3) {
            showToast('Prompt must be at least 3 characters', 'error');
            return;
        }

        const genBtn = document.getElementById('generate-btn');
        genBtn.disabled = true;
        genBtn.innerHTML = '<span class="spinner"></span> Generating...';
        setStatus('Generating AI image...');

        try {
            const data = await api('POST', '/api/generate', { prompt });

            _currentGeneration = {
                generationId: data.generationId,
                imageUrl: data.imageUrl
            };

            // Show preview with mint/regenerate options
            const preview = document.getElementById('mint-preview');
            if (preview) {
                preview.innerHTML = `
                <div class="mint-result">
                    <img src="${escapeHtml(data.imageUrl)}" alt="AI Generated Preview"/>
                    <p style="color:var(--text-secondary);font-size:13px;margin:8px 0;">Happy with this image?</p>
                    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
                        ${state.connected ? `
                        <button class="btn btn-primary" onclick="App.mintNFT()">
                            <i data-lucide="sparkles" style="width:14px;height:14px;"></i> Save as NFT
                        </button>` : ''}
                        <button class="btn btn-primary btn-quick-mint" onclick="App.guestMint()" ${state.connected ? 'style="display:none;"' : ''}>
                            <i data-lucide="zap" style="width:14px;height:14px;"></i> ${getSavedGuestWallet() ? 'Save as NFT' : 'Save — No Wallet Needed'}
                        </button>
                        <button class="btn btn-secondary" onclick="App.generateImage()">
                            <i data-lucide="refresh-cw" style="width:14px;height:14px;"></i> Regenerate
                        </button>
                    </div>
                </div>`;
                renderIcons();
            }

            showToast('Image generated! Save it or regenerate.', 'success');
        } catch (e) {
            showToast('Generation failed: ' + e.message, 'error');
        } finally {
            genBtn.disabled = false;
            genBtn.innerHTML = '<i data-lucide="wand-2" style="width:16px;height:16px;"></i> Generate';
            renderIcons();
            setStatus('');
        }
    }

    async function mintNFT() {
        if (!state.connected) {
            showToast('Connect wallet first', 'error');
            return;
        }
        if (!_currentGeneration) {
            showToast('Generate an image first', 'error');
            return;
        }

        const nameInput = document.getElementById('mint-name');
        const name = nameInput ? nameInput.value.trim() : '';

        setStatus('Saving NFT...');

        // Show loading state in preview immediately
        const preview = document.getElementById('mint-preview');
        if (preview) {
            preview.innerHTML = `
            <div class="mint-result" style="text-align:center;padding:40px 20px;">
                <div class="spinner-accent" style="margin:0 auto 16px;"></div>
                <p style="color:var(--text-secondary);font-size:14px;">Uploading to IPFS & saving your NFT...</p>
                <p style="color:var(--text-muted);font-size:12px;margin-top:4px;">This may take a few seconds</p>
            </div>`;
        }

        try {
            const data = await api('POST', '/api/mint', {
                generationId: _currentGeneration.generationId,
                name: name || undefined
            });

            _currentGeneration = null;
            showToast('NFT created successfully!', 'success');

            if (preview) {
                preview.innerHTML = `
                <div class="mint-result">
                    <img src="${escapeHtml(data.nft.imageGateway || data.nft.imageUrl)}" alt="${escapeHtml(data.nft.name)}"/>
                    <h3>${escapeHtml(data.nft.name)}</h3>
                    <p><i data-lucide="check-circle" style="width:14px;height:14px;color:#10b981;"></i> Created successfully!</p>
                    <button class="btn btn-secondary" onclick="App.showNFTDetail('${data.nft.id}')">
                        <i data-lucide="eye" style="width:14px;height:14px;"></i> View Details
                    </button>
                </div>`;
                renderIcons();
            }

            document.getElementById('mint-prompt').value = '';
            if (nameInput) nameInput.value = '';
            updateCharCount();
        } catch (e) {
            showToast('Mint failed: ' + e.message, 'error');
        } finally {
            setStatus('');
        }
    }

    // ─── GUEST MINT (no wallet extension) ──────────────────────

    let _guestSeedPhrase = null;

    function getSavedGuestWallet() {
        try {
            const saved = localStorage.getItem('guest_wallet');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return null;
    }

    function saveGuestWallet(address, mnemonic) {
        localStorage.setItem('guest_wallet', JSON.stringify({ address, mnemonic }));
    }

    async function guestMint() {
        if (!_currentGeneration) {
            showToast('Generate an image first', 'error');
            return;
        }

        const nameInput = document.getElementById('mint-name');
        const name = nameInput ? nameInput.value.trim() : '';

        const saved = getSavedGuestWallet();
        const isFirstMint = !saved;

        let walletAddress, mnemonic;

        if (saved) {
            setStatus('Creating NFT...');
            walletAddress = saved.address;
            mnemonic = saved.mnemonic;
        } else {
            setStatus('Creating wallet & NFT...');
            const wallet = await XerisKeygen.createWallet();
            walletAddress = wallet.address;
            mnemonic = wallet.mnemonic;
        }

        // Show loading state in preview immediately
        const preview = document.getElementById('mint-preview');
        if (preview) {
            preview.innerHTML = `
            <div class="mint-result" style="text-align:center;padding:40px 20px;">
                <div class="spinner-accent" style="margin:0 auto 16px;"></div>
                <p style="color:var(--text-secondary);font-size:14px;">Uploading to IPFS & saving your NFT...</p>
                <p style="color:var(--text-muted);font-size:12px;margin-top:4px;">This may take a few seconds</p>
            </div>`;
        }

        try {
            const data = await api('POST', '/api/mint/guest', {
                generationId: _currentGeneration.generationId,
                walletAddress,
                name: name || undefined
            });

            // Save guest wallet for future mints
            if (isFirstMint) {
                saveGuestWallet(walletAddress, mnemonic);
            }

            _currentGeneration = null;
            showToast('NFT created successfully!', 'success');

            if (preview) {
                preview.innerHTML = `
                <div class="mint-result">
                    <img src="${escapeHtml(data.nft.imageGateway || data.nft.imageUrl)}" alt="${escapeHtml(data.nft.name)}"/>
                    <h3>${escapeHtml(data.nft.name)}</h3>
                    <p><i data-lucide="check-circle" style="width:14px;height:14px;color:#10b981;"></i> Created successfully!</p>
                    <p style="font-size:12px;color:var(--text-muted);">Owner: ${shortAddr(walletAddress)}</p>
                    <button class="btn btn-secondary" onclick="App.showNFTDetail('${data.nft.id}')">
                        <i data-lucide="eye" style="width:14px;height:14px;"></i> View Details
                    </button>
                </div>`;
                renderIcons();
            }

            // Only show seed phrase on first mint
            if (isFirstMint) {
                showSeedPhrase(mnemonic, data.nft, walletAddress);
            }

            document.getElementById('mint-prompt').value = '';
            if (nameInput) nameInput.value = '';
            updateCharCount();
        } catch (e) {
            showToast('Guest mint failed: ' + e.message, 'error');
        } finally {
            setStatus('');
        }
    }

    function showSeedPhrase(mnemonic, nft, address) {
        _guestSeedPhrase = mnemonic;

        const words = mnemonic.split(' ');
        const grid = document.getElementById('seed-word-grid');
        grid.innerHTML = words.map((word, i) =>
            `<div class="seed-word">
                <span class="seed-word-num">${i + 1}.</span>
                <span class="seed-word-text">${escapeHtml(word)}</span>
            </div>`
        ).join('');

        const preview = document.getElementById('seed-nft-preview');
        if (nft) {
            preview.innerHTML = `
                <img src="${escapeHtml(nft.imageGateway || nft.imageUrl)}" alt="${escapeHtml(nft.name)}"/>
                <div class="seed-nft-name">${escapeHtml(nft.name)}</div>
                <div class="seed-nft-addr">Wallet: ${address || 'unknown'}</div>
                <p style="font-size:12px;color:var(--text-muted);margin-top:6px;">Import your seed phrase into <strong>Xeris Command Center</strong> to manage your NFTs.</p>`;
        }

        document.getElementById('seed-modal').classList.add('active');
        renderIcons();
    }

    async function copySeedPhrase() {
        if (!_guestSeedPhrase) return;
        try {
            await navigator.clipboard.writeText(_guestSeedPhrase);
            showToast('Seed phrase copied to clipboard', 'success');
        } catch (e) {
            // Fallback: select text
            showToast('Copy failed — please write down the words manually', 'error');
        }
    }

    function closeSeedModal() {
        document.getElementById('seed-modal').classList.remove('active');
        _guestSeedPhrase = null;
    }

    // ─── MARKETPLACE ─────────────────────────────────────────────────

    async function loadMarketplace() {
        const grid = document.getElementById('marketplace-grid');
        grid.innerHTML = `<div class="loading"><div class="spinner-accent"></div>Loading listings...</div>`;

        try {
            const data = await api('GET', '/api/listings?limit=50');
            if (data.items.length === 0) {
                grid.innerHTML = `<div class="empty-state">
                    <i data-lucide="store" class="empty-state-icon"></i>
                    <div>No active listings. Create an NFT and list it!</div>
                </div>`;
                renderIcons();
                return;
            }
            grid.innerHTML = data.items.map(listing => listingCard(listing)).join('');
            renderIcons();
        } catch (e) {
            grid.innerHTML = `<div class="error">
                <i data-lucide="alert-circle" style="width:24px;height:24px;"></i>
                Failed to load marketplace
            </div>`;
            renderIcons();
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
                <div class="listing-price">
                    <i data-lucide="coins" style="width:14px;height:14px;"></i>
                    ${listing.priceXRS} XRS
                </div>
                <div class="nft-creator">
                    <i data-lucide="user" style="width:11px;height:11px;"></i>
                    ${shortAddr(listing.sellerAddress)}
                </div>
            </div>
        </div>`;
    }

    // ─── MY NFTs ─────────────────────────────────────────────────────

    async function loadMyNFTs() {
        const guestWallet = getSavedGuestWallet();
        const ownerAddress = state.connected ? state.address : (guestWallet ? guestWallet.address : null);

        if (!ownerAddress) {
            const grid = document.getElementById('my-nfts-grid');
            grid.innerHTML = `<div class="empty-state">
                <i data-lucide="wallet" class="empty-state-icon"></i>
                <div>Connect wallet or create an NFT to see your collection</div>
            </div>`;
            renderIcons();
            return;
        }

        const grid = document.getElementById('my-nfts-grid');
        grid.innerHTML = `<div class="loading"><div class="spinner-accent"></div>Loading your NFTs...</div>`;

        try {
            const data = await api('GET', '/api/nfts/owner/' + ownerAddress);
            if (data.items.length === 0) {
                grid.innerHTML = `<div class="empty-state">
                    <i data-lucide="image-plus" class="empty-state-icon"></i>
                    <div>You don't own any NFTs yet. Go create one!</div>
                </div>`;
                renderIcons();
                return;
            }
            grid.innerHTML = data.items.map(nft => nftCard(nft)).join('');
            renderIcons();
        } catch (e) {
            grid.innerHTML = `<div class="error">
                <i data-lucide="alert-circle" style="width:24px;height:24px;"></i>
                Failed to load your NFTs
            </div>`;
            renderIcons();
        }
    }

    // ─── LISTING / BUYING ────────────────────────────────────────────

    function showListForm(nftId) {
        const form = document.getElementById('list-form');
        form.classList.remove('hidden');
        form.innerHTML = `
        <div class="list-form-inner">
            <h4><i data-lucide="tag" style="width:16px;height:16px;color:var(--accent);"></i> List for Sale</h4>
            <input type="number" id="list-price" placeholder="Price in XRS" min="0.001" step="0.001"/>
            <button class="btn btn-primary" onclick="App.createListing('${nftId}')">
                <i data-lucide="check" style="width:14px;height:14px;"></i> Confirm Listing
            </button>
        </div>`;
        renderIcons();
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

    async function cancelListing(listingId, nftId) {
        if (!confirm('Cancel this listing?')) return;
        try {
            await api('DELETE', '/api/listings/' + listingId);
            showToast('Listing cancelled', 'success');
            closeModal();
            if (nftId) showNFTDetail(nftId);
        } catch (e) {
            showToast('Cancel failed: ' + e.message, 'error');
        }
    }

    async function buyNFT(listingId, priceLamports) {
        if (!state.connected) {
            showToast('Connect wallet first', 'error');
            return;
        }

        const priceXRS = priceLamports / LAMPORTS_PER_XRS;
        if (!confirm('Buy this NFT for ' + priceXRS + ' XRS?')) return;

        setStatus('Checking balance...');

        try {
            // Check buyer has enough balance before attempting payment
            const balanceData = await api('GET', '/api/chain/balance/' + state.address);
            const balanceLamports = balanceData.balance || 0;
            if (balanceLamports < priceLamports) {
                const have = (balanceLamports / LAMPORTS_PER_XRS).toFixed(2);
                showToast(`Insufficient balance. You have ${have} XRS but need ${priceXRS} XRS.`, 'error');
                return;
            }

            const stats = await api('GET', '/api/stats');
            const escrowAddress = stats.escrowAddress;

            setStatus('Please approve transaction in wallet...');
            const result = await dapp.transferXrs(escrowAddress, priceXRS);

            setStatus('Verifying payment...');
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
            // Show My NFTs tab for guest users with a saved wallet
            const guestWallet = getSavedGuestWallet();
            authActions.forEach(el => {
                if (guestWallet && el.dataset.view === 'my-nfts') {
                    el.classList.remove('hidden');
                } else {
                    el.classList.add('hidden');
                }
            });
        }

        updateMintButtons();
    }

    function updateMintButtons() {
        // Generate button is always visible — mint/guest-mint appear in preview after generation
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

        const iconMap = { success: 'check-circle', error: 'alert-circle', info: 'info' };
        toast.innerHTML = `<i data-lucide="${iconMap[type] || 'info'}" style="width:18px;height:18px;flex-shrink:0;"></i> ${escapeHtml(msg)}`;
        container.appendChild(toast);
        renderIcons();

        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    function setStatus(msg) {
        const el = document.getElementById('status-bar');
        if (!el) return;
        if (msg) {
            el.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> ${escapeHtml(msg)}`;
        } else {
            el.innerHTML = '';
        }
    }

    function updateCharCount() {
        const prompt = document.getElementById('mint-prompt');
        const counter = document.getElementById('prompt-chars');
        if (prompt && counter) counter.textContent = prompt.value.length;
    }

    // ─── INIT ────────────────────────────────────────────────────────

    async function init() {
        // Nav tabs
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => showView(tab.dataset.view));
        });

        // Escape closes modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeLightbox();
                closeModal();
                closeSeedModal();
            }
        });

        // Character counter for prompt
        const promptEl = document.getElementById('mint-prompt');
        if (promptEl) {
            promptEl.addEventListener('input', updateCharCount);
        }

        // Restore session
        await tryRestore();
        updateUI();

        // Load initial view — open the creator
        showView('mint');

        // Load platform stats with icons
        try {
            const stats = await api('GET', '/api/stats');
            const el = document.getElementById('platform-stats');
            if (el) {
                el.innerHTML = `
                    <div class="stat-item">
                        <i data-lucide="image" style="width:14px;height:14px;"></i>
                        <span class="stat-value">${stats.totalNFTs}</span> NFTs
                    </div>
                    <div class="stat-item">
                        <i data-lucide="users" style="width:14px;height:14px;"></i>
                        <span class="stat-value">${stats.totalUsers}</span> Users
                    </div>
                    <div class="stat-item">
                        <i data-lucide="store" style="width:14px;height:14px;"></i>
                        <span class="stat-value">${stats.totalListings}</span> Listed
                    </div>
                    <div class="stat-item">
                        <i data-lucide="cpu" style="width:14px;height:14px;"></i>
                        AI Powered
                    </div>`;
                renderIcons();
            }
        } catch (e) {}
    }

    return {
        init,
        connectWallet,
        disconnectWallet,
        showView,
        generateImage,
        mintNFT,
        guestMint,
        showSeedPhrase,
        copySeedPhrase,
        closeSeedModal,
        showNFTDetail,
        closeModal,
        openLightbox,
        closeLightbox,
        showListForm,
        createListing,
        cancelListing,
        buyNFT,
        loadGallery,
        loadMarketplace,
        loadMyNFTs
    };
})();

document.addEventListener('DOMContentLoaded', App.init);
