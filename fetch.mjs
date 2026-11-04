// Haalt dagelijks de slotkoersen (Revolut X) en wekelijks de volumes (CoinGecko) op
// en bewaart ze in data/*.json. Draait automatisch via GitHub Actions. Geen API-sleutels nodig.
import fs from 'node:fs';

const DAY = 86400000;
const today = Math.floor(Date.now() / DAY);          // dagindex (UTC); de kaars van vandaag is nog niet af
const REVX = 'https://revx.revolut.com/api/1.0/public';
const CG = 'https://api.coingecko.com/api/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const prices = read('data/prices.json'), volumes = read('data/volumes.json'), meta = read('data/meta.json');
const log = [];

async function getJSON(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'trendbot-data/1.0' } });
      if (r.status === 429) { await sleep(65000); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (t === tries - 1) throw e; await sleep(5000 * (t + 1)); }
  }
}

// ---- 1. slotkoersen ----
async function closesFrom(sym, fromDay) {
  const out = await getJSON(`${REVX}/candles/${sym}-USD?interval=1440&region=EEA&since=${(fromDay - 5) * DAY}&until=${today * DAY}`);
  const m = new Map((out.data || []).map(x => [Math.floor(x.start / DAY), +x.close]));
  let last = null; for (let d = fromDay - 5; d < fromDay; d++) if (m.has(d)) last = m.get(d);
  const arr = []; for (let d = fromDay; d < today; d++) { if (m.has(d)) last = m.get(d); if (last == null) break; arr.push(+last.toPrecision(7)); }
  return arr;
}
let nPrice = 0;
for (const s of Object.keys(prices)) {
  const p = prices[s], next = p.d0 + p.c.length;
  if (next >= today) continue;
  try { const add = await closesFrom(s, next); p.c.push(...add); nPrice += add.length ? 1 : 0; }
  catch (e) { log.push(`koers ${s}: ${e.message}`); }
  await sleep(1100);                                  // Revolut X: max 1 verzoek per seconde
}

// ---- 2. spreads ----
try {
  const tk = (await getJSON(`${REVX}/tickers?region=EEA`)).data || [];
  for (const s of Object.keys(prices)) { const t = tk.find(x => x.symbol === s + '/USD'); if (t && +t.mid > 0) meta.spreads[s] = Math.min(0.01, +(((+t.ask - +t.bid) / 2 / +t.mid).toFixed(6))); }
} catch (e) { log.push('spreads: ' + e.message); }

// ---- 3. volumes (maandag, 1e-3e van de maand, of als ze >7 dagen achterlopen) ----
const dt = new Date(today * DAY), dom = dt.getUTCDate(), dow = dt.getUTCDay();
const volLag = Math.max(...Object.values(volumes).map(v => today - (v.d0 + v.v.length)));
async function volsFrom(id, fromDay) {
  const days = Math.min(365, today - fromDay + 3);
  const d = await getJSON(`${CG}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`, 6);
  const m = new Map(); for (const v of d.total_volumes) m.set(Math.floor(v[0] / DAY), Math.round(v[1]));
  let last = null; for (let x = fromDay - 3; x < fromDay; x++) if (m.has(x)) last = m.get(x);
  const arr = []; for (let x = fromDay; x <= today; x++) { if (m.has(x)) last = m.get(x); if (last == null) break; arr.push(last); }
  return arr;
}
let nVol = 0;
if (dow === 1 || dom <= 3 || volLag > 7 || process.env.FORCE_VOLUMES) {
  for (const s of Object.keys(volumes)) {
    const v = volumes[s], next = v.d0 + v.v.length, id = meta.cgIds[s];
    if (!id || next > today) continue;
    try { const add = await volsFrom(id, next); v.v.push(...add); nVol++; } catch (e) { log.push(`volume ${s}: ${e.message}`); }
    await sleep(13000);                               // CoinGecko gratis: rustig aan
  }
}

