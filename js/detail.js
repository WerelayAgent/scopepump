/* ScopePump — Solana token detail page with dark-glass LightweightCharts. */
(function (PS) {
  const { esc, isNum, price, compact, num, pct, age, short, logo, api, EXPLORER } = PS;
  const INTERVALS = ["1h", "6h", "1d", "1w", "all"];
  let chart = null,
    series = null,
    vol = null,
    bars = [];

  function defaultInterval(L) {
    const a = isNum(L.createdAt) ? Date.now() / 1000 - L.createdAt : 1e9;
    return a < 3600 ? "1h" : a < 6 * 3600 ? "6h" : a < 86400 ? "1d" : a < 7 * 86400 ? "1w" : "all";
  }
  const fmtAxis = (v) => (!isFinite(v) ? "" : Math.abs(v) < 1e-14 ? "0" : price(v, ""));

  function autoscale() {
    if (!bars.length) return null;
    let from = -Infinity,
      to = Infinity;
    const vr = chart && chart.timeScale().getVisibleRange();
    if (vr) {
      from = vr.from;
      to = vr.to;
    }
    let inView = bars.filter((b) => b.time >= from && b.time <= to);
    if (!inView.length) inView = bars;
    const lows = inView.map((b) => Math.min(b.open, b.close)).sort((a, b) => a - b);
    const highs = inView.map((b) => Math.max(b.open, b.close)).sort((a, b) => a - b);
    const cut = inView.length >= 30 ? Math.floor(inView.length * 0.02) : 0;
    let lo = lows[cut],
      hi = highs[highs.length - 1 - cut];
    const last = bars[bars.length - 1];
    if (last && last.time >= from && last.time <= to) {
      lo = Math.min(lo, last.close);
      hi = Math.max(hi, last.close);
    }
    const span = hi - lo > hi * 1e-6 ? hi - lo : Math.abs(hi) * 0.1 || 1e-12;
    return { priceRange: { minValue: Math.max(0, lo - span * 0.3), maxValue: hi + span * 0.08 } };
  }

  function buildChart(box) {
    if (chart) {
      chart.remove();
      chart = null;
    }
    const LW = window.LightweightCharts;
    if (!LW) {
      box.innerHTML = '<div class="empty">Chart library failed to load.</div>';
      return;
    }
    chart = LW.createChart(box, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "rgba(244,246,251,.68)",
        fontFamily: "JetBrains Mono, monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "rgba(255,255,255,.05)" }, horzLines: { color: "rgba(255,255,255,.06)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,.12)", scaleMargins: { top: 0.08, bottom: 0 } },
      timeScale: { borderColor: "rgba(255,255,255,.12)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { priceFormatter: fmtAxis },
    });
    series = chart.addCandlestickSeries({
      upColor: "#14F195",
      downColor: "#ff5c7c",
      borderVisible: false,
      wickUpColor: "#14F195",
      wickDownColor: "#ff5c7c",
      priceFormat: { type: "custom", formatter: fmtAxis, minMove: 1e-12 },
      autoscaleInfoProvider: () => autoscale(),
      priceLineColor: "#14F195",
      priceLineWidth: 1,
    });
    vol = chart.addHistogramSeries({
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      color: "rgba(153,69,255,.35)",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }

  async function loadChart(L, interval, mode, fit) {
    const box = document.getElementById("chart");
    if (!box) return;
    let d;
    try {
      d = await api.chart(L.address, interval, 30000, L);
    } catch (e) {
      console.warn(e.message);
      document.getElementById("chartnote").textContent = "Chart data briefly unavailable.";
      return;
    }
    if (!document.getElementById("chart")) return;
    if (!chart) buildChart(box);
    const c = (d?.candles || []).filter((k) => [k.open, k.high, k.low, k.close].every(isNum));
    if (!c.length) {
      document.getElementById("chartnote").textContent = "No trades yet — nothing to chart.";
      bars = [];
      series.setData([]);
      vol.setData([]);
      return;
    }
    const mult = mode === "mcap" ? L.supply || 1e9 : 1;
    bars = c.map((k) => ({ time: k.time, open: k.open * mult, high: k.high * mult, low: k.low * mult, close: k.close * mult }));
    series.setData(bars);
    vol.setData(c.map((k) => ({ time: k.time, value: isNum(k.volume) ? k.volume : 0, color: k.close >= k.open ? "#14F19544" : "#ff5c7c44" })));
    if (fit) chart.timeScale().fitContent();
    document.getElementById("chartnote").textContent = `${mode === "mcap" ? "Market cap (price × supply)" : "Price"} in USD · ${c.length} ${d.effectiveRange || interval} candles`;
  }

  function tradesHtml(items, L, quoteSym) {
    if (!items || !items.length) return '<div class="empty">No recent swaps indexed yet.</div>';
    const a = L.address.toLowerCase();
    return `<table class="tbl trades"><thead><tr><th>Time</th><th>Type</th><th class="num">USD</th><th class="num">${esc(quoteSym || "SOL")}</th><th class="num hide-sm">${esc(L.symbol)}</th><th class="num">Price</th><th class="hide-sm">Maker</th><th>Tx</th></tr></thead><tbody>${items
      .slice(0, 30)
      .map((t) => {
        const buy = t.kind === "buy",
          tokIsTo = (t.to_token_address || "").toLowerCase() === a;
        const tokAmt = +(tokIsTo ? t.to_token_amount : t.from_token_amount),
          qAmt = +(tokIsTo ? t.from_token_amount : t.to_token_amount);
        const px = +(tokIsTo ? t.price_to_in_usd : t.price_from_in_usd),
          ts = Date.parse(t.block_timestamp) / 1000;
        return `<tr class="${buy ? "buy" : "sell"}"><td class="muted">${age(ts)} ago</td><td><span class="side">${buy ? "Buy" : "Sell"}</span> <span class="muted sm">${esc(t.venue || "")}</span></td>
        <td class="num">${compact(+t.volume_in_usd)}</td><td class="num mono">${num(qAmt, qAmt >= 1000 ? 0 : 4)}</td><td class="num mono hide-sm">${compact(tokAmt, "")}</td>
        <td class="num mono">${price(px)}</td>
        <td class="hide-sm"><a class="mono addr" href="${EXPLORER}/account/${esc(t.tx_from_address)}" target="_blank" rel="noopener">${short(t.tx_from_address)}</a></td>
        <td><a class="ext" href="${EXPLORER}/tx/${esc(t.tx_hash)}" target="_blank" rel="noopener" title="View on Solscan">↗</a></td></tr>`;
      })
      .join("")}</tbody></table>`;
  }

  const row = (k, v) => `<div class="ir"><span>${k}</span><span>${v}</span></div>`;
  const addrCell = (a, kind) =>
    a ? `<a class="mono addr" href="${EXPLORER}/${kind}/${esc(a)}" target="_blank" rel="noopener">${short(a)}</a> <button class="cp" data-cp="${esc(a)}" title="Copy">⧉</button>` : "—";

  function statsHtml(L) {
    const box = (k, v, t = "") => `<div class="kv" ${t ? `title="${esc(t)}"` : ""}><span>${k}</span><b>${v}</b></div>`;
    const buys = L.buys24,
      sells = L.sells24;
    return `
      <div class="pxrow"><div><span class="muted sm">Price USD</span><div class="big mono">${price(L.priceUsd)}</div></div>${isNum(L.priceNative) && L.quote ? `<div><span class="muted sm">Price ${esc(L.quote)}</span><div class="mid mono">${price(L.priceNative, "")}</div></div>` : ""}</div>
      <div class="kvgrid">${box("Liquidity", compact(L.liquidityUsd), "Pool / virtual liquidity")}${box("Market cap", compact(L.marketCapUsd))}${box("Volume 24h", compact(L.volumeUsd))}${box("Trades 24h", num(L.tradeCount))}</div>
      <div class="chg">${[
        ["5M", L.ch5m],
        ["1H", L.ch1],
        ["6H", L.ch6],
        ["24H", L.ch24],
      ]
        .map(([t, val]) => `<div><span>${t}</span><b>${pct(val)}</b></div>`)
        .join("")}</div>
      ${isNum(buys) && isNum(sells) && buys + sells > 0 ? `<div class="bs"><span class="up">${num(buys)} buys</span><div class="bsbar"><i style="width:${((100 * buys) / (buys + sells)).toFixed(1)}%"></i></div><span class="down">${num(sells)} sells</span></div>` : ""}
      ${
        L.graduated
          ? `<div class="gradbox done"><div class="gh"><span>Stage</span><b>Graduated</b></div><div class="muted sm">Graduated from pump.fun to ${esc(L.protocol || "PumpSwap")}.</div></div>`
          : `<div class="gradbox"><div class="gh"><span>Bonding curve</span><b>${isNum(L.progress) ? (L.progress * 100).toFixed(1) + "%" : "—"}</b></div><div class="pbar"><i style="width:${isNum(L.progress) ? Math.min(100, L.progress * 100).toFixed(1) : 0}%"></i></div><div class="muted sm">Trading on the pump.fun bonding curve until $69K migration.</div></div>`
      }
      <div class="info">
        ${row("Contract", addrCell(L.address, "token"))}
        ${L.pairAddress ? row("Pool", addrCell(L.pairAddress, "account")) : ""}
        ${isNum(L.createdAt) ? row("Created", `${PS.dateTime(L.createdAt)} <span class="muted">(${age(L.createdAt)} ago)</span>`) : ""}
        ${row("Supply", num(L.supply))}
        ${L.quote ? row("Pair", `${esc(L.symbol)} / ${esc(L.quote)}`) : ""}
      </div>`;
  }

  async function render(el, addr) {
    el.innerHTML = '<div class="loading">Loading Solana token…</div>';
    const list = await PS.ensureTokens();
    let L = list.find((x) => x.address === addr) || list.find((x) => x.address.toLowerCase() === addr.toLowerCase());
    try {
      const snap = await api.snapshot(addr);
      if (snap) L = L ? Object.assign({}, L, snap) : snap;
    } catch {}
    if (!L) {
      el.innerHTML = `<div class="notfound"><h2>Token not found</h2><p class="muted">${esc(addr)} is not indexed yet on Solana.</p><a class="btn" href="#/">Back to screener</a></div>`;
      return;
    }
    document.title = `${L.symbol} ${price(L.priceUsd)} — ScopePump`;
    let interval = defaultInterval(L),
      mode = "price";
    const links = [
      [L.dexUrl || `https://dexscreener.com/solana/${L.address}`, "DexScreener"],
      [L.pairAddress ? `https://www.geckoterminal.com/solana/pools/${L.pairAddress}` : null, "GeckoTerminal"],
      [L.website, "Website"],
      [L.twitter, "X"],
      [L.telegram, "Telegram"],
    ]
      .filter(([u]) => u && PS.safeHref(u))
      .map(([u, t]) => `<a class="chip" href="${esc(PS.safeHref(u))}" target="_blank" rel="noopener nofollow">${t} ↗</a>`)
      .join("");

    el.innerHTML = `
      <a class="back" href="#/">← Screener</a>
      <section class="dhead">
        <div class="dt">${logo(L, 52)}<div><h1>${esc(L.name)} <span class="muted">${esc(L.symbol)}</span> ${PS.quoteBadge(L)}${PS.offBadge(L)}</h1>
          <div class="sub"><span class="mono">${short(L.address)}</span><button class="cp big" data-cp="${esc(L.address)}" title="Copy mint address">⧉ Copy CA</button>${PS.statusCell(L)}</div></div></div>
        <div class="links">
          <a class="chip pri" href="${PS.tradeUrl(L.address)}" target="_blank" rel="noopener">Buy on pump.fun ↗</a>
          <a class="chip" href="${EXPLORER}/token/${esc(L.address)}" target="_blank" rel="noopener">Solscan ↗</a>
          ${links}
        </div>
      </section>
      <div class="dgrid">
        <div class="dmain">
          <div class="card chartcard">
            <div class="ctool"><div class="seg" id="ivl">${INTERVALS.map((v) => `<button data-i="${v}" class="${v === interval ? "on" : ""}">${v}</button>`).join("")}</div>
              <div class="seg" id="mode"><button data-m="price" class="on">Price</button><button data-m="mcap">MCap</button></div></div>
            <div id="chart" class="chart"></div><div id="chartnote" class="muted sm note"></div>
          </div>
          <div class="card"><div class="ch"><h3>Recent trades</h3><span class="muted sm">Solana swap feed</span></div><div id="trades" class="tblwrap"><div class="empty">Loading trades…</div></div></div>
        </div>
        <aside class="card side" id="stats">${statsHtml(L)}</aside>
      </div>`;

    el.querySelector("#ivl").onclick = (e) => {
      const b = e.target.closest("button[data-i]");
      if (!b) return;
      interval = b.dataset.i;
      el.querySelectorAll("#ivl button").forEach((x) => x.classList.toggle("on", x === b));
      loadChart(L, interval, mode, true);
    };
    el.querySelector("#mode").onclick = (e) => {
      const b = e.target.closest("button[data-m]");
      if (!b) return;
      mode = b.dataset.m;
      el.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("on", x === b));
      loadChart(L, interval, mode, false);
    };

    loadChart(L, interval, mode, true);
    api.trades(L.address, L).then((t) => {
      const box = document.getElementById("trades");
      if (box) box.innerHTML = tradesHtml(t, L, L.quote);
    });

    return () => {
      if (chart) {
        chart.remove();
        chart = null;
      }
      bars = [];
    };
  }
  PS.detailPage = render;
})(window.PS);
