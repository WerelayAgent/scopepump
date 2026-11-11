/* ScopePump — formatting + DOM helpers (global PS namespace). */
window.PS = window.PS || {};
(function (PS) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (n) => typeof n === "number" && isFinite(n);
  const SUB = "₀₁₂₃₄₅₆₇₈₉";
  // DexScreener-style tiny price: $0.0₅4516
  function price(n, prefix = "$") {
    if (!isNum(n)) return "—";
    if (n === 0) return prefix + "0";
    if (n < 0) return "-" + price(-n, prefix);
    if (n >= 1000) return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (n >= 1) return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    if (n >= 0.001) return prefix + n.toPrecision(4).replace(/0+$/, "");
    const s = n.toExponential(3); // e.g. 4.516e-6
    const [m, e] = s.split("e");
    const zeros = -parseInt(e, 10) - 1;
    const digits = m.replace(".", "").replace(/0+$/, "");
    return prefix + "0.0" + String(zeros).split("").map((d) => SUB[+d]).join("") + digits;
  }
  function compact(n, prefix = "$") {
    if (!isNum(n)) return "—";
    const a = Math.abs(n);
    const f = (v, u) => prefix + (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + u;
    if (a >= 1e9) return f(n / 1e9, "B");
    if (a >= 1e6) return f(n / 1e6, "M");
    if (a >= 1e3) return f(n / 1e3, "K");
    return prefix + (a >= 1 ? n.toFixed(0) : n.toFixed(2));
  }
  function num(n, d = 0) { return isNum(n) ? n.toLocaleString("en-US", { maximumFractionDigits: d }) : "—"; }
  function pct(f) { // f is a fraction (0.05 = 5%)
    if (!isNum(f)) return `<span class="muted">—</span>`;
    const v = f * 100;
    const cls = v > 0.004 ? "up" : v < -0.004 ? "down" : "flat";
    const a = Math.abs(v);
    const t = a >= 10000 ? (a / 1000).toFixed(0) + "K" : a >= 100 ? a.toFixed(0) : a.toFixed(2);
    return `<span class="${cls}">${v > 0.004 ? "+" : v < -0.004 ? "-" : ""}${t}%</span>`;
  }
  function age(ts) {
    if (!isNum(ts)) return "—";
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return Math.floor(s) + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 86400 * 60) return Math.floor(s / 86400) + "d";
    return Math.floor(s / (86400 * 30)) + "mo";
  }
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  function dateTime(ts) { return isNum(ts) ? new Date(ts * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"; }
  // Token artwork, resolved the same way ponsfamily.com does: any IPFS form (ipfs://cid, bare cid, /ipfs/cid path, cid.ipfs.host,
  // ?url=) goes to the Pons artwork CDN (R2-cached, small webp "compact" variant); then our /api/img proxy (multi-gateway, edge cache);
  // other http(s) artwork goes through /api/img. Placeholder letter only if everything fails.
  const BAD = new Set(), GW = new Map();
  const PONS_ART = "https://dbk-vercel.vercel.app/api/ipfs/content/";
  const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;
  function cidOf(src, deep = true) {
    const t = String(src || "").trim().replace(/^ipfs:\/\/(?=https?:\/\/)/i, "");
    let m = /^ipfs:\/\/(?:ipfs\/)?([a-zA-Z0-9]+)(\/.*)?$/.exec(t); if (m) return m[1] + (m[2] || "");
    if (CID.test(t)) return t;
    try {
      const u = new URL(t); if (!/^https?:$/.test(u.protocol)) return "";
      const parts = u.pathname.split("/").filter(Boolean), i = parts.findIndex((x) => x.toLowerCase() === "ipfs");
      if (i >= 0 && parts[i + 1] && /^[a-zA-Z0-9]+$/.test(parts[i + 1])) return parts.slice(i + 1).join("/");
      const h = u.hostname.split("."); if ((h[1] || "").toLowerCase() === "ipfs" && /^[a-zA-Z0-9]+$/.test(h[0])) return h[0] + (u.pathname !== "/" ? u.pathname : "");
      const q = deep ? (u.searchParams.get("url") || "").trim() : ""; if (q) return cidOf(/^https?:\/\//i.test(q) ? q : "https://" + q, false);
    } catch {}
    return "";
  }
  function artUrl(src, i = 0) {
    if (!src) return "";
    const cid = cidOf(src);
    if (cid) return i === 0 ? PONS_ART + cid + (cid.includes("/") ? "" : "?variant=compact") : i === 1 ? "https://ponscope.fun/api/img?src=" + encodeURIComponent("ipfs://" + cid) : "";
    if (/^https?:\/\//.test(src)) return i === 0 ? "https://ponscope.fun/api/img?src=" + encodeURIComponent(src) : ""; // third-party hosts: via proxy (edge cached, never a failed request)
    return "";
  }
  function safeHref(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString() : ""; } catch { return ""; } }
  function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function logo(L, size = 28) {
    const gw = GW.get(L.artwork) || 0;
    const src = BAD.has(L.artwork) ? "" : artUrl(L.artwork, gw);
    const letter = esc((L.symbol || L.name || "?").replace(/^\$/, "").charAt(0).toUpperCase());
    const ph = `<span class="ph" style="--h:${hue(L.address)}">${letter}</span>`;
    if (!src) return `<span class="tlogo" style="width:${size}px;height:${size}px">${ph}</span>`;
    return `<span class="tlogo" style="width:${size}px;height:${size}px">${ph}<img src="${esc(src)}" data-art="${esc(L.artwork)}" data-gw="${gw}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="PS.imgFail(this)"></span>`;
  }
  PS.imgFail = function (img) {
    const art = img.dataset.art, gw = +img.dataset.gw + 1;
    const next = artUrl(art, gw);
    if (next) { GW.set(art, gw); img.dataset.gw = gw; img.src = next; } else { BAD.add(art); img.remove(); }
  };
  function toast(msg) {
    const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 1600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copied"); } catch { toast("Copy failed"); } ta.remove(); }
  }
  const EXPLORER = "https://robinhoodchain.blockscout.com";
  const PONS_URL = "https://ponsfamily.com";
  const tradeUrl = (a) => `${PONS_URL}/launchpad/${a}`;
  Object.assign(PS, { esc, isNum, price, compact, num, pct, age, short, dateTime, artUrl, safeHref, logo, toast, copy, EXPLORER, PONS_URL, tradeUrl });
})(window.PS);