// ---- 4. nieuwe munten (1e-3e van de maand) ----
const EXCL = new Set('USDT USDC DAI USDE FDUSD PYUSD USD1 USDG USDS RLUSD TUSD USDD EURC GHO FRAX LUSD CRVUSD USD0 BUSD U XAUT PAXG WBTC WETH STETH WSTETH CBBTC WEETH RETH BTCB LBTC SOLVBTC SUSDE SUSDS USDTB USDF BFUSD'.split(' '));
let added = [];
if (dom <= 3 || process.env.FORCE_NEWCOINS) {
  try {
    const pairs = await getJSON(`${REVX}/configuration/pairs?region=EEA`);
    const rev = new Set(Object.values(pairs).filter(p => p.quote === 'USD' && p.status === 'active').map(p => p.base.toUpperCase()));
    await sleep(1100);
    const mk = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1`);
    const cand = mk.filter(x => rev.has(x.symbol.toUpperCase()) && !EXCL.has(x.symbol.toUpperCase()) && !/usd|eur|wrapped|staked|bridged/i.test(x.name)).slice(0, 30);
    for (const c of cand) {
      const s = c.symbol.toUpperCase(); if (prices[s]) continue;
      await sleep(1100);
      const a = await getJSON(`${REVX}/candles/${s}-USD?interval=1440&region=EEA`);
      const m = new Map(); for (const x of a.data || []) { const d = Math.floor(x.start / DAY); if (d < today) m.set(d, +x.close); }
      const ds = [...m.keys()].sort((x, y) => x - y); if (!ds.length) continue;
      let start = ds[0]; for (let k = 1; k < ds.length; k++) if (ds[k] - ds[k - 1] > 6) start = ds[k];
      if (today - start < 365) continue;              // regel uit de paper: minstens 365 dagen genoteerd
      const closes = []; let last = null; for (let d = start; d < today; d++) { if (m.has(d)) last = m.get(d); closes.push(+last.toPrecision(7)); }
      await sleep(13000);
      const vd = await getJSON(`${CG}/coins/${c.id}/market_chart?vs_currency=usd&days=365&interval=daily`, 6);
      const vm = new Map(); for (const v of vd.total_volumes) vm.set(Math.floor(v[0] / DAY), Math.round(v[1]));
      const vds = [...vm.keys()].sort((x, y) => x - y); const vv = []; let lv = vm.get(vds[0]);
      for (let d = vds[0]; d <= vds[vds.length - 1]; d++) { if (vm.has(d)) lv = vm.get(d); vv.push(lv); }
      prices[s] = { d0: start, c: closes }; volumes[s] = { d0: vds[0], v: vv }; meta.cgIds[s] = c.id;
      const pr = pairs[s + '/USD']; meta.steps[s] = pr ? +pr.base_step : 1e-8;
      added.push(s);
    }
  } catch (e) { log.push('nieuwe munten: ' + e.message); }
}

// ---- 5. opslaan ----
const btcLast = prices.BTC ? new Date((prices.BTC.d0 + prices.BTC.c.length) * DAY).toISOString().slice(0, 10) : '?';
meta.updatedAt = new Date().toISOString();
meta.lastClose = btcLast;                             // datum waarop de laatste complete dagkaars sloot (00:00 UTC)
meta.log = [`${meta.updatedAt}: koersen ${nPrice} munten, volumes ${nVol}, nieuw: ${added.join(',') || '-'}${log.length ? ' | fouten: ' + log.join('; ') : ''}`, ...(meta.log || [])].slice(0, 30);
fs.writeFileSync('data/prices.json', JSON.stringify(prices));
fs.writeFileSync('data/volumes.json', JSON.stringify(volumes));
fs.writeFileSync('data/meta.json', JSON.stringify(meta, null, 1));
console.log(meta.log[0]);
if (nPrice === 0 && Object.values(prices).some(p => p.d0 + p.c.length < today)) { console.error('Geen enkele koers opgehaald.'); process.exit(1); }
