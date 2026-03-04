#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Test TokenCreateRWA (variant 6) + ContractCall on Xeris
// Also re-check if any of the previous ContractDeploys actually worked
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const crypto = require('crypto');

const REST = 'http://138.197.116.81:56001';
const RPC = 'http://138.197.116.81:50008';

// ─── HTTP / Base58 / Bincode (same as before) ────────────────

function httpReq(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const bodyStr = opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
      timeout: opts.timeout || 20000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch(e) {} resolve({ status: res.statusCode, data, json }); });
    });
    req.on('error', e => resolve({ status: 0, data: e.message, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: 'TIMEOUT', json: null }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function rpcCall(method, params = []) {
  return httpReq(RPC, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
}

const BASE58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!bytes.length) return '';
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const size = Math.ceil((bytes.length - zeros) * 138 / 100) + 1;
  const b58 = new Uint8Array(size); let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i], j = 0;
    for (let k = size - 1; k >= 0; k--, j++) { if (carry === 0 && j >= length) break; carry += 256 * b58[k]; b58[k] = carry % 58; carry = Math.floor(carry / 58); }
    length = j;
  }
  let result = '1'.repeat(zeros);
  for (let i = size - length; i < size; i++) result += BASE58_ALPHA[b58[i]];
  return result;
}

