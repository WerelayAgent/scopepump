/* ScopePump — router, header search, ticker, Solana CA banner. Routes: #/, #/token/<mint>, #/bridge, #/staking, #/sniper. */
(function (PS) {
  const { esc, price, compact, logo, api, SOL_ADDR } = PS;
  const app = document.getElementById("app");
  let cleanup = null,
    routeId = 0;

  PS.ticker = (items) => {
    const el = document.getElementById("ticker");
    if (!items.length) return;
    const one = items
      .map(
        (L, i) =>
          `<a href="#/token/${esc(L.address)}"><span class="tr">#${i + 1}</span>${logo(L, 18)}<b>${esc(L.symbol)}</b><span class="mono">${price(L.priceUsd)}</span>${PS.pct(L.ch24)}<span class="muted">${compact(L.marketCapUsd)}</span></a>`
      )
      .join("");
    el.innerHTML = `<span class="tl">Top Solana</span><div class="tt"><div class="tin">${one}${one}</div></div>`;
    el.hidden = false;
  };

  PS.ensureTokens = async () => {
    if (!PS.listState.all.length) {
      try {
        PS.listState.all = (await api.tokens()).list;
      } catch (e) {
        console.warn(e.message);
      }
    }
    return PS.listState.all;
  };

  async function route() {
    const id = ++routeId;
    if (cleanup) {
      try {
        cleanup();
      } catch {}
      cleanup = null;
    }
    document.getElementById("suggest").hidden = true;
    const raw = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = raw.split("?");
    window.scrollTo(0, 0);
    const m = path.match(/^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    const navKey = path === "/staking" ? "staking" : path === "/bridge" ? "bridge" : path === "/sniper" ? "sniper" : "screener";
    document.querySelectorAll("#mainnav a").forEach((x) => {
      const on = x.dataset.nav === navKey;
      x.classList.toggle("on", on);
      on ? x.setAttribute("aria-current", "page") : x.removeAttribute("aria-current");
    });

    if (navKey === "bridge") {
      cleanup = PS.bridgePage(app) || null;
      return;
    }
    if (navKey !== "screener") {
      PS.soonPage(app, navKey);
      return;
    }
    if (m) {
      const c = await PS.detailPage(app, m[1]);
      if (id === routeId) cleanup = c || null;
      else c && c();
      return;
    }
    document.title = "ScopePump — pump.fun tokens on Solana";
    cleanup = PS.listPage(app, new URLSearchParams(qs || ""));
  }

  const SOON = {
    staking: {
      title: "Staking",
      desc: "Stake $SCOPEPUMP across 7, 30, or 90 day tiers and earn native SOL rewards.",
      icon: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>',
    },
    sniper: {
      title: "Sniper",
      desc: "One-click pump.fun & PumpSwap sniper on Solana with MEV protection.",
      icon: '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    },
  };

  PS.soonPage = (el, key) => {
    const S = SOON[key];
    document.title = `${S.title} (coming soon) — ScopePump`;
    el.innerHTML = `
      <section class="soonpage">
        <div class="earncard">
          <span class="soonicon" aria-hidden="true">${S.icon}</span>
          <h1>${S.title}</h1>
          <p class="muted">${S.desc}</p>
          <span class="soonlabel">Coming soon</span>
        </div>
        <a class="btn pri" href="#/">← Back to screener</a>
      </section>`;
  };

  window.addEventListener("hashchange", route);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cp]");
    if (!b) return;
    e.preventDefault();
    PS.copy(b.dataset.cp);
    if (b.hasAttribute("data-cp-btn")) {
      const t = b.querySelector(".cp-t");
      b.classList.add("copied");
      if (t) t.textContent = "Copied";
      clearTimeout(b._t);
      b._t = setTimeout(() => {
        b.classList.remove("copied");
        if (t) t.textContent = "Copy CA";
      }, 1500);
    }
  });

  const q = document.getElementById("q"),
    sug = document.getElementById("suggest");
  let t = null;
  q.addEventListener("input", () => {
    clearTimeout(t);
    const v = q.value.trim();
    if (!v) {
      sug.hidden = true;
      return;
    }
    t = setTimeout(async () => {
      await PS.ensureTokens();
      if (q.value.trim() !== v) return;
      let items = PS.searchTokens(v).slice(0, 8);
      if (items.length < 8) {
        try {
          const more = await api.search(v);
          if (q.value.trim() !== v) return;
          const have = new Set(items.map((x) => x.address));
          items = items.concat(more.filter((x) => !have.has(x.address))).slice(0, 8);
        } catch {}
      }
      sug.innerHTML = items.length
        ? items
            .map(
              (L) =>
                `<a href="#/token/${esc(L.address)}">${logo(L, 24)}<span><b>${esc(L.symbol)}</b> <span class="muted">${esc(L.name)}</span></span>${PS.quoteBadge(L)}<span class="mono">${compact(L.marketCapUsd)}</span></a>`
            )
            .join("") + `<a class="all" href="#/?q=${encodeURIComponent(v)}">See all results for “${esc(v)}” →</a>`
        : `<div class="none">No Solana token matches “${esc(v)}”.</div>`;
      sug.hidden = false;
    }, 150);
  });

  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      sug.hidden = true;
      q.blur();
    }
    if (e.key !== "Enter") return;
    const v = q.value.trim();
    sug.hidden = true;
    if (SOL_ADDR.test(v)) location.hash = "#/token/" + v;
    else location.hash = v ? "#/?q=" + encodeURIComponent(v) : "#/";
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) sug.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      q.focus();
    }
  });
  route();
})(window.PS);

