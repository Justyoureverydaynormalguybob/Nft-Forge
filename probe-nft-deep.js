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
      timeout: opts.timeout || 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', e => resolve({ status: 0, data: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: 'TIMEOUT' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function rpc(method, params = []) {
  return httpReq(RPC, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
}

async function main() {
  // ═══════════════════════════════════════════════════════
  // PART 1: "NFT" contract type — deeper timeout investigation
  // ═══════════════════════════════════════════════════════
  console.log('═══ PART 1: NFT TYPE TIMEOUT INVESTIGATION ═══\n');

  // The /contract/deploy with type="NFT" timed out. Let's try with longer timeout
  // and with different body shapes
  const nftDeployTests = [
    { contract_id: 'test_nft', contract_type_str: 'NFT', params_json: '{}' },
    { contract_id: 'test_nft', contract_type_str: 'NFT', params_json: '{"name":"Test"}' },
    { contract_id: 'test_nft', contract_type_str: 'Nft', params_json: '{}' },
    { contract_id: 'test_nft', contract_type_str: 'nft', params_json: '{}' },
    // Try with params matching what an NFT contract might need
    { contract_id: 'test_nft', contract_type_str: 'NFT', params_json: JSON.stringify({
      name: 'Test NFT', symbol: 'TNFT', base_uri: 'https://example.com/'
    })},
    // Maybe it wants the same format as the Swap contract's state keys
    { contract_type_str: 'NFT' },  // minimal
    // Try tx_base64 format like /submit
    { tx_base64: 'dGVzdA==' },
  ];

  for (const body of nftDeployTests) {
    console.log(`Testing: ${JSON.stringify(body).slice(0, 100)}`);
    const r = await httpReq(`${REST}/contract/deploy`, { method: 'POST', body, timeout: 20000 });
    console.log(`  → [${r.status}] ${r.data.slice(0, 300)}\n`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 2: RWA Metadata — the metadata angle
  // ═══════════════════════════════════════════════════════
  console.log('═══ PART 2: RWA TOKEN METADATA INVESTIGATION ═══\n');

  // Get ALL tokens with full details to find any with rwa_metadata set
  const tokResp = await httpReq(`${REST}/tokens`, { timeout: 15000 });
  try {
    const tokens = JSON.parse(tokResp.data);
    if (Array.isArray(tokens)) {
      console.log(`Total tokens: ${tokens.length}\n`);

      // Find tokens WITH rwa_metadata
      const rwaTokens = tokens.filter(t => t.rwa_metadata !== null && t.rwa_metadata !== undefined);
      console.log(`Tokens with rwa_metadata: ${rwaTokens.length}`);
      rwaTokens.forEach(t => {
        console.log(`\n  TOKEN: ${t.token_id}`);
        console.log(`  Name: ${t.name} | Symbol: ${t.symbol}`);
        console.log(`  Decimals: ${t.decimals} | Supply: ${t.max_supply} | Current: ${t.current_supply}`);
        console.log(`  RWA Metadata: ${JSON.stringify(t.rwa_metadata)}`);
      });

      // Find NFT-like: decimals=0 OR supply=1
      const nftLike = tokens.filter(t => t.decimals === 0 || t.max_supply === 1);
      console.log(`\nNFT-like tokens (decimals=0 or supply=1): ${nftLike.length}`);
      nftLike.forEach(t => console.log(`  ${t.token_id} | "${t.name}" | dec=${t.decimals} sup=${t.max_supply} cur=${t.current_supply}`));

      // Show ALL unique field names across all tokens
      const allKeys = new Set();
      tokens.forEach(t => Object.keys(t).forEach(k => allKeys.add(k)));
      console.log(`\nAll token fields: ${[...allKeys].join(', ')}`);

      // Show 3 tokens with ALL their fields in detail
      console.log('\n--- Sample tokens (all fields) ---');
      tokens.slice(0, 3).forEach(t => console.log(JSON.stringify(t)));
    }
  } catch(e) {
    console.log('Parse error:', e.message);
    console.log('Raw length:', tokResp.data.length);
    console.log('First 3000 chars:');
    console.log(tokResp.data.slice(0, 3000));
  }

  // ═══════════════════════════════════════════════════════
  // PART 3: TokenCreateRWA variant 6 — what does it accept?
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 3: RWA TOKEN CREATION ENDPOINTS ═══\n');

  // Probe for RWA-specific endpoints
  const rwaPaths = [
    '/token/create-rwa', '/token/rwa', '/rwa', '/rwa/create',
    '/rwa/mint', '/rwa/list', '/rwa/tokens',
    '/token/create/rwa', '/token/rwa/create'
  ];

  for (const p of rwaPaths) {
    const rGet = await httpReq(`${REST}${p}`);
    const rPost = await httpReq(`${REST}${p}`, { method: 'POST', body: {} });
    console.log(`${p} → GET=${rGet.status} POST=${rPost.status}`);
    if (rPost.status === 200) console.log(`  POST: ${rPost.data.slice(0, 300)}`);
    if (rGet.status === 200) console.log(`  GET: ${rGet.data.slice(0, 300)}`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 4: ContractCall — probe the Swap to understand call format
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 4: SWAP CONTRACT METHOD DISCOVERY ═══\n');

  // The Swap state shows: fee_bps, lp_shares, reserve_a, reserve_b, token_a, token_b, total_shares
  // Common Swap methods would be: swap, add_liquidity, remove_liquidity, get_price
  // Let's see if there's a way to query methods

  // Try /contract/{id}/methods or similar
  const methodPaths = [
    `/contract/pool_xrs_usdc/methods`,
    `/contract/pool_xrs_usdc/abi`,
    `/contract/pool_xrs_usdc/info`,
    `/contract/pool_xrs_usdc/state`,
    `/contract/pool_xrs_usdc/schema`,
    `/contract/pool_xrs_usdc/help`,
  ];

  for (const p of methodPaths) {
    const r = await httpReq(`${REST}${p}`);
    if (r.status === 200 && r.data.length > 5) console.log(`[GET ${p}] ${r.status}: ${r.data.slice(0, 500)}`);
    const r2 = await httpReq(`${RPC}${p}`);
    if (r2.status === 200 && r2.data.length > 5) console.log(`[50008 GET ${p}] ${r2.status}: ${r2.data.slice(0, 500)}`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 5: Try querying a non-existent NFT contract to see error
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 5: QUERY NON-EXISTENT NFT CONTRACT ═══\n');

  const nftContractPaths = [
    '/contract/nft',
    '/contract/xeris_nft',
    '/contract/nft_collection',
    '/contract/ai_nft',
  ];

  for (const p of nftContractPaths) {
    const r = await httpReq(`${REST}${p}`);
    console.log(`[GET ${p}] ${r.status}: ${r.data.slice(0, 200)}`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 6: See what contract types the node ACTUALLY supports
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 6: DISCOVERING SUPPORTED CONTRACT TYPES ═══\n');

  // Deploy endpoint hint says: ContractDeploy { contract_id, contract_type_str, params_json }
  // The Swap contract has type "Swap"
  // Let's try querying /contracts with various filters
  const typeFilters = ['Swap', 'NFT', 'Token', 'Staking', 'Lending', 'Oracle', 'Bridge', 'Marketplace', 'Auction', 'Escrow'];
  for (const t of typeFilters) {
    const r = await httpReq(`${REST}/contracts?type=${t}`);
    const parsed = JSON.parse(r.data);
    console.log(`/contracts?type=${t} → count=${parsed.count}, contracts=${parsed.contracts?.length || 0}`);
  }

  // ═══════════════════════════════════════════════════════
  // PART 7: Check if /contract/deploy with NFT actually CREATES something
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 7: NFT DEPLOY DIRECT ATTEMPT (longer timeout) ═══\n');

  // The timeout on "NFT" type was suspicious. Let's try with 30s timeout
  // and check if maybe it actually tried to deploy
  console.log('Attempting /contract/deploy with type=NFT (30s timeout)...');
  const nftDeploy = await httpReq(`${REST}/contract/deploy`, {
    method: 'POST',
    body: {
      contract_id: 'test_nft_probe',
      contract_type_str: 'NFT',
      params_json: JSON.stringify({ name: 'Test NFT', symbol: 'TNFT' })
    },
    timeout: 30000
  });
  console.log(`Result: [${nftDeploy.status}] ${nftDeploy.data.slice(0, 500)}`);

  // Check if it created anything
  const checkContract = await httpReq(`${REST}/contract/test_nft_probe`);
  console.log(`Check /contract/test_nft_probe: [${checkContract.status}] ${checkContract.data.slice(0, 300)}`);

  // ═══════════════════════════════════════════════════════
  // PART 8: Instruction variant documentation from node
  // ═══════════════════════════════════════════════════════
  console.log('\n═══ PART 8: ALL DISABLED ENDPOINTS (instruction hints) ═══\n');

  // Probe EVERY known mutation endpoint to collect all instruction hints
  const mutationPaths = [
    '/token/create', '/token/mint', '/token/transfer', '/token/burn',
    '/token/create-rwa', '/contract/call', '/contract/deploy',
    '/nft/create', '/nft/mint', '/nft/transfer', '/nft/burn',
    '/rwa/create', '/rwa/transfer', '/rwa/update',
    '/stake', '/unstake',
  ];

  for (const p of mutationPaths) {
    const r = await httpReq(`${REST}${p}`, { method: 'POST', body: {} });
    if (r.status === 200 && r.data.includes('instruction') || r.data.includes('variant') || r.data.includes('hint')) {
      console.log(`[POST ${p}] → ${r.data.slice(0, 400)}\n`);
    }
  }
}

main().catch(console.error);
