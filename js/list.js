/* ScopePump — Solana & pump.fun screener page. */
(function (PS) {
  const { esc, isNum, price, compact, num, pct, age, logo, api } = PS;

  const TABS = [
    { id: "top", label: "Top", hint: "Highest market cap" },
    { id: "trending", label: "Volume", hint: "Highest 24h volume" },
    { id: "new", label: "New", hint: "Newest launches first" },
    { id: "gainers", label: "Gainers", hint: "Biggest 24h gainers" },
    { id: "graduating", label: "Near graduation", hint: "pump.fun bonding-curve tokens closest to graduating" },
    { id: "graduated", label: "Graduated", hint: "Tokens graduated to PumpSwap / Raydium" },
  ];
  const PAIRS = [
    ["all", "All"],
    ["sol", "SOL"],
    ["usdc", "USDC / USD1"],
    ["curve", "Bonding curve"],
  ];
  const pairOf = (L) => {
    const q = (L.quote || "").toUpperCase();
    return q === "USDC" || q === "USD1" || q === "USDT" ? "usdc" : "sol";
  };

  const COLS = [
    { k: "rank", t: "#", cls: "c-rank", sort: false },
    { k: "token", t: "Token", cls: "c-token", sort: "name" },
    { k: "price", t: "Price", cls: "num", sort: "price" },
    { k: "age", t: "Age", cls: "num hide-sm", sort: "age" },
    { k: "tx", t: "Trades", cls: "num hide-md", sort: "tx", title: "24h trades" },
    { k: "vol", t: "Volume", cls: "num", sort: "vol", title: "24h volume" },
    { k: "m5", t: "5M", cls: "num hide-md", sort: "m5" },
    { k: "h1", t: "1H", cls: "num", sort: "h1" },
    { k: "h6", t: "6H", cls: "num hide-md", sort: "h6" },
    { k: "h24", t: "24H", cls: "num", sort: "h24" },
    { k: "liq", t: "Liquidity", cls: "num", sort: "liq", title: "Pool liquidity" },
    { k: "mcap", t: "MCap", cls: "num", sort: "mcap" },
    { k: "status", t: "Stage", cls: "c-status", sort: "progress", title: "pump.fun bonding curve or graduated pool" },
  ];

  const PAGE = 100;
  function metrics(L) {
    return {
      ch: { m5: L.ch5m, h1: L.ch1, h6: L.ch6, h24: L.ch24 },
      tx: isNum(L.tradeCount) ? L.tradeCount : null,
      liq: isNum(L.liquidityUsd) ? L.liquidityUsd : null,
      vol: isNum(L.volumeUsd) ? L.volumeUsd : null,
    };
  }
  PS.metrics = metrics;

  function statusCell(L) {
    return L.graduated
      ? `<span class="tag grad">Graduated</span>`
      : `<span class="tag">Curve${isNum(L.progress) ? " " + Math.round(L.progress * 100) + "%" : ""}</span>`;
  }
  const quoteBadge = (L) =>
    L.quote ? `<span class="ver ${/^W?SOL$/.test(L.quote) ? "v1" : "v2"}" title="Paired with ${esc(L.quote)}">${esc(L.quote)}</span>` : "";
  const offBadge = (L) => (L.official ? '<span class="tag off" title="Official ScopePump token">official</span>' : "");
  Object.assign(PS, { statusCell, quoteBadge, offBadge });

  const state = { tab: "top", pair: "all", q: "", sortKey: null, sortDir: -1, all: [], shown: PAGE, live: true, loading: false, err: "" };
  PS.listState = state;
  let countdown = null,
    renderPending = false,
    root = null;

  function matchQ(L, q) {
    if (!q) return true;
    const s = q.toLowerCase();
    return L.address.toLowerCase() === s || L.symbol.toLowerCase().includes(s) || L.name.toLowerCase().includes(s) || (s.length >= 6 && L.address.toLowerCase().includes(s));
  }
  PS.searchTokens = (q) =>
    state.all.filter((L) => matchQ(L, q)).sort((a, b) => (b.symbol.toLowerCase() === q.toLowerCase()) - (a.symbol.toLowerCase() === q.toLowerCase()) || (b.marketCapUsd || 0) - (a.marketCapUsd || 0));

  function filtered() {
    let r = state.all.filter((L) => matchQ(L, state.q));
    if (state.pair === "curve") r = r.filter((L) => !L.graduated);
    else if (state.pair !== "all") r = r.filter((L) => pairOf(L) === state.pair);
    const by = (f) => (a, b) => {
      const x = f(a),
        y = f(b);
      return (x == null) - (y == null) || (y ?? 0) - (x ?? 0);
    };
    switch (state.tab) {
      case "top":
        r.sort(by((L) => L.marketCapUsd));
        break;
      case "new":
        r.sort(by((L) => L.createdAt));
        break;
      case "gainers":
        r = r.filter((L) => (L.volumeUsd || 0) > 0 && isNum(L.ch24));
        r.sort(by((L) => L.ch24));
        break;
      case "graduating":
        r = r.filter((L) => !L.graduated);
        r.sort(by((L) => L.progress));
        break;
      case "graduated":
        r = r.filter((L) => L.graduated);
        r.sort(by((L) => L.marketCapUsd));
        break;
      default:
        r.sort((a, b) => a.trendRank - b.trendRank);
    }
    return r;
  }

  function sortVal(L, k) {
    const m = metrics(L);
    switch (k) {
      case "name":
        return (L.symbol || "").toLowerCase();
      case "price":
        return L.priceUsd;
      case "age":
        return isNum(L.createdAt) ? -L.createdAt : null;
      case "tx":
        return m.tx;
      case "vol":
        return m.vol;
      case "liq":
        return m.liq;
      case "mcap":
        return L.marketCapUsd;
      case "m5":
        return m.ch.m5;
      case "h1":
        return m.ch.h1;
      case "h6":
        return m.ch.h6;
      case "h24":
        return m.ch.h24;
      case "progress":
        return L.graduated ? 2 : L.progress;
    }
  }

  function rows() {
    const r = filtered();
    if (state.sortKey) {
      const k = state.sortKey,
        d = state.sortDir;
      r.sort((a, b) => {
        const x = sortVal(a, k),
          y = sortVal(b, k);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * d;
      });
    }
    return r;
  }

  function rowHtml(L, i) {
    const m = metrics(L);
    return `<tr data-a="${esc(L.address)}" tabindex="0">
      <td class="c-rank">${i + 1}</td>
      <td class="c-token"><a href="#/token/${esc(L.address)}" class="tok">${logo(L, 30)}<span class="tn"><span class="l1"><b>${esc(L.symbol)}</b>${quoteBadge(L)}${offBadge(L)}</span><span class="l2">${esc(L.name)}</span></span></a></td>
      <td class="num mono">${price(L.priceUsd)}</td>
      <td class="num hide-sm">${age(L.createdAt)}</td>
      <td class="num hide-md">${num(m.tx)}</td>
      <td class="num">${compact(m.vol)}</td>
      <td class="num hide-md">${pct(m.ch.m5)}</td><td class="num">${pct(m.ch.h1)}</td><td class="num hide-md">${pct(m.ch.h6)}</td><td class="num">${pct(m.ch.h24)}</td>
      <td class="num">${compact(m.liq)}</td>
      <td class="num">${compact(L.marketCapUsd)}</td>
      <td class="c-status">${statusCell(L)}</td></tr>`;
  }

  function renderTable() {
    renderPending = false;
    const box = root?.querySelector("#tbl");
    if (!box) return;
    const all = rows();
    const vis = all.slice(0, state.shown);
    const head = COLS.map(
      (c) =>
        `<th class="${c.cls}${c.sort ? " sortable" : ""}${state.sortKey === c.sort ? " on" : ""}" ${c.sort ? `data-s="${c.sort}"` : ""} ${c.title ? `title="${esc(c.title)}"` : ""}>${c.t}${state.sortKey === c.sort && c.sort ? (state.sortDir < 0 ? " ↓" : " ↑") : ""}</th>`
    ).join("");
    const body = vis.length
      ? vis.map(rowHtml).join("")
      : `<tr><td colspan="${COLS.length}" class="empty">${state.loading ? "Loading Solana & pump.fun tokens…" : state.err ? esc(state.err) : "No tokens match."}</td></tr>`;
    box.innerHTML = `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    root.querySelector("#more").hidden = all.length <= state.shown;
    root.querySelector("#count").textContent = all.length ? `Showing ${vis.length} of ${all.length} tokens` : "";
  }
  const scheduleRender = () => {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(renderTable);
    }
  };

  async function load(reset) {
    state.loading = true;
    state.err = "";
    if (reset && !state.all.length) scheduleRender();
    try {
      const d = await api.tokens();
      state.all = d.list;
      if (d.unavailable && !d.list.length) state.err = "Solana token feed is briefly unavailable.";
      heroStats(d);
      PS.ticker(d.list.slice(0, 10));
    } catch (e) {
      console.warn(e);
      state.err = "Solana data is briefly unavailable — retrying on next refresh.";
    }
    state.loading = false;
    renderTable();
  }

  function startLive() {
    clearInterval(countdown);
    const el0 = root?.querySelector("#livet");
    if (!state.live) {
      if (el0) el0.textContent = "paused";
      return;
    }
    let left = 20;
    const tick = () => {
      const el = root?.querySelector("#livet");
      if (el) el.textContent = `${left}s`;
    };
    tick();
    countdown = setInterval(() => {
      left--;
      if (left <= 0) {
        left = 20;
        if (!document.hidden) load(false);
      }
      tick();
    }, 1000);
  }

  function heroStats(d) {
    const el = root?.querySelector("#hstats");
    if (!el) return;
    const L = d.list,
      now = Date.now() / 1000;
    const d24 = L.filter((x) => x.createdAt > now - 86400).length;
    const newest = L.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    el.innerHTML = `
      <div class="stat"><span>Tokens tracked</span><b>${num(L.length)}</b></div>
      <div class="stat"><span>Launched 24h</span><b>${num(d24)}</b></div>
      <div class="stat"><span>Graduated</span><b>${num(L.filter((x) => x.graduated).length)}</b></div>
      <div class="stat"><span>Latest launch</span><b>${newest ? `<a href="#/token/${esc(newest.address)}">${esc(newest.symbol)}</a> · ${age(newest.createdAt)} ago` : "—"}</b></div>`;
  }

  function render(el, params) {
    root = el;
    state.tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "top";
    state.pair = PAIRS.some(([v]) => v === params.get("pair")) ? params.get("pair") : "all";
    state.q = (params.get("q") || "").trim().slice(0, 64);
    state.sortKey = null;
    state.shown = PAGE;
    document.getElementById("q").value = state.q;
    const link = (o) => {
      const p = new URLSearchParams({ tab: state.tab, pair: state.pair, q: state.q, ...o });
      for (const [k, v] of [...p]) if (!v || v === "all" || (k === "tab" && v === "top")) p.delete(k);
      return "#/" + (p.toString() ? "?" + p : "");
    };
    el.innerHTML = `
      <section class="hero"><div><h1>ScopePump</h1><p>Tokens launched on <a href="https://pump.fun/" target="_blank" rel="noopener">pump.fun</a> on Solana: live prices, market cap, volume, trades and charts.</p></div>
        <div class="stats" id="hstats"></div></section>
      <div class="toolbar">
        <nav class="tabs">${TABS.map((t) => `<a href="${link({ tab: t.id })}" class="${t.id === state.tab ? "on" : ""}" title="${esc(t.hint)}">${t.label}</a>`).join("")}</nav>
        <div class="tools">
          <div class="seg" title="Quote asset or stage">${PAIRS.map(([v, t]) => `<a href="${link({ pair: v })}" class="${v === state.pair ? "on" : ""}">${t}</a>`).join("")}</div>
          <button id="live" class="live ${state.live ? "on" : ""}" title="Auto-refresh every 20s"><i></i>Live <span id="livet"></span></button>
        </div>
      </div>
      ${state.q ? `<div class="qbar">Results for “<b>${esc(state.q)}</b>” <a href="${link({ q: "" })}">clear ✕</a></div>` : ""}
      <div class="tblwrap" id="tbl"></div>
      <div class="below"><span id="count" class="muted"></span><button id="more" class="btn" hidden>Show more</button></div>`;
    el.querySelector("#tbl").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-s]");
      if (th) {
        const k = th.dataset.s;
        if (state.sortKey === k) {
          state.sortDir === -1 ? (state.sortDir = 1) : (state.sortKey = null);
        } else {
          state.sortKey = k;
          state.sortDir = -1;
        }
        renderTable();
        return;
      }
      const tr = e.target.closest("tr[data-a]");
      if (tr && !e.target.closest("a")) location.hash = "#/token/" + tr.dataset.a;
    });
    el.querySelector("#tbl").addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr[data-a]");
      if (tr && e.key === "Enter") location.hash = "#/token/" + tr.dataset.a;
    });
    el.querySelector("#live").onclick = () => {
      state.live = !state.live;
      el.querySelector("#live").classList.toggle("on", state.live);
      startLive();
    };
    el.querySelector("#more").onclick = () => {
      state.shown += PAGE;
      renderTable();
    };
    renderTable();
    load(true);
    startLive();
    return () => {
      clearInterval(countdown);
      root = null;
    };
  }
  PS.listPage = render;
})(window.PS);
