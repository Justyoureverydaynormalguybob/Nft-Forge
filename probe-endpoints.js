const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 500) }));
    }).on('error', e => resolve({ status: 0, body: e.message }));
  });
}

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request('http://138.197.116.81:50008/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ method, body: data.slice(0, 300) }));
    });
    req.on('error', e => resolve({ method, body: e.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== REST ENDPOINT PROBING (port 56001) ===\n');

  const restPaths = [
    '/', '/nft', '/nfts', '/nft/mint', '/nft/create', '/nft/collections',
    '/collections', '/collection', '/metadata', '/token/metadata',
    '/contract', '/contracts', '/contract/list',
    '/mint', '/deploy', '/routes', '/help', '/api', '/docs',
    '/swagger', '/openapi', '/schema',
    '/token/nft', '/token/types', '/token/list',
    '/v1', '/v2', '/v3',
    '/nft/list', '/nft/all', '/nft/owner',
    '/token/create-nft', '/nft-create', '/nft-mint',
    '/assets', '/asset', '/digital-assets',
    '/marketplace', '/gallery',
    '/program', '/programs', '/instruction', '/instructions'
  ];

  for (const path of restPaths) {
    const r = await fetch(`http://138.197.116.81:56001${path}`);
    if (r.status !== 404 && r.body !== '' && !r.body.includes('Cannot GET')) {
      console.log(`[${r.status}] ${path} → ${r.body}`);
    } else {
      console.log(`[${r.status}] ${path} → (404/empty)`);
    }
  }

  console.log('\n=== REST ENDPOINT PROBING (port 50008 /v2) ===\n');

  const v2Paths = [
    '/v2/nfts', '/v2/nft', '/v2/collections', '/v2/metadata',
    '/v2/contracts', '/v2/programs', '/v2/assets',
    '/v2/token/nft', '/v2/token/types',
    '/v2/instructions', '/v2/schema', '/v2/routes',
    '/v2/nft/list', '/v2/nft/all',
    '/v2/marketplace', '/v2/gallery'
  ];

  for (const path of v2Paths) {
    const r = await fetch(`http://138.197.116.81:50008${path}`);
    if (r.status !== 404 && r.body !== '' && !r.body.includes('Cannot GET')) {
      console.log(`[${r.status}] ${path} → ${r.body}`);
    } else {
      console.log(`[${r.status}] ${path} → (404/empty)`);
    }
  }

  console.log('\n=== RPC METHOD PROBING ===\n');

  const rpcMethods = [
    'getNFT', 'getNfts', 'getNftsByOwner', 'getCollections',
    'getAssets', 'getAssetsByOwner', 'getDigitalAssets',
    'getTokenMetadata', 'getMetadata',
    'getProgramAccounts', 'getPrograms',
    'getInstructions', 'getInstructionTypes',
    'getNftMetadata', 'createNft', 'mintNft',
    'getTokensByOwner', 'getTokenAccounts',
    'getContract', 'getContracts', 'getContractState',
    'getSchema', 'getMethods', 'help',
    'getCompressedNft', 'getAsset', 'getAssetProof',
    'getGrouping', 'getAssetsByGroup',
    'getTokenSupply', 'getTokenLargestAccounts',
    'getMultipleAccounts', 'getClusterNodes',
    'getInflationRate', 'getGenesisHash',
    'getBlockProduction', 'getBlockCommitment',
    'getFees', 'getFeeForMessage',
    'getLatestBlockhash', 'isBlockhashValid',
    'getMinimumBalanceForRentExemption',
    'getStakeActivation', 'getSupply',
    'getEpochInfo', 'getEpochSchedule',
    'getFirstAvailableBlock', 'getLeaderSchedule',
    'getMaxRetransmitSlot', 'getMaxShredInsertSlot',
    'sendTransaction', 'simulateTransaction',
    'requestAirdrop'
  ];

  for (const method of rpcMethods) {
    const r = await rpc(method);
    const parsed = JSON.parse(r.body);
    const result = parsed.result;
    const isUnknown = result && typeof result === 'object' && result.error && result.error.includes('Unknown method');
    const isError = parsed.error;
    if (!isUnknown) {
      console.log(`✅ ${method} → ${r.body.slice(0, 200)}`);
    }
  }

  console.log('\n=== CHECKING EXISTING TOKENS FOR NFT-LIKE PATTERNS ===\n');
  const tokensResp = await fetch('http://138.197.116.81:56001/tokens');
  const tokens = JSON.parse(tokensResp.body);
  if (Array.isArray(tokens)) {
    const nftLike = tokens.filter(t => t.decimals === 0 || t.max_supply === 1 || (t.name && t.name.toLowerCase().includes('nft')));
    console.log(`Total tokens: ${tokens.length}`);
    console.log(`NFT-like (decimals=0 or supply=1 or name has "nft"): ${nftLike.length}`);
    nftLike.slice(0, 10).forEach(t => console.log(`  - ${t.token_id}: ${t.name} (decimals=${t.decimals}, max_supply=${t.max_supply})`));
  }
}

main().catch(console.error);
