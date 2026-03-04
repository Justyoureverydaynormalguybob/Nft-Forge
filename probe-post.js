const http = require('http');

function postJSON(port, path, body = {}) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: '138.197.116.81',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 1000) }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(bodyStr);
    req.end();
  });
}

function fetchFull(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', e => resolve({ status: 0, body: e.message }));
  });
}

async function main() {
  console.log('=== POST PROBING NFT ENDPOINTS (port 56001) ===\n');

  // Probe with empty body first to see what they expect
  const nftPaths = [
    ['/nft', {}],
    ['/nfts', {}],
    ['/nft/mint', {}],
    ['/nft/create', {}],
    ['/nft/create', { name: 'test', description: 'test', image: 'https://example.com/test.png' }],
    ['/nft/create', { token_id: 'test_nft_1', name: 'Test NFT', symbol: 'TNFT', metadata: '{}' }],
    ['/nft/collections', {}],
    ['/nft/list', {}],
    ['/nft/all', {}],
    ['/nft/owner', {}],
    ['/nft/owner', { address: '8evPjjozSHNcoGRcv7zzxwan9sf3ubJ8q9CFzms6AK97' }],
    ['/collections', {}],
    ['/collection', {}],
    ['/metadata', {}],
    ['/metadata', { token_id: 'test' }],
    ['/token/metadata', {}],
    ['/token/metadata', { token_id: 'test' }],
  ];

  for (const [path, body] of nftPaths) {
    const r = await postJSON(56001, path, body);
    console.log(`[${r.status}] POST ${path} ${JSON.stringify(body)}`);
    console.log(`  → ${r.body}\n`);
  }

  console.log('=== POST PROBING OTHER INTERESTING ENDPOINTS ===\n');

  const otherPaths = [
    ['/contract', {}],
    ['/contract/list', {}],
    ['/contracts', {}],
    ['/contract/call', {}],
    ['/contract/deploy', {}],
    ['/mint', {}],
    ['/deploy', {}],
    ['/instruction', {}],
    ['/instructions', {}],
    ['/schema', {}],
    ['/routes', {}],
    ['/help', {}],
    ['/docs', {}],
    ['/asset', {}],
    ['/assets', {}],
  ];

  for (const [path, body] of otherPaths) {
    const r = await postJSON(56001, path, body);
    console.log(`[${r.status}] POST ${path} → ${r.body}`);
  }

  console.log('\n=== CHECKING /nft WITH SIGNED TX FORMAT ===\n');

  // Maybe /nft/create and /nft/mint need signed tx like /submit?
  const txPaths = [
    ['/nft/create', { tx_base64: 'dGVzdA==' }],
    ['/nft/mint', { tx_base64: 'dGVzdA==' }],
  ];

  for (const [path, body] of txPaths) {
    const r = await postJSON(56001, path, body);
    console.log(`[${r.status}] POST ${path} ${JSON.stringify(body)}`);
    console.log(`  → ${r.body}\n`);
  }

  console.log('=== FULL TOKEN LIST (checking for NFT patterns) ===\n');

  const tokensResp = await fetchFull('http://138.197.116.81:56001/tokens');
  try {
    const tokens = JSON.parse(tokensResp.body);
    if (Array.isArray(tokens)) {
      console.log(`Total tokens: ${tokens.length}\n`);

      // Show all tokens with decimals=0 or max_supply<=100
      const nftLike = tokens.filter(t =>
        t.decimals === 0 ||
        t.max_supply <= 100 ||
        (t.name && t.name.toLowerCase().includes('nft')) ||
        (t.token_id && t.token_id.toLowerCase().includes('nft'))
      );
      console.log(`NFT-like tokens (decimals=0, supply<=100, or name/id has "nft"): ${nftLike.length}`);
      nftLike.forEach(t => console.log(`  - ${t.token_id}: name="${t.name}" symbol="${t.symbol}" decimals=${t.decimals} max_supply=${t.max_supply} mint_auth=${t.mint_authority}`));

      console.log('\n--- All tokens summary ---');
      tokens.forEach(t => console.log(`  ${t.token_id} | ${t.name} | dec=${t.decimals} | supply=${t.max_supply}`));
    }
  } catch (e) {
    console.log('Token parse error:', e.message);
    console.log('Raw response length:', tokensResp.body.length);
    console.log('First 2000 chars:', tokensResp.body.slice(0, 2000));
  }

  console.log('\n=== PROBING /nft/ SUBPATHS ===\n');

  const nftSubPaths = [
    '/nft/info', '/nft/get', '/nft/balance', '/nft/transfer',
    '/nft/burn', '/nft/metadata', '/nft/update', '/nft/approve',
    '/nft/tokens', '/nft/supply', '/nft/exists',
    '/nft/tokenURI', '/nft/ownerOf', '/nft/tokenOfOwner'
  ];

  for (const path of nftSubPaths) {
    const rGet = await fetchFull(`http://138.197.116.81:56001${path}`);
    const rPost = await postJSON(56001, path, {});
    const getStatus = rGet.status;
    const postStatus = rPost.status;
    if (getStatus !== 404 || postStatus !== 404) {
      console.log(`${path} → GET=${getStatus} POST=${postStatus}`);
      if (postStatus === 200) console.log(`  POST body: ${rPost.body}`);
      if (getStatus === 200) console.log(`  GET body: ${rGet.body.slice(0, 300)}`);
    }
  }
}

main().catch(console.error);
