# NFT Support on Xeris — Technical Proposal & Findings

**Date:** March 4, 2026
**From:** Xeris Developer Community
**To:** Xeris Core Team

---

## Executive Summary

We want to build an AI-generated NFT minting platform on Xeris — users enter a text prompt, AI generates an image, and it's minted as an NFT on-chain. Through extensive testing, we've confirmed that the existing instruction set cannot support NFTs without either enabling smart contracts for community developers or adding a dedicated NFT instruction variant.

This document presents our findings from live testnet probing, proposes solutions, and demonstrates that we've already built the tooling to ship an NFT platform quickly once the chain-side support is available.

---

## What We Tested

### Environment
- **Node:** 138.197.116.81 (ports 50008 + 56001)
- **Tooling:** Custom Node.js scripts building Solana-compatible signed transactions
- **Wallet:** Generated throwaway Ed25519 keypairs, funded via `/airdrop`

### Tests Performed

#### 1. ContractDeploy (variant 5) — 4 tests
Submitted signed ContractDeploy transactions with different `contract_type_str` values:

| contract_type_str | contract_id | Result |
|---|---|---|
| `"NFT"` | test_nft_1772646873832 | TX accepted (slot 1132839), fee charged, **no contract created** |
| `"Swap"` | test_swap_1772646873832 | TX accepted, fee charged, **no contract created** |
| `"Collection"` | test_col_1772646873832 | TX accepted (slot 1132842), fee charged, **no contract created** |
| `"Marketplace"` | test_mkt_1772646873832 | TX accepted (slot 1132843), fee charged, **no contract created** |

All transactions were confirmed on-chain via `getTransaction` RPC (valid slot, blockTime, fee: 1000000). However, `/contract/{id}` returns `"Contract not found"` for all four. The `/contracts` endpoint still shows only `pool_xrs_usdc`.

**Conclusion:** ContractDeploy transactions are deserialized and included in blocks, but the contract execution/instantiation is silently skipped for non-privileged signers.

#### 2. ContractCall (variant 4) — 6 tests on existing Swap
Called `pool_xrs_usdc` with different method names:

| Method | Result |
|---|---|
| `get_price` | TX accepted, reserves unchanged |
| `get_reserves` | TX accepted, reserves unchanged |
| `swap` | TX accepted, reserves unchanged |
| `info` | TX accepted, reserves unchanged |
| `state` | TX accepted, reserves unchanged |
| `quote` | TX accepted, reserves unchanged |

All accepted on-chain, fees charged, but **zero state changes** to the Swap contract. The reserves remained exactly `a=1773246457071629, b=5741869938` before and after all calls.

**Conclusion:** ContractCall is similarly accepted but not executed for community developers.

#### 3. TokenCreateRWA (variant 6) — 5 tests
Tested different field layouts to discover the schema:

| Test | Fields | Result |
|---|---|---|
| A | Same as TokenCreate fields | TX accepted (slot 1132955), **no token created** |
| B | TokenCreate + description + image_uri + metadata_json | TX accepted (slot 1132955), **no token created** |
| C | TokenCreate + asset_type + status + issuer + description + image_uri + bools | TX accepted (slot 1132956), **no token created** |
| D | TokenCreate + Option<String> fields | TX accepted (slot 1132957), **no token created** |
| E | Just variant + token_id (minimal) | **Rejected:** "Instruction data is not a recognized type" |

Tests A-D passed bincode deserialization (valid structure) but no tokens appeared in `/tokens`. Test E was rejected at deserialization, confirming the node validates bincode structure but silently drops RWA execution.

**Conclusion:** TokenCreateRWA is parsed but not executed for community developers.

#### 4. TokenCreate (variant 3) — 1 test ✅ WORKS
Created a pseudo-NFT token:
```
token_id: AINFT_1772647350888
name: "AI Art Test #1"
symbol: "AINFT"
decimals: 0
max_supply: 1
```

**Result:** Token successfully created at slot 1132958. Visible in `/tokens`, `/v2/tokens`, and `/token/balance/{addr}/{id}` endpoints. This is the **only write instruction that produces state changes** for community developers (along with TokenMint, TokenTransfer, TokenBurn, NativeTransfer, Stake, Unstake).

