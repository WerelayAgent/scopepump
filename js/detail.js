/* ScopePump — token detail page. */
(function (PS) {
  const { esc, isNum, price, compact, num, pct, age, short, logo, api, EXPLORER } = PS;
  const INTERVALS = ["1h", "6h", "1d", "1w", "all"];
  let chart = null, series = null, vol = null, timers = [], bars = [];

  function defaultInterval(L) { const a = isNum(L.createdAt) ? Date.now() / 1000 - L.createdAt : 1e9; return a < 3600 ? "1h" : a < 6 * 3600 ? "6h" : a < 86400 ? "1d" : a < 7 * 86400 ? "1w" : "all"; }
  const fmtAxis = (v) => (!isFinite(v) ? "" : Math.abs(v) < 1e-14 ? "0" : price(v, ""));

  /* Price-axis autoscale (data itself is never changed):
     - range comes from candle BODIES (open/close) of the bars currently in view, ignoring the most extreme 2% when there are
       30+ bars, so extreme wicks / one-off spikes cannot flatten the chart (they are still drawn, just clipped);
     - the lower bound is padded so candles sit above the volume bars, then clamped at 0 — the axis never shows negative prices. */
  function autoscale() {
    if (!bars.length) return null;
    let from = -Infinity, to = Infinity;
    const vr = chart && chart.timeScale().getVisibleRange();
    if (vr) { from = vr.from; to = vr.to; }
    let inView = bars.filter((b) => b.time >= from && b.time <= to);
    if (!inView.length) inView = bars;
    // Robust range: with enough bars, ignore the most extreme 2% of candle bodies on each side (bad prints / one-off spikes).
    const lows = inView.map((b) => Math.min(b.open, b.close)).sort((a, b) => a - b);
    const highs = inView.map((b) => Math.max(b.open, b.close)).sort((a, b) => a - b);
    const cut = inView.length >= 30 ? Math.floor(inView.length * 0.02) : 0;
    let lo = lows[cut], hi = highs[highs.length - 1 - cut];
    const last = bars[bars.length - 1]; if (last && last.time >= from && last.time <= to) { lo = Math.min(lo, last.close); hi = Math.max(hi, last.close); } // current price always in view
    const span = hi - lo > hi * 1e-6 ? hi - lo : Math.abs(hi) * 0.1 || 1e-12;
    return { priceRange: { minValue: Math.max(0, lo - span * 0.3), maxValue: hi + span * 0.08 } };
  }
  PS._chartDebug = () => chart && series ? { bottom: series.coordinateToPrice(chart.paneSize().height - 1), top: series.coordinateToPrice(0), bars: bars.length } : null;

  function buildChart(box) {
    if (chart) { chart.remove(); chart = null; }
    const LW = window.LightweightCharts; if (!LW) { box.innerHTML = `<div class="empty">Chart library failed to load.</div>`; return; }
    chart = LW.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "rgba(12,21,0,.62)", fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(12,21,0,.05)" }, horzLines: { color: "rgba(12,21,0,.06)" } },
      rightPriceScale: { borderColor: "rgba(12,21,0,.12)", scaleMargins: { top: 0.08, bottom: 0 } }, // bottom 0: nothing is drawn below the clamped minimum, so no negative labels
      timeScale: { borderColor: "rgba(12,21,0,.12)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { priceFormatter: fmtAxis },
    });
    series = chart.addCandlestickSeries({ upColor: "#00b004", downColor: "#f2541b", borderVisible: false, wickUpColor: "#00b004", wickDownColor: "#f2541b", priceFormat: { type: "custom", formatter: fmtAxis, minMove: 1e-12 },
      autoscaleInfoProvider: () => autoscale(), priceLineColor: "#00a804", priceLineWidth: 1 });
    vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, color: "rgba(12,21,0,.12)", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }

  async function loadChart(L, interval, mode, fit) {
    const box = document.getElementById("chart"); if (!box) return;
    let d;
    try { d = await api.chart(L.address, interval); }
    catch (e) { console.warn(e.message); const note = document.getElementById("chartnote"); if (note) note.textContent = "Chart data briefly unavailable."; return; }
    if (!document.getElementById("chart")) return;
    if (!chart) buildChart(box);
    const note = document.getElementById("chartnote");
    const c = (d?.candles || []).filter((k) => [k.open, k.high, k.low, k.close].every(isNum));
    if (!c.length) { if (note) note.textContent = d?.unavailableReason ? `No chart: ${d.unavailableReason}` : "No trades yet — nothing to chart."; bars = []; series.setData([]); vol.setData([]); return; }
    const mult = mode === "mcap" ? (L.supply || 1e9) : 1;
    bars = c.map((k) => ({ time: k.time, open: k.open * mult, high: k.high * mult, low: k.low * mult, close: k.close * mult }));
    series.setData(bars);
    vol.setData(c.map((k) => ({ time: k.time, value: isNum(k.volume) ? k.volume : 0, color: k.close >= k.open ? "#00b00440" : "#f2541b40" })));
    if (fit) chart.timeScale().fitContent();
    if (note) note.textContent = `${mode === "mcap" ? "Market cap (price × supply)" : "Price"} in USD · ${c.length} ${d.effectiveRange || interval} candles · window ${interval}`;
  }

  // GeckoTerminal trade → row (token side vs quote side).
  function tradesHtml(items, L, quoteSym) {
    if (!items) return `<div class="empty">Trades unavailable — this token has no indexed DEX pool yet.</div>`;
    if (!items.length) return `<div class="empty">No trades yet.</div>`;
    const a = L.address.toLowerCase();
    return `<table class="tbl trades"><thead><tr><th>Time</th><th>Type</th><th class="num">USD</th><th class="num">${esc(quoteSym || "Quote")}</th><th class="num hide-sm">${esc(L.symbol)}</th><th class="num">Price</th><th class="hide-sm">Maker</th><th>Tx</th></tr></thead><tbody>${items.slice(0, 50).map((t) => {
      const buy = t.kind === "buy", tokIsTo = (t.to_token_address || "").toLowerCase() === a;
      const tokAmt = +(tokIsTo ? t.to_token_amount : t.from_token_amount), qAmt = +(tokIsTo ? t.from_token_amount : t.to_token_amount);
      const px = +(tokIsTo ? t.price_to_in_usd : t.price_from_in_usd), ts = Date.parse(t.block_timestamp) / 1000;
      return `<tr class="${buy ? "buy" : "sell"}"><td class="muted">${age(ts)} ago</td><td><span class="side">${buy ? "Buy" : "Sell"}</span> <span class="muted sm">${esc(t.venue || "")}</span></td>
      <td class="num">${compact(+t.volume_in_usd)}</td><td class="num mono">${num(qAmt, qAmt >= 1000 ? 0 : 4)}</td><td class="num mono hide-sm">${compact(tokAmt, "")}</td>
      <td class="num mono">${price(px)}</td>
      <td class="hide-sm"><a class="mono addr" href="${EXPLORER}/address/${esc(t.tx_from_address)}" target="_blank" rel="noopener">${short(t.tx_from_address)}</a></td>
      <td><a class="ext" href="${EXPLORER}/tx/${esc(t.tx_hash)}" target="_blank" rel="noopener" title="View on Blockscout">↗</a></td></tr>`; }).join("")}</tbody></table>`;
  }

  const row = (k, v) => `<div class="ir"><span>${k}</span><span>${v}</span></div>`;
  const addrCell = (a, kind) => a ? `<a class="mono addr" href="${EXPLORER}/${kind}/${esc(a)}" target="_blank" rel="noopener">${short(a)}</a> <button class="cp" data-cp="${esc(a)}" title="Copy">⧉</button>` : "—";
  const sig = (s) => (s && s.state === "ok" && s.value != null ? esc(s.value) : null);

  function statsHtml(L, X) {
    const { ds, st, info, sg } = X;
    const box = (k, v, t = "") => `<div class="kv" ${t ? `title="${esc(t)}"` : ""}><span>${k}</span><b>${v}</b></div>`;
    const w = st?.h24; const tx = isNum(L.tradeCount) ? L.tradeCount : null;
    const chg = (k) => isNum(st?.[k]?.priceChangePercent) ? st[k].priceChangePercent / 100 : isNum(ds?.priceChange?.[k]) ? ds.priceChange[k] / 100 : k === "h24" ? L.ch24 : null;
    const liq = isNum(L.liquidityUsd) ? L.liquidityUsd : ds?.liquidity?.usd;
    const vol24 = isNum(L.volumeUsd) ? L.volumeUsd : ds?.volume?.h24;
    const qs = info?.quoteSymbol || L.quote;
    const sp = info?.split; const split = sp ? [["Creator", sp.creatorBps], ["Burn", sp.burnBps], ["Holders", sp.holdersBps], ["Liquidity", sp.liquidityBps]].filter(([, b]) => b > 0).map(([t, b]) => `${t} ${b / 100}%`).join(" · ") : "";
    const buys = w?.buys ?? ds?.txns?.h24?.buys, sells = w?.sells ?? ds?.txns?.h24?.sells;
    return `
      <div class="pxrow"><div><span class="muted sm">Price USD</span><div class="big mono">${price(L.priceUsd)}</div></div>${ds?.priceNative && qs ? `<div><span class="muted sm">Price ${esc(qs)}</span><div class="mid mono">${price(+ds.priceNative, "")}</div></div>` : ""}</div>
      <div class="kvgrid">${L.graduated ? box("Liquidity", compact(liq), "Pool liquidity") : box("Raised", isNum(L.raisedQuote) ? `${num(L.raisedQuote, 4)} ${esc(qs || "")}` : "—", "Raised on the bonding curve")}${box("Market cap", compact(L.marketCapUsd))}${box(L.graduated ? "Volume 24h" : "Volume", compact(vol24))}${box("Trades", num(tx))}</div>
      <div class="chg">${[["5M", "m5"], ["1H", "h1"], ["6H", "h6"], ["24H", "h24"]].map(([t, k]) => `<div><span>${t}</span><b>${pct(chg(k))}</b></div>`).join("")}</div>
      ${isNum(buys) && isNum(sells) && buys + sells > 0 ? `<div class="bs"><span class="up">${num(buys)} buys</span><div class="bsbar"><i style="width:${(100 * buys / (buys + sells)).toFixed(1)}%"></i></div><span class="down">${num(sells)} sells</span></div>` : ""}
      ${L.graduated ? `<div class="gradbox done"><div class="gh"><span>Stage</span><b>Graduated</b></div><div class="muted sm">Left the bonding curve; trades in its pool.</div></div>` : `<div class="gradbox"><div class="gh"><span>Bonding curve</span><b>${isNum(L.progress) ? (L.progress * 100).toFixed(1) + "%" : "—"}</b></div><div class="pbar"><i style="width:${isNum(L.progress) ? Math.min(100, L.progress * 100).toFixed(1) : 0}%"></i></div><div class="muted sm">${isNum(L.raisedQuote) && isNum(L.thresholdQuote) ? `${num(L.raisedQuote, 4)} / ${num(L.thresholdQuote, 2)} ${esc(qs || "")} raised toward graduation` : "Trades on the Pons bonding curve until graduation."}</div></div>`}
      <div class="info">
        ${row("Contract", addrCell(L.address, "token"))}
        ${!L.poolId && ds?.pairAddress ? row("V4 pool ID", `<span class="mono">${short(ds.pairAddress)}</span> <button class="cp" data-cp="${esc(ds.pairAddress)}" title="Copy">⧉</button>`) : ""}
        ${info?.creator ? row("Creator", addrCell(info.creator, "address")) : L.creator ? row("Creator", esc(L.creator)) : ""}
        ${info?.payoutWallet && info.payoutWallet !== info.creator ? row("Payout wallet", addrCell(info.payoutWallet, "address")) : ""}
        ${L.curve ? row("Curve", addrCell(L.curve, "address")) : ""}
        ${L.poolId ? row("V4 pool ID", `<span class="mono">${short(L.poolId)}</span> <button class="cp" data-cp="${esc(L.poolId)}" title="Copy">⧉</button>`) : ""}
        ${isNum(L.createdAt) ? row("Created", `${PS.dateTime(L.createdAt)} <span class="muted">(${age(L.createdAt)} ago)</span>`) : ""}
        ${row("Supply", num(L.supply))}
        ${isNum(L.creatorTaxBps) && L.creatorTaxBps > 0 ? row("Creator tax", `${L.creatorTaxBps / 100}%`) : ""}
        ${split ? row("Tax share to", split) : ""}
        ${isNum(info?.devHoldsPct) ? row("Dev holds", `${num(info.devHoldsPct, 2)}%`) : ""}
        ${sig(sg?.holders) ? row("Holders", sig(sg.holders)) : ""}
        ${sig(sg?.top10) ? row("Top 10 hold", sig(sg.top10)) : ""}
        ${isNum(L.burnedPct) && L.burnedPct > 0 ? row("Burned", `${num(L.burnedPct, 2)}%`) : ""}
        ${qs ? row("Pair", `${esc(L.symbol)} / ${esc(qs)}`) : ""}
      </div>`;
  }

  async function render(el, addr) {
    addr = addr.toLowerCase();
    el.innerHTML = `<div class="loading">Loading token…</div>`;
    const list = await PS.ensureTokens();
    let L = list.find((x) => x.address.toLowerCase() === addr);
    const X = { ds: null, st: null, info: null, sg: null, snap: null };
    try { X.snap = await api.snapshot(addr); } catch {} // fresh Pons launch record (also for tokens outside the list)
    if (X.snap) L = L ? Object.assign(L, X.snap, { ch24: L.ch24 ?? X.snap.ch24 }) : X.snap;
    if (!L) { el.innerHTML = `<div class="notfound"><h2>Not a Pons token</h2><p class="muted">${esc(addr)} is not a Pons launch.</p><a class="btn" href="#/">Back to screener</a></div>`; return; }
    document.title = `${L.symbol} ${price(L.priceUsd)} — ScopePump`;
    let interval = defaultInterval(L), mode = "price";
    el.innerHTML = `
      <a class="back" href="#/">← Screener</a>
      <section class="dhead">
        <div class="dt">${logo(L, 52)}<div><h1>${esc(L.name)} <span class="muted">${esc(L.symbol)}</span> ${PS.quoteBadge(L)}${PS.offBadge(L)}</h1>
          <div class="sub"><span class="mono">${short(L.address)}</span><button class="cp big" data-cp="${esc(L.address)}" title="Copy contract address">⧉ Copy CA</button>${PS.statusCell(L)}</div></div></div>
        <div class="links">
          <a class="chip pri" href="${PS.tradeUrl(L.address)}" target="_blank" rel="noopener">Buy on Pons ↗</a>
          <a class="chip" href="${EXPLORER}/token/${esc(L.address)}" target="_blank" rel="noopener">Blockscout ↗</a>
          <span id="extlinks"></span>
        </div>
      </section>
      <div class="dgrid">
        <div class="dmain">
          <div class="card chartcard">
            <div class="ctool"><div class="seg" id="ivl">${INTERVALS.map((v) => `<button data-i="${v}" class="${v === interval ? "on" : ""}">${v}</button>`).join("")}</div>
              <div class="seg" id="mode"><button data-m="price" class="on">Price</button><button data-m="mcap">MCap</button></div></div>
            <div id="chart" class="chart"></div><div id="chartnote" class="muted sm note"></div>
          </div>
          <div class="card"><div class="ch"><h3>Recent trades</h3><span class="muted sm">auto-refresh 15s</span></div><div id="trades" class="tblwrap"><div class="empty">Loading trades…</div></div></div>
        </div>
        <div class="dside">
          <section class="card tpcard" id="tpanel" aria-label="Buy or sell ${esc(L.symbol)}"></section>
          <aside class="card side" id="stats">${statsHtml(L, X)}</aside>
        </div>
      </div>`;
    el.querySelector("#ivl").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (!b) return; interval = b.dataset.i; el.querySelectorAll("#ivl button").forEach((x) => x.classList.toggle("on", x === b)); loadChart(L, interval, mode, true); };
    el.querySelector("#mode").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (!b) return; mode = b.dataset.m; el.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("on", x === b)); loadChart(L, interval, mode, false); };

    const paint = () => {
      const st = document.getElementById("stats"); if (st) st.innerHTML = statsHtml(L, X);
      const ex = document.getElementById("extlinks"); if (!ex) return;
      const soc = X.snap?.socials || { website: L.website, x: L.twitter, telegram: L.telegram };
      const links = [[X.ds?.url, "DexScreener"], [X.ds?.pairAddress ? `https://www.geckoterminal.com/robinhood/pools/${X.ds.pairAddress}` : null, "GeckoTerminal"], [soc.website, "Website"], [soc.x, "X"], [soc.telegram, "Telegram"]];
      const seen = new Set();
      ex.innerHTML = links.map(([u, t]) => { const h = u && PS.safeHref(u); if (!h || seen.has(h)) return ""; seen.add(h); return `<a class="chip" href="${esc(h)}" target="_blank" rel="${t === "DexScreener" || t === "GeckoTerminal" ? "noopener" : "noopener nofollow"}">${t}${t === "DexScreener" || t === "GeckoTerminal" ? " ↗" : ""}</a>`; }).join("");
    };
    const a = L.address.toLowerCase();
    const loadTrades = async () => {
      const box = () => document.getElementById("trades");
            try { const t = await api.trades(a); if (box()) box().innerHTML = tradesHtml(t, L, X.info?.quoteSymbol || L.quote); }
      catch (e) { console.warn(e.message); if (box() && /Loading/.test(box().textContent)) box().innerHTML = `<div class="empty">Trades briefly unavailable.</div>`; }
    };
    const enrich = async () => {
      const [m, st, info, sg, snap] = await Promise.all([
        L.graduated ? api.dexPairs([a]) : Promise.resolve(new Map()), api.stats(a).catch(() => null), X.info ? X.info : api.launchInfo(a).catch(() => null), api.signals(a).catch(() => null), X.snap ? X.snap : api.snapshot(a).catch(() => null)]);
      X.ds = m.get(a) || X.ds; X.dsTried = true; X.st = st || X.st; X.info = info || X.info; X.sg = sg || X.sg; X.snap = snap || X.snap;
      if (!L.quote && X.info?.quoteSymbol) L.quote = X.info.quoteSymbol;
      paint();
    };
    const refresh = async () => {
      if (document.hidden) return;
      try { const n = await api.snapshot(a); if (n) Object.assign(L, n, { ch24: L.ch24 ?? n.ch24 }); } catch (e) { console.warn(e.message); }
      api.stats(a).then((s) => { if (s) { X.st = s; paint(); } }).catch(() => {});
      document.title = `${L.symbol} ${price(L.priceUsd)} — ScopePump`; paint(); loadChart(L, interval, mode, false);
    };
    const tpOff = PS.SNIPER_LIVE && PS.tradePanel ? PS.tradePanel(el.querySelector("#tpanel"), L) : (el.querySelector("#tpanel").remove(), null);
    buildChart(el.querySelector("#chart"));
    loadChart(L, interval, mode, true);
    enrich().then(loadTrades);
    timers = [setInterval(() => !document.hidden && loadTrades(), 15000), setInterval(refresh, 20000)];
    return () => { timers.forEach(clearInterval); timers = []; tpOff && tpOff(); if (chart) { chart.remove(); chart = null; } };
  }
  PS.detailPage = render;
})(window.PS);
