// Pangea fee leaderboard: what every Pangea launch's creator has earned in trading fees.
// Runs on GitHub Actions every 10 minutes (no keys, no wallet). Two reads of Pangea's public API per run
// (/api/pools and /api/history?hours=168; the limit is 30 uncached reads in ten minutes) and, for pools
// not seen before, one fee read per pool from the chain (the fee is fixed at launch, so it is kept).
//
// Creator fees, per Pangea's docs (Trading fee): the platform takes 20% of the fee with a floor of 0.2% of
// volume; the creator gets the rest. On Solana, Meteora keeps 20% of the fee first.
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PANGEA = 'https://www.pangea.trade';
const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';   // Uniswap v4 Initialize
const CONFIGS = '0xce8f6078';   // PangeaFeeHook.configs(bytes32) -> (splitter, quoteIsCurrency0, feeBps, registered, edgeTick)
const RPC = {
  ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com'],
  bsc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://binance.llamarpc.com'],
  robinhood: [],
};
const EVM = ['ethereum', 'base', 'bsc', 'robinhood'];

async function getJson(url, opts = {}, ms = 30_000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'pangea-fee-board/1.0', ...(opts.headers || {}) } }); if (!r.ok) throw new Error(`${url.split('?')[0]} HTTP ${r.status}`); return await r.json(); }
  finally { clearTimeout(t); }
}
async function rpc(chain, method, params) {
  let last;
  for (const u of RPC[chain] || []) {
    try {
      const j = await getJson(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 12_000);
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('no RPC for ' + chain);
}
async function lzRpcs() {
  try {
    const j = await getJson('https://metadata.layerzero-api.com/v1/metadata', {}, 30_000);
    for (const [k, v] of Object.entries(j)) {
      const want = k === 'ethereum' ? 'ethereum' : k === 'base' ? 'base' : k === 'bsc' ? 'bsc' : (/robinhood/i.test(k) && !/test|sepolia/i.test(k)) ? 'robinhood' : null;
      if (!want) continue;
      const urls = (v.rpcs || []).map(x => x.url).filter(u => /^https:/.test(u) && !/1rpc\.io|\$\{|infura|alchemy/i.test(u));
      for (const u of urls) if (!RPC[want].includes(u)) RPC[want].push(u);
    }
  } catch (e) { console.log('LayerZero RPC list unavailable: ' + e.message); }
}

// fee per pool (bps), kept between runs: the fee can't change after launch
const FEES_FILE = path.join(OUT, 'fees.json');
let fees = {}; try { fees = JSON.parse(fs.readFileSync(FEES_FILE, 'utf8')); } catch {}
const hooks = fees._hooks || {};   // chain -> hook address seen on that chain (checked first)
async function hookOf(chain, pool) {
  const hex = n => '0x' + Math.max(0, n).toString(16);
  for (const span of [0, 3, 30]) {
    const logs = await rpc(chain, 'eth_getLogs', [{ fromBlock: hex(pool.launchBlock - span), toBlock: hex(pool.launchBlock + span), topics: [INIT_TOPIC, pool.poolId] }]).catch(() => []);
    if (logs && logs.length) return '0x' + logs[0].data.slice(2 + 64 * 2 + 24, 2 + 64 * 3);   // data: fee, tickSpacing, hooks, sqrtPriceX96, tick
  }
  return null;
}
async function readFee(chain, hook, poolId) {
  const r = await rpc(chain, 'eth_call', [{ to: hook, data: CONFIGS + poolId.slice(2) }, 'latest']);
  if (!r || r.length < 2 + 64 * 4) return null;
  const word = i => r.slice(2 + 64 * i, 2 + 64 * (i + 1));
  const bps = parseInt(word(2), 16), registered = parseInt(word(3), 16) === 1;
  return registered && bps > 0 ? bps : null;
}
async function feeFor(chain, pool) {
  if (!pool.poolId || !pool.launchBlock) return null;
  const k = chain + ':' + pool.poolId;
  if (fees[k]) return fees[k];
  let bps = null;
  if (hooks[chain]) bps = await readFee(chain, hooks[chain], pool.poolId).catch(() => null);
  if (!bps) {
    const h = await hookOf(chain, pool).catch(() => null);
    if (h && !/^0x0+$/.test(h)) { bps = await readFee(chain, h, pool.poolId).catch(() => null); if (bps) hooks[chain] = h; }
  }
  if (bps) fees[k] = bps;
  return bps;
}

// creator's share of volume, from the trading fee (fraction, e.g. 0.03)
function creatorRate(fee, chain) {
  const platform = Math.max(0.2 * fee, 0.002);
  const kept = chain === 'solana' ? fee * 0.8 : fee;   // Meteora keeps 20% on Solana
  return Math.max(0, kept - platform);
}

async function main() {
  const t0 = Date.now();
  await lzRpcs();
  const [pools, h7, h24] = await Promise.all([getJson(PANGEA + '/api/pools'), getJson(PANGEA + '/api/history?hours=168'), getJson(PANGEA + '/api/history?hours=24')]);
  // the platform's own coin ($PANGEA) pays its fees to the platform, not a creator
  const bySlug = new Map((pools.launches || []).filter(l => !l.test && !l.platform && l.slug !== 'pangea-dadd0d').map(l => [l.slug, l]));
  const vol24 = new Map((h24.launches || []).map(h => [h.slug, h]));
  const rows = [];
  // only launches that traded this week matter; read fees for those (new pools only)
  const active = (h7.launches || []).filter(h => h.volumeUsd > 0 && bySlug.has(h.slug)).sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 300);
  let reads = 0;
  for (const h of active) {
    const l = bySlug.get(h.slug);
    const feeByChain = {};
    for (const p of l.pools || []) {
      if (!EVM.includes(p.chain)) continue;
      if (!fees[p.chain + ':' + p.poolId]) reads++;
      if (reads > 900 || Date.now() - t0 > 4 * 60_000) break;   // spread first-time reads over runs if there are very many
      feeByChain[p.chain] = await feeFor(p.chain, p).catch(() => null);
    }
    const evmPools = (l.pools || []).filter(p => EVM.includes(p.chain));
    const pending = evmPools.some(p => !feeByChain[p.chain]);
    const known = Object.values(feeByChain).filter(Boolean);
    const common = known.length ? known.sort((a, b) => a - b)[Math.floor(known.length / 2)] : null;   // Solana: same fee as the EVM chains (the usual setup)
    const calc = (hist) => {
      let creator = 0, platform = 0, vol = 0; const chains = {};
      for (const c of (hist && hist.chains) || []) {
        const bps = feeByChain[c.chain] || common; if (!bps || !(c.volumeUsd > 0)) continue;
        const fee = bps / 10000, earned = c.volumeUsd * creatorRate(fee, c.chain);
        creator += earned; platform += c.volumeUsd * Math.max(0.2 * fee, 0.002); vol += c.volumeUsd;
        chains[c.chain] = { volUsd: Math.round(c.volumeUsd), feePct: +(fee * 100).toFixed(2), creatorUsd: Math.round(earned) };
      }
      return { creatorUsd: Math.round(creator), platformUsd: Math.round(platform), volUsd: Math.round(vol), trades: (hist && hist.trades) || 0, coverage: hist ? hist.coverage : null, chains };
    };
    rows.push({ slug: l.slug, name: l.name, symbol: l.symbol, listedAt: l.listedAt * 1000, chainsLive: l.chainsLive, degen: !!l.degen, feePct: common ? +(common / 100).toFixed(2) : null,
      hasTokenomics: !!l.tokenomics, feesPending: pending, week: calc(h), day: calc(vol24.get(l.slug)) });
  }
  rows.sort((a, b) => b.week.creatorUsd - a.week.creatorUsd);
  // pictures and links for the top coins (the coin's own metadata; kept between runs)
  const meta = fees._meta || {};
  let metaReads = 0;
  for (const r of rows.slice(0, 60)) {
    if (!meta[r.slug] && metaReads < 20) {
      metaReads++;
      try {
        const m = await getJson(`${PANGEA}/api/token/meta?launch=${encodeURIComponent(r.slug)}`, {}, 10_000);
        const img = String(m.image || ''), cid = (img.match(/(?:ipfs:\/\/|\/ipfs\/)(?:ipfs\/)?([A-Za-z0-9]{40,})/) || [])[1];
        const link = u => /^https:\/\//.test(String(u || '')) ? String(u).slice(0, 200) : null;
        meta[r.slug] = { img: cid ? `${PANGEA}/api/logo/${cid}/128.webp` : link(img), x: link(m.twitter), web: link(m.website), desc: String(m.description || '').slice(0, 160) };
      } catch { meta[r.slug] = { img: null }; }
    }
    if (meta[r.slug]) Object.assign(r, meta[r.slug]);
  }
  fees._meta = meta;
  const sum = k => rows.filter(r => !r.hasTokenomics).reduce((a, r) => a + r[k].creatorUsd, 0);   // tokenomics coins spend the creator share instead of paying it
  const data = { at: Date.now(), pangeaReadAt: pools.readAt || null, launches: rows.length, totals: { dayCreatorUsd: sum('day'), weekCreatorUsd: sum('week') }, rows };
  fees._hooks = hooks;
  fs.writeFileSync(FEES_FILE, JSON.stringify(fees));
  fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data));
  console.log(`${rows.length} launches · 24h creator fees $${data.totals.dayCreatorUsd} · 7d $${data.totals.weekCreatorUsd} · ${reads} new fee reads · hooks ${JSON.stringify(hooks)}`);
  console.log(rows.slice(0, 5).map(r => `${r.symbol}: $${r.week.creatorUsd} (${r.feePct}% fee, ${JSON.stringify(Object.fromEntries(Object.entries(r.week.chains).map(([c, v]) => [c, v.feePct])))})`).join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