---

## Why TokenCreate Doesn't Work for NFTs

While TokenCreate with `decimals=0, max_supply=1` technically creates a unique on-chain asset, it has a fundamental problem:

**Every NFT creates a new token entry in every holder's wallet.**

If 1,000 users mint AI art, that's 1,000 new token types on the chain. Every wallet app must load and display all of them. There's no way to distinguish "real" tokens from NFT tokens. The UX becomes unusable quickly.

Additionally:
- No metadata field — image URL, description, creator info must be stored entirely off-chain
- No collection grouping — each NFT is an independent token with no relationship to others
- No royalties or transfer hooks — no way to enforce creator fees on secondary sales
- No marketplace primitive — trading requires trust in a centralized server

---

## What We're Asking For

We see two paths forward. Either would unblock NFT development:

### Path A: Enable ContractDeploy + ContractCall for community developers

The infrastructure clearly exists — the `pool_xrs_usdc` Swap contract is deployed, active, and queryable with full state. The contract runtime works. We just need permission to deploy.

**What we'd build:**
- An NFT contract type with: `mint(to, metadata_uri)`, `transfer(from, to, token_id)`, `burn(token_id)`, `owner_of(token_id)`, `tokens_of(owner)`
- State stored as JSON (same pattern as the Swap contract's state)
- Queryable via existing `/contract/{id}` endpoint

**What we need from the team:**
- Enable ContractDeploy for all signers (or a whitelist we can be added to)
- Confirm supported contract_type_str values (or allow custom types)
- Document the params_json schema for contract initialization
- Confirm ContractCall execution is enabled (method dispatch + state mutation)

### Path B: Add a native NFT instruction variant

Add dedicated NFT instructions to the XerisInstruction enum:

```rust
// New variants (suggested numbering)
NFTCreate    = 13  { collection_id: String, name: String, symbol: String, max_supply: u64, creator: String, royalty_bps: u16, base_uri: String }
NFTMint      = 14  { collection_id: String, to: String, metadata_uri: String }
NFTTransfer  = 15  { collection_id: String, token_id: u64, from: String, to: String }
NFTBurn      = 16  { collection_id: String, token_id: u64, from: String }
```

**Advantages over smart contracts:**
- Native performance, no contract runtime overhead
- First-class wallet support (wallet can distinguish NFTs from tokens)
- Built-in royalty enforcement at the protocol level
- Collection-based grouping (one collection = one wallet entry, not one per NFT)

**New query endpoints needed:**
```
GET /nft/collections                    → list all collections
GET /nft/collection/{id}                → collection info + stats
GET /nft/collection/{id}/tokens         → list tokens in collection
GET /nft/token/{collection}/{token_id}  → token metadata + owner
GET /nft/owner/{address}                → all NFTs owned by address
```

---

## What We've Already Built

We have production-ready infrastructure that can ship an NFT platform within days once chain support is available:

### Existing Xeris Apps (deployed & working)
- **XerisProof** — Document certification via on-chain hashing. Has: user accounts, billing (Stripe), email (Resend), PDF certificates, batch processing, verification flow, admin panel, Postgres/SQLite support, Railway deployment.
- **Xeris.Play** — Casino/lottery with per-bet on-chain signing. Has: wallet integration (`window.xeris`), NativeTransfer flow, transaction verification, server-side signing for payouts.
- **XerisLaunch** — Token launch platform. Has: TokenCreate + TokenMint full pipeline, wallet signing, server proxies.

### Transaction Tooling (proven)
- Full bincode encoder for all instruction variants
- Solana wire format message builder
- Ed25519 signing (both client-side via wallet and server-side via keypair)
- Base58 encoding/decoding
- Blockhash fetching (RPC + REST fallback)
- Transaction submission + confirmation polling
- Server proxy pattern (CORS workaround)

### AI NFT App (ready to build)
- AI image generation (DALL-E / Stable Diffusion API integration)
- IPFS upload for permanent image storage
- Gallery UI for browsing/displaying NFTs
- Marketplace with listings, bidding, and transfers
- Social sharing with OpenGraph image tags

---

## Technical Appendix

### Node Behavior Summary

| Instruction | Deserialized? | Included in Block? | Fee Charged? | State Changed? |
|---|---|---|---|---|
| NativeTransfer (11) | ✅ | ✅ | ✅ | ✅ |
| TokenCreate (3) | ✅ | ✅ | ✅ | ✅ |
| TokenMint (0) | ✅ | ✅ | ✅ | ✅ |
| TokenTransfer (1) | ✅ | ✅ | ✅ | ✅ (custom tokens only) |
| TokenBurn (2) | ✅ | ✅ | ✅ | Presumed ✅ |
| ContractDeploy (5) | ✅ | ✅ | ✅ | ❌ Silent drop |
| ContractCall (4) | ✅ | ✅ | ✅ | ❌ Silent drop |
| TokenCreateRWA (6) | ✅ | ✅ | ✅ | ❌ Silent drop |
| Stake (9) | ✅ | ✅ | ✅ | Presumed ✅ |
| Unstake (10) | ✅ | ✅ | ✅ | Presumed ✅ |

### Existing Contract (proves runtime works)
```json
{
  "contract_id": "pool_xrs_usdc",
  "contract_type": "Swap",
  "created_slot": 1055312,
  "owner": "8evPjjozSHNcoGRcv7zzxwan9sf3ubJ8q9CFzms6AK97",
  "state": {
    "Swap": {
      "fee_bps": 30,
      "reserve_a": 1773246457071629,
      "reserve_b": 5741869938,
      "token_a": "xrs_native",
      "token_b": "xeris_usdc",
      "total_shares": 3162277660168
    }
  }
}
```

### Test Transaction Signatures (verifiable on-chain)
```
ContractDeploy "NFT":         kmVQHqsmGu3W3VDe5Wuw1fivAcXxBxtxXHVKNA58jccZQjLJfhkPnSWvU4o8ULKinkhdXpXa42wUWJH12ZVam8N
ContractDeploy "Swap":        2ttQHpv2Wx7okVw7uowVXsh35nww4WsVktsZZB6ZXN2p3msSnNeyhUCnedYFJWzTCsM75JVNmbwh7vAib37MDnUy
ContractDeploy "Collection":  678ggYv6veZBuwArkgiHmLQ5C6N1Mu5qrFrn5ReG2dr2Y13VocjzBp1cdAAreZFuhmFogCVDGF3BKYD3cwCZUTUh
ContractDeploy "Marketplace": 466EoWk7aPzobtRYcnhacFUt4SvnzrwYjHUg7uaeHMFyzZrmjE3rgP45JruohYnRVfuLyyUEeuiMn18zEkzz9MM7
TokenCreateRWA A:             2JqMgdv5QCV9iVQVpCVHtJaXEZbXP2aWNXaP377Q215VUhXwnbESVaDTRyUNT9yNzRCcmMXbbFrk5G9pgRbuTzqJ
TokenCreateRWA B:             55PoBsbGbYi5TCey3oXrsx5AXeSSh4Eqfv3K34NiiZUfp8kstBje2jPZ1wjBhV2TinrL3Hdg7bwNNAJ28wLXMwGp
TokenCreate (WORKS):          bGLzkmzV6hN96P2ZBkcNhNJwpN4xMRgTGcsUZ9t7XYyqGf1Mhd5mZaFADdA9yFyKq8ePMPWA5PNa3LhFZiBRD6q
```

### Test Wallets
```
ContractDeploy tests: 8JLepeELFA5YPp9yNDUFZQ2bpFizWMxhZwD2ZMQ3PUgQ
RWA + TokenCreate tests: 3pWU9h1DJXgo7auLaKpUmvkuqz6xXT8fpT3qgWmNAW6G
```

---

## Summary

The Xeris chain has the foundation for NFTs — the transaction format, signing, and even a contract runtime (proven by the Swap contract). The missing piece is enabling smart contract deployment for community developers, or adding native NFT instruction variants. Either path would allow us to ship an AI NFT platform that brings new users and real utility to the Xeris ecosystem.

We're ready to build. We just need the chain to meet us halfway.
