const http = require('http');
const REST = 'http://138.197.116.81:56001';

function httpReq(url) {
  return new Promise((resolve) => {
    http.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', e => resolve('ERR: ' + e.message));
  });
}

async function main() {
  const addr = '3pWU9h1DJXgo7auLaKpUmvkuqz6xXT8fpT3qgWmNAW6G';

  // 1. Check full token list
  console.log('═══ FULL TOKEN LIST ═══\n');
  const raw = await httpReq(`${REST}/tokens`);
  console.log(`Raw response type: ${typeof raw}, length: ${raw.length}`);
  console.log(`First 200 chars: ${raw.slice(0, 200)}`);
  console.log(`Last 200 chars: ${raw.slice(-200)}\n`);

  try {
    const tokens = JSON.parse(raw);
    if (Array.isArray(tokens)) {
      console.log(`Token count: ${tokens.length}\n`);

      // Find our tokens
      const ours = tokens.filter(t =>
        t.mint_authority === addr ||
        t.token_id?.startsWith('AINFT') ||
        t.token_id?.startsWith('rwa_test')
      );
      console.log(`Our tokens: ${ours.length}`);
      ours.forEach(t => console.log(JSON.stringify(t, null, 2)));

      // Find ANY tokens with rwa_metadata set
      const rwa = tokens.filter(t => t.rwa_metadata !== null && t.rwa_metadata !== undefined);
      console.log(`\nTokens with rwa_metadata: ${rwa.length}`);
      rwa.forEach(t => console.log(JSON.stringify(t, null, 2)));

      // Show all unique field names
      const fields = new Set();
      tokens.forEach(t => Object.keys(t).forEach(k => fields.add(k)));
      console.log(`\nAll token fields: ${[...fields].join(', ')}`);

      // Show tokens with decimals=0
      const dec0 = tokens.filter(t => t.decimals === 0);
      console.log(`\nTokens with decimals=0: ${dec0.length}`);
      dec0.forEach(t => console.log(`  ${t.token_id} | ${t.name} | supply=${t.max_supply} cur=${t.current_supply}`));
    } else if (typeof tokens === 'object') {
      console.log('Response is object (not array):');
      console.log(JSON.stringify(tokens, null, 2).slice(0, 2000));
    }
  } catch(e) {
    console.log('JSON parse failed:', e.message);
    console.log('Trying to find valid JSON boundary...');
    // Maybe it's multiple JSON objects concatenated?
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === '{' || raw[i] === '[') {
        try {
          const obj = JSON.parse(raw.slice(i));
          console.log(`Found valid JSON at offset ${i}:`, JSON.stringify(obj).slice(0, 500));
          break;
        } catch(e2) {}
      }
      i++;
    }
  }

  // 2. Check specific token balances
  console.log('\n═══ TOKEN BALANCE CHECKS ═══\n');
  const checkTokens = ['AINFT_1772647350888', 'rwa_test_a', 'rwa_test_b', 'rwa_test_c', 'rwa_test_d'];
  for (const tid of checkTokens) {
    const bal = await httpReq(`${REST}/token/balance/${addr}/${tid}`);
    console.log(`${tid}: ${bal}`);
  }

  // 3. Check v2/tokens (different format maybe)
  console.log('\n═══ v2/tokens ═══\n');
  const v2raw = await httpReq('http://138.197.116.81:50008/v2/tokens');
  try {
    const v2 = JSON.parse(v2raw);
    if (v2.data && Array.isArray(v2.data)) {
      console.log(`v2 token count: ${v2.data.length}`);
      const ours = v2.data.filter(t =>
        t.mint_authority === addr ||
        t.token_id?.startsWith('AINFT') ||
        t.token_id?.startsWith('rwa_test')
      );
      console.log(`Our tokens in v2: ${ours.length}`);
      ours.forEach(t => console.log(JSON.stringify(t, null, 2)));
    }
  } catch(e) {
    console.log('v2 parse error. Length:', v2raw.length);
    console.log(v2raw.slice(0, 500));
  }
}

main().catch(console.error);