function u32LE(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
function u64LE(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function encStr(s) { const e = Buffer.from(s, 'utf8'); return Buffer.concat([u64LE(e.length), e]); }
function encBool(v) { return Buffer.from([v ? 1 : 0]); }
function encOptionStr(s) {
  if (s === null || s === undefined) return Buffer.from([0]); // None
  return Buffer.concat([Buffer.from([1]), encStr(s)]); // Some(String)
}
function concat(arrays) { return Buffer.concat(arrays); }

function compactU16(value) {
  const out = []; let v = value;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>= 7; }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

function buildMessage(signerPubkey32, instructionData, blockhash32) {
  const programId = Buffer.alloc(32);
  return concat([Buffer.from([1, 0, 1]), compactU16(2), signerPubkey32, programId, blockhash32,
    compactU16(1), Buffer.from([1]), compactU16(1), Buffer.from([0]),
    compactU16(instructionData.length), instructionData]);
}

function buildSignedTx(signature64, messageBytes) {
  return concat([compactU16(1), signature64, messageBytes]);
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  return { publicKey: pubRaw, address: base58Encode(pubRaw), _privKey: privateKey };
}

function signMsg(messageBytes, kp) {
  return crypto.sign(null, messageBytes, kp._privKey);
}

async function submitTx(kp, instructionData, blockhash32) {
  const pubkey32 = kp.publicKey.length === 32 ? kp.publicKey : (() => {
    const p = Buffer.alloc(32); p.set(kp.publicKey, 32 - kp.publicKey.length); return p;
  })();
  const msg = buildMessage(pubkey32, instructionData, blockhash32);
  const sig = signMsg(msg, kp);
  const tx = buildSignedTx(sig, msg);
  const tx_base64 = tx.toString('base64');
  const sigB58 = base58Encode(sig);

  const resp = await httpReq(`${REST}/submit`, { method: 'POST', body: { tx_base64 } });
  return { resp, sigB58, tx_base64 };
}

async function getBlockhash() {
  const r = await rpcCall('getRecentBlockhash');
  const hex = r.json?.result?.value?.blockhash;
  return hex ? Buffer.from(hex, 'hex') : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  XERIS RWA + CONTRACT DEEP TEST');
  console.log('═══════════════════════════════════════════════\n');

  const kp = generateKeypair();
  console.log(`[1] Keypair: ${kp.address}\n`);

  // Faucet
  console.log('[2] Faucet...');
  await httpReq(`${REST}/airdrop/${kp.address}/10`);
  await sleep(12000); // wait for rate limit
  await httpReq(`${REST}/airdrop/${kp.address}/10`);
  await sleep(3000);

  const bal = await rpcCall('getBalance', [kp.address]);
  console.log(`    Balance: ${(bal.json?.result?.value || 0) / 1e9} XRS\n`);

  let bh = await getBlockhash();

  // ═══════════════════════════════════════════════════════
  // TEST 1: TokenCreateRWA — try different field layouts
  // ═══════════════════════════════════════════════════════
  console.log('═══ TEST 1: TokenCreateRWA (variant 6) — Multiple field guesses ═══\n');

  // The migration guide says variant 6 = TokenCreateRWA with "many fields — see Dart encoder"
  // Existing tokens show fields: token_id, name, symbol, decimals, max_supply, current_supply,
  //                               mint_authority, created_slot, rwa_metadata
  // RWA likely adds: description, asset_type, issuer, document_uri, metadata_json, etc.

  const rwaTests = [
    {
      label: 'A: Same as TokenCreate (variant 3 fields) but with variant 6',
      data: concat([
        u32LE(6), encStr('rwa_test_a'), encStr('RWA Test A'), encStr('RWAA'),
        Buffer.from([0]),  // decimals=0
        u64LE(1),          // max_supply=1
        encStr(kp.address) // mint_authority
      ])
    },
    {
      label: 'B: TokenCreate fields + extra strings (description, image, metadata)',
      data: concat([
        u32LE(6), encStr('rwa_test_b'), encStr('RWA Test B'), encStr('RWAB'),
        Buffer.from([0]), u64LE(1), encStr(kp.address),
        encStr('A test RWA NFT'),                    // description
        encStr('https://example.com/img.png'),       // image_uri
        encStr('{"type":"art","artist":"AI"}'),       // metadata_json
      ])
    },
    {
      label: 'C: TokenCreate + asset_type + status + various RWA fields',
      data: concat([
        u32LE(6), encStr('rwa_test_c'), encStr('RWA Test C'), encStr('RWAC'),
        Buffer.from([0]), u64LE(1), encStr(kp.address),
        encStr('art'),                               // asset_type
        encStr('active'),                            // status
        encStr('AI Generator'),                      // issuer
        encStr('A test NFT'),                        // description
        encStr('https://example.com/img.png'),       // image_uri
        encStr(''),                                  // document_uri
        encBool(true),                               // transferable
        encBool(false),                              // divisible
      ])
    },
    {
      label: 'D: TokenCreate + Option<String> fields for metadata',
      data: concat([
        u32LE(6), encStr('rwa_test_d'), encStr('RWA Test D'), encStr('RWAD'),
        Buffer.from([0]), u64LE(1), encStr(kp.address),
        encOptionStr('art'),                         // asset_type?
        encOptionStr('A test NFT'),                  // description?
        encOptionStr('https://example.com/img.png'), // image_uri?
        encOptionStr(null),                          // document_uri?
        encOptionStr(JSON.stringify({type:'nft'})),   // metadata_json?
      ])
    },
    {
      label: 'E: Minimal — just variant + token_id (to see what error says)',
      data: concat([
        u32LE(6), encStr('rwa_test_e')
      ])
    },
  ];

  for (const test of rwaTests) {
    bh = await getBlockhash();
    console.log(`${test.label} (${test.data.length} bytes)`);
    const { resp, sigB58 } = await submitTx(kp, test.data, bh);
    console.log(`  ⇒ [${resp.status}] ${resp.data.slice(0, 400)}`);

    if (resp.json?.status === 'ok') {
      console.log(`  ✅ ACCEPTED! Sig: ${sigB58.slice(0, 30)}...`);
      await sleep(3000);
      // Check tokens
      const tokResp = await httpReq(`${REST}/tokens`);
      try {
        const tokens = JSON.parse(tokResp.data);
        const ours = tokens.filter(t => t.mint_authority === kp.address);
        if (ours.length > 0) {
          console.log(`  Found ${ours.length} token(s) we created:`);
          ours.forEach(t => console.log(`    ${JSON.stringify(t)}`));
        } else {
          console.log('  Token NOT in /tokens list (silently dropped during execution)');
        }
      } catch(e) { console.log('  Token list parse error'); }

      // Verify on-chain
      const txCheck = await rpcCall('getTransaction', [sigB58]);
      if (txCheck.json?.result?.slot) {
        console.log(`  On-chain: slot ${txCheck.json.result.slot}, fee ${txCheck.json.result.meta?.fee}`);
      }
    } else {
      console.log(`  ❌ REJECTED`);
    }
    console.log('');
    await sleep(1000);
  }

  // ═══════════════════════════════════════════════════════
  // TEST 2: Regular TokenCreate with decimals=0, supply=1 (NFT-like)
  // Then check if it actually shows in wallet / tokens list
  // ═══════════════════════════════════════════════════════
  console.log('═══ TEST 2: TokenCreate (variant 3) as pseudo-NFT ═══\n');

  bh = await getBlockhash();
  const nftTokenId = 'AINFT_' + Date.now();
  const tokenCreateInstr = concat([
    u32LE(3),
    encStr(nftTokenId),
    encStr('AI Art Test #1'),
    encStr('AINFT'),
    Buffer.from([0]),    // decimals = 0
    u64LE(1),            // max_supply = 1
    encStr(kp.address)   // mint_authority
  ]);

  console.log(`Creating token: ${nftTokenId} (decimals=0, supply=1)`);
  const { resp: createResp, sigB58: createSig } = await submitTx(kp, tokenCreateInstr, bh);
  console.log(`  ⇒ [${createResp.status}] ${createResp.data.slice(0, 300)}`);

  if (createResp.json?.status === 'ok') {
    console.log(`  ✅ TokenCreate accepted: ${createSig.slice(0, 30)}...`);
    await sleep(4000);

    // Check if token exists
    const tokResp = await httpReq(`${REST}/tokens`);
    try {
      const tokens = JSON.parse(tokResp.data);
      const ours = tokens.find(t => t.token_id === nftTokenId);
      if (ours) {
        console.log(`  ✅ Token CREATED on-chain:`);
        console.log(`    ${JSON.stringify(ours, null, 2)}`);

        // Now MINT 1 to ourselves
        console.log('\n  Minting 1 token to self...');
        bh = await getBlockhash();
        const mintInstr = concat([
          u32LE(0),              // variant 0 = TokenMint
          encStr(nftTokenId),
          encStr(kp.address),    // to
          u64LE(1)               // amount = 1 (no decimals)
        ]);
        const { resp: mintResp, sigB58: mintSig } = await submitTx(kp, mintInstr, bh);
        console.log(`  Mint ⇒ [${mintResp.status}] ${mintResp.data.slice(0, 300)}`);

        if (mintResp.json?.status === 'ok') {
          console.log(`  ✅ Mint accepted: ${mintSig.slice(0, 30)}...`);
          await sleep(3000);

          // Check balance
          const balResp = await httpReq(`${REST}/token/balance/${kp.address}/${nftTokenId}`);
          console.log(`  Token balance: ${balResp.data}`);

          // Re-check token supply
          const tokResp2 = await httpReq(`${REST}/tokens`);
          const tokens2 = JSON.parse(tokResp2.data);
          const updated = tokens2.find(t => t.token_id === nftTokenId);
          if (updated) console.log(`  Updated token: ${JSON.stringify(updated)}`);
        }
      } else {
        console.log('  ❌ Token NOT in /tokens list');
      }
    } catch(e) { console.log('  Parse error:', e.message); }
  }

  // ═══════════════════════════════════════════════════════
  // TEST 3: ContractCall on existing Swap — discover methods
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ TEST 3: ContractCall on pool_xrs_usdc ═══\n');

  const callMethods = ['get_price', 'get_reserves', 'swap', 'info', 'state', 'quote'];

  for (const method of callMethods) {
    bh = await getBlockhash();
    // ContractCall: variant 4, contract_id, method, args(Vec<u8>)
    // Vec<u8> empty = u64 length 0
    const callInstr = concat([
      u32LE(4),
      encStr('pool_xrs_usdc'),
      encStr(method),
      u64LE(0)  // empty args
    ]);

    const { resp, sigB58 } = await submitTx(kp, callInstr, bh);
    const accepted = resp.json?.status === 'ok';
    console.log(`  ${method}() → [${resp.status}] ${accepted ? '✅ accepted' : '❌ rejected'} ${resp.data.slice(0, 150)}`);

    if (accepted) {
      await sleep(2000);
      // Check if swap state changed
      const state = await httpReq(`${REST}/contract/pool_xrs_usdc`);
      console.log(`    Post-call state (reserves): a=${state.json?.contract?.state?.Swap?.reserve_a} b=${state.json?.contract?.state?.Swap?.reserve_b}`);
    }
    await sleep(500);
  }

  // ═══════════════════════════════════════════════════════
  // TEST 4: Check ALL contracts (maybe our deploys went somewhere)
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ TEST 4: Re-check /contracts ═══\n');
  const allContracts = await httpReq(`${REST}/contracts`);
  console.log(`Contracts: ${allContracts.data}`);

  // Final balance
  const finalBal = await rpcCall('getBalance', [kp.address]);
  console.log(`\nFinal balance: ${(finalBal.json?.result?.value || 0) / 1e9} XRS`);
  console.log(`Address: ${kp.address}`);
  console.log('\n═══ DONE ═══');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
