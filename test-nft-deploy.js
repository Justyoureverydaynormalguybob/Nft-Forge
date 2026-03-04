#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Test NFT Contract Deploy on Xeris
// Generates throwaway keypair, gets faucet XRS, deploys contract
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const crypto = require('crypto');

const REST = 'http://138.197.116.81:56001';
const RPC = 'http://138.197.116.81:50008';

// ─── HTTP Helper ─────────────────────────────────────────────

function httpReq(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const bodyStr = opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      },
      timeout: opts.timeout || 20000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch(e) {}
        resolve({ status: res.statusCode, data, json });
      });
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

// ─── Base58 ──────────────────────────────────────────────────

const BASE58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const size = Math.ceil((bytes.length - zeros) * 138 / 100) + 1;
  const b58 = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = size - 1; k >= 0; k--, j++) {
      if (carry === 0 && j >= length) break;
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }
  let result = '1'.repeat(zeros);
  for (let i = size - length; i < size; i++) result += BASE58_ALPHA[b58[i]];
  return result;
}

function base58Decode(str) {
  if (str.length === 0) return Buffer.alloc(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const size = Math.ceil((str.length - zeros) * 733 / 1000) + 1;
  const bytes = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < str.length; i++) {
    const idx = BASE58_ALPHA.indexOf(str[i]);
    if (idx < 0) throw new Error('Invalid base58 char: ' + str[i]);
    let carry = idx, j = 0;
    for (let k = size - 1; k >= 0; k--, j++) {
      if (carry === 0 && j >= length) break;
      carry += 58 * bytes[k];
      bytes[k] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    length = j;
  }
  const result = Buffer.alloc(zeros + length);
  for (let i = 0; i < length; i++) result[zeros + i] = bytes[size - length + i];
  return result;
}

// ─── Bincode Encoding ────────────────────────────────────────

function u8(v) { return Buffer.from([v & 0xff]); }

function u32LE(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function u64LE(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function encStr(s) {
  const e = Buffer.from(s, 'utf8');
  return Buffer.concat([u64LE(e.length), e]);
}

function concat(arrays) {
  return Buffer.concat(arrays);
}

// ─── Solana Wire Format ──────────────────────────────────────

function compactU16(value) {
  const out = [];
  let v = value;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>= 7; }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

function buildMessage(signerPubkey32, instructionData, blockhash32) {
  const programId = Buffer.alloc(32); // all zeros
  return concat([
    Buffer.from([1, 0, 1]),        // header: 1 req sig, 0 readonly signed, 1 readonly unsigned
    compactU16(2),                 // 2 accounts
    signerPubkey32,                // account[0] = signer
    programId,                     // account[1] = program (zeros)
    blockhash32,                   // 32 bytes
    compactU16(1),                 // 1 instruction
    Buffer.from([1]),              // program_id_index = 1
    compactU16(1),                 // 1 account in instruction
    Buffer.from([0]),              // account_index = 0 (signer)
    compactU16(instructionData.length),
    instructionData
  ]);
}

function buildUnsignedTx(messageBytes) {
  return concat([compactU16(1), Buffer.alloc(64), messageBytes]);
}

function buildSignedTx(signature64, messageBytes) {
  return concat([compactU16(1), signature64, messageBytes]);
}

// ─── Ed25519 Signing ─────────────────────────────────────────

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  // Ed25519 "secret key" in Solana convention = 64 bytes (privSeed + pubKey)
  const fullPriv = Buffer.concat([privRaw, pubRaw]);
  return {
    publicKey: pubRaw,
    privateKey: privRaw,
    fullKey: fullPriv,
    address: base58Encode(pubRaw),
    // Keep the Node.js key object for signing
    _privateKeyObj: privateKey
  };
}

function sign(messageBytes, privateKeyObj) {
  return crypto.sign(null, messageBytes, privateKeyObj);
}

// ─── Main ────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  XERIS NFT CONTRACT DEPLOY TEST');
  console.log('═══════════════════════════════════════════════\n');

  // Step 1: Generate keypair
  console.log('[1] Generating throwaway Ed25519 keypair...');
  const kp = generateKeypair();
  console.log(`    Address: ${kp.address}`);
  console.log(`    PubKey (hex): ${kp.publicKey.toString('hex')}`);

  // Step 2: Get faucet XRS
  console.log('\n[2] Requesting faucet airdrop (10 XRS)...');
  const airdrop1 = await httpReq(`${REST}/airdrop/${kp.address}/10`);
  console.log(`    Airdrop 1: [${airdrop1.status}] ${airdrop1.data.slice(0, 200)}`);

  // Wait for airdrop to process
  await sleep(3000);

  // Second airdrop for extra gas
  console.log('    Requesting second airdrop...');
  const airdrop2 = await httpReq(`${REST}/airdrop/${kp.address}/10`);
  console.log(`    Airdrop 2: [${airdrop2.status}] ${airdrop2.data.slice(0, 200)}`);

  await sleep(3000);

  // Check balance
  const balResp = await rpcCall('getBalance', [kp.address]);
  const balance = balResp.json?.result?.value || 0;
  console.log(`    Balance: ${balance} lamports (${balance / 1e9} XRS)`);

  if (balance === 0) {
    console.log('\n    ❌ No balance — faucet may have failed. Continuing anyway to test...');
  }

  // Step 3: Fetch blockhash
  console.log('\n[3] Fetching recent blockhash...');
  const bhResp = await rpcCall('getRecentBlockhash');
  let blockhashHex;
  if (bhResp.json?.result?.value?.blockhash) {
    blockhashHex = bhResp.json.result.value.blockhash;
  } else if (bhResp.json?.result?.blockhash) {
    blockhashHex = bhResp.json.result.blockhash;
  }
  console.log(`    Blockhash: ${blockhashHex}`);

  if (!blockhashHex) {
    console.log('    ❌ Could not get blockhash. Aborting.');
    return;
  }

  // Convert hex blockhash to 32 bytes
  const blockhash32 = Buffer.from(blockhashHex, 'hex');
  if (blockhash32.length !== 32) {
    console.log(`    ❌ Blockhash is ${blockhash32.length} bytes, need 32. Aborting.`);
    return;
  }

  // Step 4: Build ContractDeploy instructions for multiple type tests
  const testConfigs = [
    {
      label: 'TEST A: ContractDeploy type="NFT"',
      contract_id: 'test_nft_' + Date.now(),
      contract_type_str: 'NFT',
      params_json: JSON.stringify({
        name: 'Test AI NFT Collection',
        symbol: 'AINFT',
        max_supply: 10000
      })
    },
    {
      label: 'TEST B: ContractDeploy type="Swap" (known working type)',
      contract_id: 'test_swap_' + Date.now(),
      contract_type_str: 'Swap',
      params_json: JSON.stringify({
        token_a: 'xrs_native',
        token_b: 'test_token',
        fee_bps: 30
      })
    },
    {
      label: 'TEST C: ContractDeploy type="Collection"',
      contract_id: 'test_col_' + Date.now(),
      contract_type_str: 'Collection',
      params_json: JSON.stringify({
        name: 'AI Art Collection',
        symbol: 'AIART'
      })
    },
    {
      label: 'TEST D: ContractDeploy type="Marketplace"',
      contract_id: 'test_mkt_' + Date.now(),
      contract_type_str: 'Marketplace',
      params_json: JSON.stringify({
        name: 'NFT Marketplace',
        fee_bps: 250
      })
    }
  ];

  for (const test of testConfigs) {
    console.log(`\n[4] ${test.label}`);
    console.log(`    contract_id: ${test.contract_id}`);
    console.log(`    type: ${test.contract_type_str}`);
    console.log(`    params: ${test.params_json}`);

    // Encode ContractDeploy instruction (variant 5)
    const instructionData = concat([
      u32LE(5),                            // variant 5 = ContractDeploy
      encStr(test.contract_id),            // contract_id
      encStr(test.contract_type_str),      // contract_type_str
      encStr(test.params_json)             // params_json
    ]);
    console.log(`    Instruction: ${instructionData.length} bytes`);

    // Build message
    const pubkey32 = kp.publicKey.length === 32 ? kp.publicKey : (() => {
      const p = Buffer.alloc(32);
      p.set(kp.publicKey, 32 - kp.publicKey.length);
      return p;
    })();

    const messageBytes = buildMessage(pubkey32, instructionData, blockhash32);
    console.log(`    Message: ${messageBytes.length} bytes`);

    // Sign the message
    const signature = sign(messageBytes, kp._privateKeyObj);
    console.log(`    Signature: ${signature.length} bytes — ${base58Encode(signature).slice(0, 20)}...`);

    // Build signed transaction
    const signedTx = buildSignedTx(signature, messageBytes);
    const tx_base64 = signedTx.toString('base64');
    console.log(`    Signed TX: ${signedTx.length} bytes`);
    console.log(`    Base64: ${tx_base64.slice(0, 60)}...`);

    // Submit!
    console.log('    Submitting to /submit...');
    const submitResp = await httpReq(`${REST}/submit`, {
      method: 'POST',
      body: { tx_base64 }
    });
    console.log(`    ⇒ [${submitResp.status}] ${submitResp.data.slice(0, 500)}`);

    const sigBase58 = base58Encode(signature);

    if (submitResp.json && submitResp.json.status === 'ok') {
      console.log(`    ✅ TX ACCEPTED! Signature: ${sigBase58}`);

      // Wait and verify
      await sleep(3000);
      console.log('    Checking if contract was created...');
      const contractCheck = await httpReq(`${REST}/contract/${test.contract_id}`);
      console.log(`    /contract/${test.contract_id}: [${contractCheck.status}] ${contractCheck.data.slice(0, 500)}`);

      // Also check via getTransaction
      const txCheck = await rpcCall('getTransaction', [sigBase58]);
      console.log(`    getTransaction: ${txCheck.data.slice(0, 300)}`);
    } else {
      console.log(`    ❌ TX REJECTED: ${submitResp.data.slice(0, 300)}`);
    }

    // Small delay between tests
    await sleep(2000);

    // Refetch blockhash for next test (may expire)
    const newBh = await rpcCall('getRecentBlockhash');
    if (newBh.json?.result?.value?.blockhash) {
      const newHash = Buffer.from(newBh.json.result.value.blockhash, 'hex');
      if (newHash.length === 32) blockhash32.set(newHash);
    }
  }

  // ═══════════════════════════════════════════════════════
  // BONUS: Also test TokenCreateRWA (variant 6) to see its field requirements
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════');
  console.log('  BONUS: TokenCreateRWA (variant 6) TEST');
  console.log('═══════════════════════════════════════════════\n');

  // We don't know the exact fields for variant 6, but the guide says "many fields"
  // Let's try a minimal version and see what error we get
  // Guessing fields based on token structure + "rwa_metadata":
  // token_id, name, symbol, decimals, max_supply, mint_authority, + RWA metadata fields

  // Attempt 1: Same as TokenCreate but with variant 6
  const rwaInstruction = concat([
    u32LE(6),                                    // variant 6 = TokenCreateRWA
    encStr('test_rwa_nft_' + Date.now()),        // token_id
    encStr('AI Art NFT #1'),                     // name
    encStr('AINFT'),                             // symbol
    u8(0),                                       // decimals = 0 (NFT)
    u64LE(1),                                    // max_supply = 1 (unique)
    encStr(kp.address),                          // mint_authority
    // Additional RWA fields — guessing:
    encStr('AI Generated Art'),                  // description?
    encStr('https://example.com/nft/1.png'),     // image_uri?
    encStr(JSON.stringify({                      // metadata_json?
      artist: 'AI',
      prompt: 'A beautiful landscape',
      created: new Date().toISOString()
    }))
  ]);

  console.log(`RWA instruction: ${rwaInstruction.length} bytes`);

  // Refetch blockhash
  const bhResp2 = await rpcCall('getRecentBlockhash');
  const bh2 = Buffer.from(bhResp2.json?.result?.value?.blockhash || blockhashHex, 'hex');

  const rwaMsg = buildMessage(pubkey32, rwaInstruction, bh2);
  const rwaSig = sign(rwaMsg, kp._privateKeyObj);
  const rwaTx = buildSignedTx(rwaSig, rwaMsg);
  const rwa_base64 = rwaTx.toString('base64');

  console.log('Submitting TokenCreateRWA...');
  const rwaSubmit = await httpReq(`${REST}/submit`, { method: 'POST', body: { tx_base64: rwa_base64 } });
  console.log(`⇒ [${rwaSubmit.status}] ${rwaSubmit.data.slice(0, 500)}`);

  if (rwaSubmit.json?.status === 'ok') {
    console.log(`✅ RWA TX ACCEPTED! Sig: ${base58Encode(rwaSig)}`);
    await sleep(3000);
    // Check tokens list for our new token
    const tokResp = await httpReq(`${REST}/tokens`);
    try {
      const tokens = JSON.parse(tokResp.data);
      const ours = tokens.find(t => t.mint_authority === kp.address);
      if (ours) {
        console.log('Found our RWA token:');
        console.log(JSON.stringify(ours, null, 2));
      } else {
        console.log('Token not found in list yet (may need more time)');
      }
    } catch(e) { console.log('Token list parse error'); }
  } else {
    console.log(`❌ RWA TX REJECTED: ${rwaSubmit.data.slice(0, 500)}`);
    console.log('\nThe error message should tell us what fields variant 6 actually expects.');
  }

  // ═══════════════════════════════════════════════════════
  // Also test ContractCall (variant 4) on existing swap to understand args format
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════');
  console.log('  BONUS: ContractCall on Swap (variant 4)');
  console.log('═══════════════════════════════════════════════\n');

  const callInstruction = concat([
    u32LE(4),                        // variant 4 = ContractCall
    encStr('pool_xrs_usdc'),         // contract_id
    encStr('get_price'),             // method — guessing
    u64LE(0),                        // args length = 0 (Vec<u8> empty)
  ]);

  const callMsg = buildMessage(pubkey32, callInstruction, bh2);
  const callSig = sign(callMsg, kp._privateKeyObj);
  const callTx = buildSignedTx(callSig, callMsg);

  console.log('Submitting ContractCall(pool_xrs_usdc, "get_price", [])...');
  const callSubmit = await httpReq(`${REST}/submit`, { method: 'POST', body: { tx_base64: callTx.toString('base64') } });
  console.log(`⇒ [${callSubmit.status}] ${callSubmit.data.slice(0, 500)}`);

  // Final balance check
  await sleep(2000);
  const finalBal = await rpcCall('getBalance', [kp.address]);
  console.log(`\nFinal balance: ${(finalBal.json?.result?.value || 0) / 1e9} XRS`);
  console.log(`Wallet address (save if needed): ${kp.address}`);

  console.log('\n═══ DONE ═══');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