/* ScopePump CA pill & footer CA row driven by js/config.js */
(function () {
  const C = window.SCOPEPUMP_CONFIG || {},
    ca = String(C.CA || "").trim();
  if (C.X_URL) document.querySelectorAll("a.x-link,a.x-foot").forEach((a) => { a.href = C.X_URL; });
  if (!ca) return;
  const esc = window.PS.esc,
    isLiveCa = window.PS.SOL_ADDR.test(ca),
    sym = String(C.TICKER || "SCOPEPUMP").replace(/[^A-Za-z0-9]/g, "").slice(0, 12),
    lab = "$" + sym;
  const buy = isLiveCa ? (C.BUY_URL || "https://pump.fun/coin/") + ca : "https://pump.fun";
  const cpSvg = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const sh = isLiveCa ? ca.slice(0, 6) + "…" + ca.slice(-4) : ca;

  const d = document.createElement("div");
  d.className = "tokcta";
  d.innerHTML = isLiveCa
    ? `<span class="ca-pill" title="${esc(lab)} contract address: ${esc(ca)}"><a href="#/token/${esc(ca)}"><span class="ca-l">${esc(lab)}</span><span class="mono">${esc(sh)}</span></a><button type="button" class="ca-cp" data-cp="${esc(ca)}" data-cp-btn aria-label="Copy contract address">${cpSvg}<span class="cp-t">Copy CA</span></button></span><a class="buy-btn" href="${esc(buy)}" target="_blank" rel="noopener noreferrer">Buy ${esc(lab)}</a>`
    : `<span class="ca-pill"><span class="ca-txt"><span class="ca-l">${esc(lab)}</span><span class="mono">${esc(sh)}</span></span></span><a class="buy-btn" href="${esc(buy)}" target="_blank" rel="noopener noreferrer">pump.fun</a>`;

  const tr = document.querySelector(".top .top-right");
  tr && tr.parentNode.insertBefore(d, tr);

  const f = document.getElementById("footca");
  if (f) {
    f.innerHTML = isLiveCa
      ? `<span class="muted">${esc(lab)}</span><a class="ca-full" href="#/token/${esc(ca)}">${esc(ca)}</a><button type="button" class="ca-cp" data-cp="${esc(ca)}" data-cp-btn aria-label="Copy contract address"><span class="cp-t">Copy CA</span></button><a class="buy-btn sm" href="${esc(buy)}" target="_blank" rel="noopener noreferrer">Buy</a>`
      : `<span class="muted">${esc(lab)}</span><span class="ca-full">${esc(ca)}</span><a class="buy-btn sm" href="${esc(buy)}" target="_blank" rel="noopener noreferrer">pump.fun</a>`;
    f.hidden = false;
  }
})();
