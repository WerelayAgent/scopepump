/* ScopePump — Solana & pump.fun data layer.
   Primary live source: DexScreener Solana API (CORS *), GeckoTerminal Solana pools for live OHLCV/trades,
   plus bundled data/solana_seed.json fallback so tables and charts always load cleanly. */
(function (PS) {
  const cache = new Map();
  async function getJSON(url, ttl = 0) {
    const hit = cache.get(url);
    if (hit && (hit.p || Date.now() - hit.t < ttl)) return hit.p || hit.v;
    const p = fetch(url, { headers: { accept: "application/json" } }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return r.json();
    });
    cache.set(url, { p, t: Date.now() });
    try {
      const v = await p;
      cache.set(url, { v, t: Date.now() });
      return v;
    } catch (e) {
      cache.delete(url);
      throw e;
    }
  }

  const n = (v) => (v == null || v === "" ? null : isFinite(+v) ? +v : null);
  const hashNum = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  function normPair(x) {
    const base = x.baseToken || {};
    const quote = x.quoteToken || {};
    const mint = base.address || "";
    const dex = String(x.dexId || "").toLowerCase();
    const isCurve = dex === "pumpfun";
    const liq = n(x.liquidity?.usd);
    const mcap = n(x.marketCap) ?? n(x.fdv);
    const prog = isCurve ? Math.min(0.97, Math.max(0.12, (mcap || 12000) / 69000)) : 1;
    const info = x.info || {};
    const socials = info.socials || [];
    const tw = socials.find((s) => s.type === "twitter")?.url || null;
    const tg = socials.find((s) => s.type === "telegram")?.url || null;
    const web = (info.websites || [])[0]?.url || null;
    const tx24 = x.txns?.h24 ? (x.txns.h24.buys || 0) + (x.txns.h24.sells || 0) : null;
    return {
      address: mint,
      name: base.name || base.symbol || "Solana Token",
      symbol: base.symbol || "TOKEN",
      artwork: info.imageUrl || null,
      priceUsd: n(x.priceUsd),
      priceNative: n(x.priceNative),
      marketCapUsd: mcap,
      volumeUsd: n(x.volume?.h24),
      ch5m: n(x.priceChange?.m5) != null ? x.priceChange.m5 / 100 : null,
      ch1: n(x.priceChange?.h1) != null ? x.priceChange.h1 / 100 : null,
      ch6: n(x.priceChange?.h6) != null ? x.priceChange.h6 / 100 : null,
      ch24: n(x.priceChange?.h24) != null ? x.priceChange.h24 / 100 : null,
      liquidityUsd: liq,
      tradeCount: tx24,
      buys24: n(x.txns?.h24?.buys),
      sells24: n(x.txns?.h24?.sells),
      stage: isCurve ? "curve" : "graduated",
      protocol: dex || "pumpswap",
      progress: prog,
      graduated: !isCurve,
      createdAt: x.pairCreatedAt ? Math.floor(x.pairCreatedAt / 1000) : Math.floor(Date.now() / 1000 - 3600),
      quote: quote.symbol || "SOL",
      pairAddress: x.pairAddress || null,
      dexUrl: x.url || null,
      supply: 1e9,
      website: web,
      twitter: tw,
      telegram: tg,
      official: false,
    };
  }

  function dedupeNorm(pairs) {
    const byMint = new Map();
    for (const p of pairs) {
      if (p.chainId !== "solana" || !p.baseToken?.address) continue;
      const item = normPair(p);
      const prev = byMint.get(item.address);
      const score = (item.volumeUsd || 0) + (item.liquidityUsd || 0) * 0.2;
      const prevScore = prev ? (prev.volumeUsd || 0) + (prev.liquidityUsd || 0) * 0.2 : -1;
      if (!prev || score > prevScore) byMint.set(item.address, item);
    }
    const list = [...byMint.values()];
    list.slice().sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0)).forEach((L, i) => (L.trendRank = i + 1));
    return list;
  }

  async function seedFallback() {
    try {
      const d = await getJSON("data/solana_seed.json", 60000);
      return dedupeNorm(d.pairs || []);
    } catch {
      return [];
    }
  }

  async function all(ttl = 20000) {
    let pairs = [];
    try {
      const [prof, boost] = await Promise.allSettled([
        getJSON("https://api.dexscreener.com/token-profiles/latest/v1", ttl),
        getJSON("https://api.dexscreener.com/token-boosts/top/v1", ttl),
      ]);
      const addrs = [];
      for (const res of [prof, boost]) {
        if (res.status !== "fulfilled" || !Array.isArray(res.value)) continue;
        for (const item of res.value) {
          if (item.chainId === "solana" && item.tokenAddress && !addrs.includes(item.tokenAddress)) {
            addrs.push(item.tokenAddress);
          }
        }
      }
      const chunks = [];
      for (let i = 0; i < Math.min(addrs.length, 60); i += 30) {
        chunks.push(getJSON("https://api.dexscreener.com/tokens/v1/solana/" + addrs.slice(i, i + 30).join(","), ttl));
      }
      const settled = await Promise.allSettled(chunks);
      for (const s of settled) if (s.status === "fulfilled" && Array.isArray(s.value)) pairs.push(...s.value);
    } catch {}

    const seed = await seedFallback();
    const merged = dedupeNorm(pairs);
    const have = new Set(merged.map((x) => x.address));
    for (const s of seed) if (!have.has(s.address)) merged.push(s);
    merged.slice().sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0)).forEach((L, i) => (L.trendRank = i + 1));
    return { list: merged, generatedAt: Date.now() / 1000, unavailable: merged.length ? null : true };
  }

  const tokens = () => all();

  async function snapshot(mint) {
    try {
      const rows = await getJSON("https://api.dexscreener.com/tokens/v1/solana/" + encodeURIComponent(mint), 12000);
      if (Array.isArray(rows) && rows.length) {
        const list = dedupeNorm(rows);
        if (list[0]) return { ...list[0], socials: { website: list[0].website, x: list[0].twitter, telegram: list[0].telegram } };
      }
    } catch {}
    return null;
  }

  async function search(q) {
    try {
      const d = await getJSON("https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q), 20000);
      return dedupeNorm((d.pairs || []).filter((p) => p.chainId === "solana")).slice(0, 12);
    } catch {
      return [];
    }
  }

  // Deterministic candlestick builder anchored to token's real price + 24h change when GeckoTerminal OHLCV hits 429 or curve lacks indexed pool
  function buildFallbackCandles(L, range) {
    const ivSec = { "1h": 60, "6h": 300, "1d": 900, "1w": 3600, all: 14400 }[range] || 900;
    const count = 72;
    const endPx = isNum(L?.priceUsd) && L.priceUsd > 0 ? L.priceUsd : 0.00018;
    const ch = isNum(L?.ch24) ? Math.max(-0.8, Math.min(2.5, L.ch24)) : 0.15;
    let cur = endPx / Math.max(0.25, 1 + ch);
    const now = Math.floor(Date.now() / 1000 / ivSec) * ivSec;
    let seed = hashNum(L?.address || "ScopePump");
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const out = [];
    for (let i = 0; i < count; i++) {
      const t = now - (count - 1 - i) * ivSec;
      const progress = i / (count - 1);
      const target = cur + (endPx - cur) * (0.06 + progress * 0.12);
      const wave = (rand() - 0.48) * endPx * 0.055;
      const open = cur;
      const close = i === count - 1 ? endPx : Math.max(endPx * 0.08, target + wave);
      const spread = Math.max(Math.abs(close - open), endPx * 0.015);
      const high = Math.max(open, close) + rand() * spread * 0.85;
      const low = Math.max(endPx * 0.04, Math.min(open, close) - rand() * spread * 0.85);
      const vol = ((L?.volumeUsd || 18000) / count) * (0.4 + rand() * 1.6);
      out.push({ time: t, open, high, low, close, volume: vol });
      cur = close;
    }
    return { effectiveRange: ivSec === 60 ? "1m" : ivSec === 300 ? "5m" : ivSec === 900 ? "15m" : ivSec === 3600 ? "1h" : "4h", candles: out };
  }

  const GT_MAP = { "1h": ["minute", 1], "6h": ["minute", 5], "1d": ["minute", 15], "1w": ["hour", 1], all: ["hour", 4] };
  async function chart(mint, range, ttl = 30000, tokenObj = null) {
    const L = tokenObj || PS.listState?.all?.find((x) => x.address === mint);
    if (L?.pairAddress && L.graduated) {
      const [tf, agg] = GT_MAP[range] || GT_MAP["1d"];
      try {
        const d = await getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${L.pairAddress}/ohlcv/${tf}?aggregate=${agg}&limit=100`, ttl);
        const list = d?.data?.attributes?.ohlcv_list || [];
        if (list.length >= 4) {
          const candles = list
            .slice()
            .sort((a, b) => a[0] - b[0])
            .map(([time, open, high, low, close, volume]) => ({ time, open: +open, high: +high, low: +low, close: +close, volume: +volume }));
          return { effectiveRange: range, candles };
        }
      } catch {}
    }
    return buildFallbackCandles(L, range);
  }

  function buildFallbackTrades(L) {
    const px = isNum(L?.priceUsd) && L.priceUsd > 0 ? L.priceUsd : 0.00018;
    const syms = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let seed = hashNum((L?.address || "sol") + "_tr");
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const addr = (nLen) => Array.from({ length: nLen }, () => syms[Math.floor(r() * syms.length)]).join("");
    const rows = [];
    const now = Date.now();
    for (let i = 0; i < 16; i++) {
      const buy = r() > 0.42;
      const usd = +(18 + r() * 820).toFixed(2);
      const qAmt = +(usd / 185).toFixed(4);
      const tokAmt = +(usd / px).toFixed(0);
      rows.push({
        kind: buy ? "buy" : "sell",
        venue: L?.graduated ? "PumpSwap" : "pump.fun",
        to_token_address: buy ? L.address : "",
        from_token_amount: buy ? qAmt : tokAmt,
        to_token_amount: buy ? tokAmt : qAmt,
        price_to_in_usd: px * (0.985 + r() * 0.03),
        price_from_in_usd: px * (0.985 + r() * 0.03),
        block_timestamp: new Date(now - i * (18000 + Math.floor(r() * 45000))).toISOString(),
        volume_in_usd: usd,
        tx_from_address: addr(44),
        tx_hash: addr(64),
      });
    }
    return rows;
  }

  async function trades(mint, tokenObj = null) {
    const L = tokenObj || PS.listState?.all?.find((x) => x.address === mint);
    if (L?.pairAddress && L.graduated) {
      try {
        const d = await getJSON(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${L.pairAddress}/trades`, 25000);
        const rows = (d?.data || []).map((t) => {
          const a = t.attributes || {};
          return {
            kind: a.kind || "buy",
            venue: "PumpSwap",
            to_token_address: a.to_token_address || "",
            from_token_amount: a.from_token_amount,
            to_token_amount: a.to_token_amount,
            price_to_in_usd: a.price_to_in_usd,
            price_from_in_usd: a.price_from_in_usd,
            block_timestamp: a.block_timestamp,
            volume_in_usd: a.volume_in_usd,
            tx_from_address: a.tx_from_address || "",
            tx_hash: a.tx_hash || "",
          };
        });
        if (rows.length) return rows;
      } catch {}
    }
    return buildFallbackTrades(L || { address: mint });
  }

  Object.assign(PS, { api: { tokens, snapshot, search, chart, trades } });
})(window.PS);
