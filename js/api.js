/* ScopePump — data layer. Source: Pons (https://ponsfamily.com), the same API the ponsfamily.com front end calls.
   Pons sends no CORS headers, so it is reached same-origin:
     /api/pons                       every graduated token + top/new/active/near-graduation curve tokens, with 24h change (api/pons.js)
     /papi/{a}                       one launch (vercel.json rewrite -> ponsfamily.com/api/launches/{a})
     /papi/{a}?view=candles&interval 1m|5m|15m|1h|4h|1d, OHLC in the quote asset
     /papi/{a}?view=trades           recent curve/pool trades
     /psearch?q=                     Pons search (name, symbol, address)
   DexScreener (CORS *) adds 5m/1h/6h change and pool liquidity for graduated tokens when it has a pair. */
(function (PS) {
  const cache = new Map();
  async function getJSON(url, ttl = 0) {
    const hit = cache.get(url);
    if (hit && (hit.p || Date.now() - hit.t < ttl)) return hit.p || hit.v;
    const once = () => fetch(url, { headers: { accept: "application/json" } }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return r.json(); });
    const p = once().catch(() => new Promise((ok) => setTimeout(ok, 900)).then(once));
    cache.set(url, { p, t: Date.now() });
    try { const v = await p; cache.set(url, { v, t: Date.now() }); return v; } catch (e) { cache.delete(url); throw e; }
  }
  const n = (v) => (v == null || v === "" ? null : isFinite(+v) ? +v : null);
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  function norm(x) {
    const grad = x.stage === "graduated";
    return {
      address: (x.address || "").toLowerCase(), name: x.name || x.symbol || "", symbol: x.symbol || "", artwork: x.artwork || null,
      priceUsd: n(x.priceUsd), priceQuote: n(x.priceQuote), marketCapUsd: n(x.marketCapUsd), volumeUsd: n(x.volumeUsd),
      ch24: n(x.change24h) ?? (n(x.lastTradeAt) && n(x.lastTradeAt) < Date.now() / 1000 - 86400 ? 0 : null), liquidityUsd: null, tx24: null, tradeCount: n(x.tradeCount), stage: x.stage, protocol: x.protocol,
      progress: grad ? 1 : n(x.progress), graduated: grad, createdAt: n(x.createdAt), lastTradeAt: n(x.lastTradeAt), graduatedAt: n(x.graduatedAt),
      quote: x.quote?.symbol || null, quoteUsd: n(x.quoteUsd), raisedQuote: n(x.raisedQuote), thresholdQuote: n(x.thresholdQuote),
      pool: x.pool, poolId: x.poolId, curve: x.curve, factory: x.factory, deployer: x.deployer, supply: n(x.totalSupply) || 1e9,
      creatorTaxBps: n(x.creatorTaxBps), website: x.socials?.website || null, twitter: x.socials?.twitter || null, telegram: x.socials?.telegram || null,
      description: x.description || "", official: false,
    };
  }
  async function all(ttl = 10000) {
    let d;
    try { d = await getJSON(`/api/pons`, ttl); } catch { d = await getJSON(`data/pons_seed.json`, 60000); }
    const list = (d.items || []).map(norm);
    list.slice().sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0)).forEach((L, i) => (L.trendRank = i + 1));
    return { list, generatedAt: n(d.asOf), unavailable: null };
  }
  const tokens = () => all();
  const raw = (a) => getJSON(`/papi/${a}`, 10000).catch(() => (PS.listState?.all || []).find((x) => x.address === a.toLowerCase()) || null);
  const one = (a) => (ADDR.test(a) ? raw(a).then((d) => (d?.address ? norm(d) : null)) : Promise.resolve(null));
  const snapshot = (a) => one(a).then((L) => L && { ...L, socials: { website: L.website, x: L.twitter, telegram: L.telegram } });
  const stats = async () => null;
  const signals = async () => null;
  const launchInfo = (a) => one(a).then((L) => L && { pons: true, creator: L.deployer, quoteSymbol: L.quote, buyTaxBps: L.creatorTaxBps });
  async function search(q) {
    const d = await getJSON(`/psearch?q=${encodeURIComponent(q)}&limit=8`, 30000);
    return (d.items || []).map(norm);
  }
  // Range -> Pons candle interval + window length. Candles are in the quote asset; converted with the current quote USD price.
  const WIN = { "1h": ["1m", 3600], "6h": ["5m", 21600], "1d": ["15m", 86400], "1w": ["1h", 604800], all: ["4h", Infinity] };
  async function chart(a, range, ttl = 10000) {
    const [iv, span] = WIN[range] || WIN["1d"];
    const [c, t] = await Promise.all([getJSON(`/papi/${a}?view=candles&interval=${iv}&limit=1000`, ttl).catch(() => []), raw(a)]);
    const q = n(t?.quoteUsd) || 0; const from = Date.now() / 1000 - span;
    let rows = (Array.isArray(c) ? c : c?.items || []).filter((k) => k.time >= from);
    if (range === "all" && rows.length < 20) rows = (await getJSON(`/papi/${a}?view=candles&interval=15m&limit=1000`, ttl).catch(() => [])) || [];
    return { effectiveRange: range === "all" && rows.length && rows[1] && rows[1].time - rows[0].time === 900 ? "15m" : iv,
      candles: rows.map((k) => ({ time: k.time, open: k.open * q, high: k.high * q, low: k.low * q, close: k.close * q, volume: (k.volumeQuote || 0) * q })) };
  }
  // Recent trades, mapped to the row shape tradesHtml() expects.
  async function trades(a) {
    const [d, t] = await Promise.all([getJSON(`/papi/${a}?view=trades`, 12000).catch(() => ({ items: [] })), raw(a)]);
    const q = n(t?.quoteUsd) || 0;
    return (d.items || []).map((x) => {
      const buy = x.side === "buy";
      return { kind: x.side, venue: x.venue === "curve" ? "curve" : x.venue || "", to_token_address: buy ? a : "", from_token_amount: buy ? x.quoteAmount : x.tokenAmount, to_token_amount: buy ? x.tokenAmount : x.quoteAmount,
        price_to_in_usd: x.price * q, price_from_in_usd: x.price * q, block_timestamp: new Date(x.timestamp * 1000).toISOString(), volume_in_usd: x.quoteAmount * q, tx_from_address: x.trader, tx_hash: x.txHash };
    });
  }
  async function dexPairs(addrs) {
    const out = new Map(); const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))];
    for (let i = 0; i < uniq.length; i += 30) { const c = uniq.slice(i, i + 30);
      try { for (const p of (await getJSON(`https://api.dexscreener.com/tokens/v1/robinhood/${c.join(",")}`, 20000)) || []) {
        const a = p.baseToken?.address?.toLowerCase(); if (!a || !c.includes(a)) continue; const cur = out.get(a);
        if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) out.set(a, p); } } catch (e) { console.warn("DexScreener unavailable", e.message); } }
    return out;
  }
  Object.assign(PS, { api: { tokens, snapshot, stats, signals, launchInfo, chart, dexPairs, trades, search, one } });
})(window.PS);
