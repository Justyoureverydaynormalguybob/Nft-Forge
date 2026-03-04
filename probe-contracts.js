const http = require('http');

const RPC = 'http://138.197.116.81:50008';
const REST = 'http://138.197.116.81:56001';

function httpReq(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const bodyStr = opts.body ? JSON.stringify(opts.body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', e => resolve({ status: 0, data: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: 'timeout' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function rpc(method, params = []) {
  return httpReq(RPC, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
}

async function main() {
  // ═══════════════════════════════════════════════════════
  // PART 1: Query the existing Swap contract
  // ═══════════════════════════════════════════════════════
  console.log('═══ PART 1: EXISTING CONTRACT INVESTIGATION ═══\n');

  // Get full contract list
  const contractsResp = await httpReq(`${REST}/contracts`);
  console.log('[/contracts]', contractsResp.data, '\n');

  // Try various contract query paths
  const contractPaths = [
    '/contract/pool_xrs_usdc',
    '/contract/info/pool_xrs_usdc',
    '/contract/state/pool_xrs_usdc',
    '/contract/methods/pool_xrs_usdc',
    '/contract/abi/pool_xrs_usdc',
    '/contract/schema/pool_xrs_usdc',
    '/contracts/pool_xrs_usdc',
    '/v2/contract/pool_xrs_usdc',
  ];

  for (const p of contractPaths) {
    const r = await httpReq(`${REST}${p}`);
    const r2 = await httpReq(`${RPC}${p}`);
    if (r.status !== 404 && r.status !== 405 && r.data) console.log(`[56001 GET ${p}] ${r.status}: ${r.data.slice(0, 500)}`);
    if (r2.status !== 404 && r2.data) console.log(`[50008 GET ${p}] ${r2.status}: ${r2.data.slice(0, 500)}`);
  }

  // POST variants for contract info
  const contractPostPaths = [
    ['/contract/pool_xrs_usdc', {}],
    ['/contract/info', { contract_id: 'pool_xrs_usdc' }],
    ['/contract/state', { contract_id: 'pool_xrs_usdc' }],
    ['/contract/methods', { contract_id: 'pool_xrs_usdc' }],
    ['/contract/abi', { contract_id: 'pool_xrs_usdc' }],
    ['/contract/get', { contract_id: 'pool_xrs_usdc' }],
    ['/contract/query', { contract_id: 'pool_xrs_usdc' }],
    ['/contract/read', { contract_id: 'pool_xrs_usdc' }],
    ['/contract/view', { contract_id: 'pool_xrs_usdc' }],
  ];

  console.log('\n--- POST probes for contract info ---');
  for (const [p, body] of contractPostPaths) {
    const r = await httpReq(`${REST}${p}`, { method: 'POST', body });
    if (r.status !== 404 && r.data) console.log(`[POST ${p}] ${r.status}: ${r.data.slice(0, 500)}`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 2: Try ContractCall on the Swap contract
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 2: CONTRACT CALL ENDPOINT PROBING ═══\n');

  // The disabled /contract/call gives us a hint about the format
  // Let's see what it says again
  const callResp = await httpReq(`${REST}/contract/call`, { method: 'POST', body: {} });
  console.log('[POST /contract/call] hint:', callResp.data, '\n');

  const deployResp = await httpReq(`${REST}/contract/deploy`, { method: 'POST', body: {} });
  console.log('[POST /contract/deploy] hint:', deployResp.data, '\n');

  // ═══════════════════════════════════════════════════════
  // PART 3: Check RPC for contract-related methods
  // ═══════════════════════════════════════════════════════
  console.log('═══ PART 3: RPC CONTRACT METHODS ═══\n');

  const rpcMethods = [
    'getContract', 'getContractState', 'getContractInfo',
    'getContractAbi', 'getContractMethods', 'getContractSchema',
    'getContractCode', 'getContractData', 'getContractStorage',
    'callContract', 'queryContract', 'readContract', 'viewContract',
    'getContractAccounts', 'getContractEvents', 'getContractLogs',
    'getProgramAccounts', 'getProgram',
    'getAccountInfo',  // Try on the contract owner
  ];

  for (const m of rpcMethods) {
    const r = await rpc(m, ['pool_xrs_usdc']);
    const parsed = JSON.parse(r.data);
    const isUnknown = parsed.result && typeof parsed.result === 'object' && parsed.result.error && parsed.result.error.includes('Unknown method');
    if (!isUnknown) {
      console.log(`✅ ${m}('pool_xrs_usdc') → ${r.data.slice(0, 300)}`);
    }
  }

  // getAccountInfo on the contract owner (the validator)
  console.log('\n--- getAccountInfo on contract owner ---');
  const ownerInfo = await rpc('getAccountInfo', ['8evPjjozSHNcoGRcv7zzxwan9sf3ubJ8q9CFzms6AK97']);
  console.log('Owner account:', ownerInfo.data.slice(0, 500));

  // ═══════════════════════════════════════════════════════
  // PART 4: Probe contract types via /contract/list
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 4: CONTRACT LIST WITH PARAMS ═══\n');

  const listPaths = [
    '/contract/list',
    '/contract/list?type=Swap',
    '/contract/list?type=NFT',
    '/contract/list?type=Token',
    '/contract/list?type=nft',
    '/contract/list?type=ERC721',
    '/contract/list?type=all',
    '/contract/list/Swap',
    '/contract/list/NFT',
    '/contract/list/all',
    '/contracts?type=Swap',
    '/contracts?type=NFT',
    '/contracts?type=all',
  ];

  for (const p of listPaths) {
    const r = await httpReq(`${REST}${p}`);
    if (r.data && r.status !== 404) console.log(`[GET ${p}] ${r.status}: ${r.data.slice(0, 300)}`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 5: Scan blocks for ContractDeploy transactions
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 5: SCANNING BLOCKS FOR CONTRACT DEPLOY TXS ═══\n');

  // The Swap contract was created at slot 1055312 — let's try to get that block
  const deployBlock = await rpc('getBlock', [1055312]);
  console.log('Block 1055312 (contract deploy):', deployBlock.data.slice(0, 500));

  // Get the block via REST for full tx data
  // REST /blocks only returns latest 50, but let's check /v2/block/slot
  const deployBlockV2 = await httpReq(`${RPC}/v2/block/slot/1055312`);
  console.log('v2/block/slot/1055312:', deployBlockV2.data.slice(0, 1000));

  // ═══════════════════════════════════════════════════════
  // PART 6: Try deploying a test contract to see error messages
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 6: CONTRACT DEPLOY FORMAT DISCOVERY ═══\n');

  // We can't actually sign a tx without a private key, but we can try
  // submitting garbage to see what error messages reveal about the format.

  // Try submitting raw ContractDeploy instruction data (unsigned) to see error
  // Variant 5 = ContractDeploy { contract_id: String, contract_type_str: String, params_json: String }

  // Build a minimal bincode payload for ContractDeploy
  function u32LE(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
  function u64LE(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
  function encStr(s) { const e = Buffer.from(s, 'utf8'); return Buffer.concat([u64LE(e.length), e]); }

  // Just build the instruction data to see it
  const testDeploy = Buffer.concat([
    u32LE(5),                           // variant 5 = ContractDeploy
    encStr('test_nft_contract'),        // contract_id
    encStr('NFT'),                      // contract_type_str — testing if "NFT" works
    encStr(JSON.stringify({             // params_json
      name: 'Test NFT Collection',
      symbol: 'TNFT',
      base_uri: 'https://example.com/nft/'
    }))
  ]);
  console.log('ContractDeploy instruction (hex):', testDeploy.toString('hex'));
  console.log('ContractDeploy instruction (base64):', testDeploy.toString('base64'));
  console.log('Instruction length:', testDeploy.length, 'bytes\n');

  // Try different contract_type_str values to learn what's valid
  const typeTests = ['NFT', 'Swap', 'Token', 'Custom', 'WASM', 'ERC721', 'nft', 'Collection'];
  console.log('Testing contract_type_str values (via /contract/deploy POST):');
  for (const t of typeTests) {
    const r = await httpReq(`${REST}/contract/deploy`, {
      method: 'POST',
      body: { contract_id: 'test', contract_type_str: t, params_json: '{}' }
    });
    console.log(`  type="${t}" → ${r.data.slice(0, 200)}`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 7: Check full token list (fixed truncation)
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 7: FULL TOKEN LIST ═══\n');

  const tokResp = await httpReq(`${REST}/tokens`);
  try {
    const tokens = JSON.parse(tokResp.data);
    if (Array.isArray(tokens)) {
      console.log(`Total tokens: ${tokens.length}`);
      const nftLike = tokens.filter(t => t.decimals === 0 || t.max_supply <= 10);
      console.log(`NFT-like (decimals=0 or supply<=10): ${nftLike.length}`);
      nftLike.forEach(t => console.log(`  ${t.token_id} | "${t.name}" | dec=${t.decimals} supply=${t.max_supply} auth=${t.mint_authority}`));
      console.log('\n--- Full list ---');
      tokens.forEach(t => console.log(`  ${t.token_id} | ${t.symbol} | dec=${t.decimals} supply=${t.max_supply} type=${t.contract_type || t.type || 'token'}`));
    }
  } catch(e) {
    console.log('Parse error. Raw length:', tokResp.data.length);
    // Print in chunks to avoid truncation
    for (let i = 0; i < tokResp.data.length; i += 2000) {
      console.log(tokResp.data.slice(i, i + 2000));
    }
  }

  // ═══════════════════════════════════════════════════════
  // PART 8: Check /v2/tokens for any extra fields
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 8: v2 TOKENS (may have extra fields) ═══\n');
  const v2Tok = await httpReq(`${RPC}/v2/tokens`);
  try {
    const parsed = JSON.parse(v2Tok.data);
    if (parsed.data && Array.isArray(parsed.data)) {
      console.log(`v2 tokens count: ${parsed.data.length}`);
      // Show first 3 with ALL fields
      parsed.data.slice(0, 3).forEach(t => console.log(JSON.stringify(t, null, 2)));
    } else {
      console.log('v2 tokens:', v2Tok.data.slice(0, 1000));
    }
  } catch(e) {
    console.log('v2 tokens raw:', v2Tok.data.slice(0, 1000));
  }
}

main().catch(console.error);
