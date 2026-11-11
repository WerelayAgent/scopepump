/* ScopePump — Sniper (#/sniper) and the token-page trade panel.
   Paste a Pons CA, one-click quick buys in ETH, sell by %, slippage. Signs with the user's own injected wallet (EIP-1193 / EIP-6963).
   Calldata comes from js/sniper-core.js (PS.SC). Shown only when PS.SNIPER_LIVE (js/config.js SNIPER + SNIPER_ROUTER). */
(function (PS) {
  const SC = PS.SC, C = SC.C, { esc } = PS;
  const cfg = window.PONSCOPE_CONFIG || {};
  let dev = null;
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { try { dev = JSON.parse(localStorage.getItem("ps_sniper_dev") || "null"); } catch {} }
  PS.SNIPER_LIVE = (cfg.SNIPER === true || !!(dev && dev.live)) && /^0x[0-9a-f]{40}$/.test(C.router);

  const ICON = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  const RH_PARAMS = { chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] };
  const hex = (n) => "0x" + BigInt(n).toString(16);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim());
  function toUnits(s, d = 18) {
    s = String(s || "").trim(); if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
    let [i, f = ""] = s.split("."); f = f.slice(0, d).padEnd(d, "0"); return BigInt(i || "0") * 10n ** BigInt(d) + BigInt(f || "0");
  }
  function fmt(v, d = 18, max = 4) {
    v = BigInt(v); const b = 10n ** BigInt(d), i = v / b;
    let f = (v % b).toString().padStart(d, "0").slice(0, max).replace(/0+$/, "");
    if (i === 0n && !f && v > 0n) { const full = (v % b).toString().padStart(d, "0"); const nz = full.search(/[1-9]/); f = full.slice(0, Math.min(d, nz + 3)).replace(/0+$/, ""); }
    return i.toLocaleString("en-US") + (f ? "." + f : "");
  }
  const fmtTok = (v, d) => { const n = Number(v) / 10 ** d; return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(2) + "K" : fmt(v, d, 4); };
  const errMsg = (e) => {
    if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return "Request rejected in wallet.";
    const m = String((e && ((e.data && e.data.message) || e.message)) || "Something went wrong.");
    if (/insufficient funds/i.test(m)) return "Not enough ETH for this trade and gas.";
    if (/Slippage|0x7dd37f70|TooLittle|minTokensOut|min/i.test(m) && /revert/i.test(m)) return "Price moved more than your slippage. Try again or raise slippage.";
    return m.replace(/^execution reverted:?\s*/i, "Transaction would fail: ").slice(0, 200);
  };

  // ---------- chain reads ----------
  let rid = 0;
  async function rpc(method, params) {
    const r = await fetch(C.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
    const d = await r.json(); if (d.error) { const e = new Error(d.error.message || "RPC error"); e.data = d.error.data; throw e; } return d.result;
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  const multi = async (calls) => SC.decodeAggregate3(await call(C.multicall3, SC.aggregate3Data(calls)));

  // Token + route (curve / pool / graduating / unsupported)
  async function loadToken(addr) {
    addr = addr.toLowerCase();
    const L = SC.decodeLaunched(await call(C.factory, SC.launchedData(addr)));
    if (!L || !L.exists) return { token: addr, stage: "unsupported", why: "Not a Pons token" };
    const res = await multi([...SC.curveCalls(L.curve), { to: addr, data: SC.SEL.symbol }, { to: addr, data: SC.SEL.name }, { to: addr, data: SC.SEL.decimals }]);
    const r = SC.makeRoute(addr, L, SC.decodeCurve(res));
    r.cs = SC.decodeCurve(res);
    r.symbol = res[7].ok ? SC.decString(res[7].data) : "TOKEN"; r.name = res[8].ok ? SC.decString(res[8].data) : r.symbol;
    r.decimals = res[9].ok ? Number(SC.words(res[9].data)[0]) : 18;
    return r;
  }
  async function refreshCurve(r) { if (r.stage !== "curve") return r; const cs = SC.decodeCurve(await multi(SC.curveCalls(r.curve))); const n = SC.makeRoute(r.token, r.launch, cs); return Object.assign(r, { stage: n.stage, cs }); }
  async function quote(r, side, amount) {
    amount = BigInt(amount); if (amount <= 0n) return null;
    if (r.stage === "curve") {
      await refreshCurve(r);
      if (r.stage !== "curve") return null;
      if (side === "buy") { const q = SC.curveQuoteBuy(r.cs, amount); const spot = Number(r.cs.quoteReserve) / Number(r.cs.tokenReserve), eff = Number(amount - q.fee - q.refund) / Number(q.out || 1n); return { out: q.out, refund: q.refund, impact: q.out > 0n ? Math.max(0, eff / spot - 1) : null }; }
      const q = SC.curveQuoteSell(r.cs, amount); const spot = Number(r.cs.quoteReserve) / Number(r.cs.tokenReserve), eff = Number(q.gross + q.ponsFee + q.tax) / Number(amount);
      return { out: q.out, impact: Math.max(0, 1 - eff / spot) };
    }
    if (r.stage === "pool") {
      if (side === "buy") { const net = amount - SC.feeOf(amount); const o = SC.words(await call(C.quoter, SC.poolQuoteData(r, "buy", net)))[0]; return { out: o, impact: null }; }
      const g = SC.words(await call(C.quoter, SC.poolQuoteData(r, "sell", amount)))[0]; return { out: g - SC.feeOf(g), gross: g, impact: null };
    }
    return null;
  }
  async function balances(r, who) {
    const res = await multi([{ to: r.token, data: SC.balanceData(who) }]);
    const eth = BigInt(await rpc("eth_getBalance", [who, "latest"]));
    return { eth, tok: res[0].ok ? SC.words(res[0].data)[0] : 0n };
  }

  // ---------- wallet (shared with Staking / Bridge via localStorage "ps_wallet") ----------
  const W = { list: [], p: null, info: null, account: null, chainId: null, hooked: new WeakSet(), subs: new Set() };
  window.addEventListener("eip6963:announceProvider", (e) => { const d = e.detail; if (d && d.info && d.provider && !W.list.some((x) => x.info.uuid === d.info.uuid)) W.list.push(d); });
  const requestWallets = () => window.dispatchEvent(new Event("eip6963:requestProvider"));
  requestWallets();
  function walletOptions() {
    const l = W.list.slice();
    if (!l.length && window.ethereum) l.push({ info: { uuid: "injected", name: window.ethereum.isMetaMask ? "MetaMask" : window.ethereum.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet", icon: "", rdns: "injected" }, provider: window.ethereum });
    return l;
  }
  const notify = () => W.subs.forEach((f) => { try { f(); } catch {} });
  function hook(p) {
    if (W.hooked.has(p) || !p.on) return; W.hooked.add(p);
    p.on("accountsChanged", (a) => { if (W.p !== p) return; W.account = (a && a[0]) || null; if (!W.account) localStorage.removeItem("ps_wallet"); notify(); });
    p.on("chainChanged", (c) => { if (W.p !== p) return; W.chainId = parseInt(c, 16); notify(); });
  }
  async function useWallet(opt, prompt) {
    const p = opt.provider; const acc = await p.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" });
    if (!acc || !acc[0]) return false;
    W.p = p; W.info = opt.info; W.account = acc[0]; W.chainId = parseInt(await p.request({ method: "eth_chainId" }), 16);
    hook(p); localStorage.setItem("ps_wallet", opt.info.rdns || opt.info.name); notify(); return true;
  }
  async function autoReconnect() {
    const want = localStorage.getItem("ps_wallet"); if (!want || W.account) return;
    await sleep(250); const o = walletOptions().find((x) => (x.info.rdns || x.info.name) === want);
    if (o) { try { await useWallet(o, false); } catch {} }
  }
  async function ensureChain() {
    if (W.chainId === C.chainId) return;
    const cid = hex(C.chainId);
    try { await W.p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cid }] }); }
    catch (e) {
      const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e && e.message))) throw e;
      await W.p.request({ method: "wallet_addEthereumChain", params: [RH_PARAMS] });
    }
    W.chainId = parseInt(await W.p.request({ method: "eth_chainId" }), 16);
    if (W.chainId !== C.chainId) throw new Error("Please switch your wallet to Robinhood Chain.");
  }
  async function extSend(tx, status) {
    await ensureChain();
    status("Confirm in your wallet");
    const base = { from: W.account, to: tx.to, data: tx.data, value: hex(tx.value || 0n) };
    const [est, gp] = await Promise.all([rpc("eth_estimateGas", [base]), rpc("eth_gasPrice", [])]);
    const hash = await W.p.request({ method: "eth_sendTransaction", params: [{ ...base, gas: hex((BigInt(est) * 13n) / 10n), gasPrice: hex((BigInt(gp) * 12n) / 10n), chainId: hex(C.chainId) }] });
    status("Waiting for confirmation");
    for (let i = 0; i < 150; i++) {
      let r = null; try { r = await rpc("eth_getTransactionReceipt", [hash]); } catch {}
      if (r && r.blockNumber) { if (r.status === "0x0") throw new Error("Transaction failed on-chain."); return hash; }
      await sleep(i < 20 ? 500 : 2000);
    }
    throw new Error("Timed out waiting for confirmation. Check your wallet activity.");
  }

  // ---------- trading account: browser trading wallet (default) or an external wallet ----------
  const simCall = async (to, data, o = {}) => rpc("eth_call", [{ to, data, from: o.from, value: o.value }, "latest"]);
  const TW = PS.tradeWallet = PS.tradeWallet || PS.tradeWalletInit({ C, rpc, call: simCall, log: null, sleep });
  TW.onChange(() => notify());
  let mode = localStorage.getItem("ps_mode") === "ext" ? "ext" : "tw";
  function setMode(m) { mode = m === "ext" ? "ext" : "tw"; localStorage.setItem("ps_mode", mode); TW.setUse(mode === "tw"); notify(); }
  const acct = () => (mode === "tw" ? TW.address() : W.account) || null;
  const ready = () => (mode === "tw" ? TW.unlocked() : !!W.account);
  async function send(tx, status, label) {
    if (mode === "tw") { status("Signing in this browser"); try { const rc = await TW.send(tx, label || "Trade"); return rc.transactionHash; } finally { WM.refreshBal(); } }
    return extSend(tx, status);
  }

  // ---------- trading ----------
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
  async function doBuy(r, gross, slipBps, status) {
    const q = await quote(r, "buy", gross); if (!q || q.out <= 0n) throw new Error(r.stage === "graduating" ? "Graduating to its pool. Try again in a moment." : "No quote for this amount.");
    const min = SC.applySlippage(q.out, slipBps);
    const tx = r.stage === "curve" ? SC.curveBuy(r, gross, min) : SC.poolBuy(r, gross, min, deadline());
    return send(tx, status, "Buy " + r.symbol);
  }
  async function doSell(r, amount, slipBps, status) {
    const q = await quote(r, "sell", amount); if (!q || q.out <= 0n) throw new Error(r.stage === "graduating" ? "Graduating to its pool. Try again in a moment." : "No quote for this amount.");
    const min = SC.applySlippage(q.out, slipBps);
    if (r.stage === "curve") {
      const al = SC.words(await call(r.token, SC.allowanceData(acct(), C.router)))[0] || 0n;
      if (al < amount) { status("Approve " + r.symbol); await send({ to: r.token, data: SC.erc20Approve(C.router, SC.MAX_U256) }, (s) => status("Approve: " + s.toLowerCase())); }
      return send(SC.curveSell(r, amount, min), status, "Sell " + r.symbol);
    }
    const al = SC.words(await call(r.token, SC.allowanceData(acct(), C.permit2)))[0] || 0n;
    if (al < amount) await send({ to: r.token, data: SC.erc20Approve(C.permit2, SC.MAX_U256) }, (s) => status("Approve: " + s.toLowerCase()));
    const pw = SC.words(await call(C.permit2, SC.p2AllowanceData(acct(), r.token, C.ur)));
    if ((pw[0] || 0n) < amount || Number(pw[1] || 0n) < Date.now() / 1000 + 120) await send({ to: C.permit2, data: SC.p2Approve(r.token, C.ur, SC.MAX_U160, BigInt(Math.floor(Date.now() / 1000) + 30 * 86400)) }, (s) => status("Permit: " + s.toLowerCase()));
    return send(SC.poolSell(r, amount, min, deadline()), status, "Sell " + r.symbol);
  }

  // ---------- settings ----------
  const DEF = { quick: ["0.01", "0.05", "0.1", "0.25"], sells: [25, 50, 75, 100], slip: 10 };
  function loadCfg() { try { const c = JSON.parse(localStorage.getItem("ps_sniper_cfg") || "null"); if (c && Array.isArray(c.quick) && c.quick.length === 4) return { ...DEF, ...c }; } catch {} return { ...DEF, quick: DEF.quick.slice(), sells: DEF.sells.slice() }; }
  const saveCfg = (c) => { try { localStorage.setItem("ps_sniper_cfg", JSON.stringify(c)); } catch {} };
  const SLIPS = [1, 5, 10, 20];

  const shortA = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  function walletBtn(cls = "") {
    if (mode === "tw") {
      if (!TW.exists()) return `<button type="button" class="wbtn ${cls}" data-act="wallet">Set up trading wallet</button>`;
      if (!TW.unlocked()) return `<button type="button" class="wbtn tw lockd ${cls}" data-act="wallet"><span class="dot"></span>Unlock wallet</button>`;
      return `<button type="button" class="wbtn tw on ${cls}" data-act="wallet" title="${esc(TW.address())}"><span class="dot"></span><span class="mono">${esc(shortA(TW.address()))}</span></button>`;
    }
    return W.account ? `<button type="button" class="wbtn on ${cls}" data-act="wallet" title="${esc(W.account)}">${W.info && W.info.icon ? `<img src="${esc(W.info.icon)}" alt="" width="18" height="18">` : '<span class="dot"></span>'}<span class="mono">${esc(shortA(W.account))}</span></button>`
      : `<button type="button" class="wbtn ${cls}" data-act="wallet">Connect wallet</button>`;
  }
  const needLabel = () => (mode === "tw" ? (TW.exists() ? "Unlock wallet" : "Set up trading wallet") : "Connect wallet");

  // ---------- wallet modal (shared by the Sniper page and the token panel) ----------
  const WM = { open: false, tab: "tw", step: "", f: {}, err: "", ok: "", busy: false, reveal: null, bal: null, el: null };
  function wmEl() { if (!WM.el) { WM.el = document.createElement("div"); WM.el.id = "pswm"; document.body.appendChild(WM.el); WM.el.addEventListener("click", wmClick); WM.el.addEventListener("input", (e) => { if (e.target.id) WM.f[e.target.id] = e.target.value; }); WM.el.addEventListener("change", (e) => { if (e.target.id === "tw-idle") TW.setIdleMin(parseInt(e.target.value, 10)); }); WM.el.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { const b = e.target.closest(".tw-form") && e.target.closest(".tw-form").querySelector("[data-wa].pri"); b && b.click(); } }); } return WM.el; }
  WM.show = (tab) => { WM.open = true; WM.tab = tab || mode; WM.err = ""; WM.ok = ""; requestWallets(); wmRender(); if (TW.unlocked()) TW.balance().then((b) => { WM.bal = b; wmRender(); }).catch(() => {}); };
  WM.close = () => { WM.open = false; WM.reveal = null; WM.f = {}; wmRender(); };
  // live balance while the window is open: poll every few seconds, and refresh right after trades, deposits and withdrawals
  let balBusy = false;
  WM.refreshBal = async () => {
    if (balBusy || !TW.unlocked()) return; balBusy = true;
    try {
      const b = await TW.balance(); const changed = WM.bal == null || BigInt(b) !== BigInt(WM.bal); WM.bal = b;
      if (changed && WM.open) { const n = document.getElementById("tw-bal"); if (n) n.textContent = fmt(b, 18, 5) + " ETH"; }
      if (changed) notify();
    } catch {} finally { balBusy = false; }
  };
  setInterval(() => { if (WM.open && !document.hidden) WM.refreshBal(); }, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && WM.open) WM.refreshBal(); });
  const fv = (id) => esc(WM.f[id] || "");
  const inp = (id, ph, type = "password", extra = "") => `<input id="${id}" type="${type}" class="tw-in" placeholder="${esc(ph)}" value="${fv(id)}" autocomplete="off" spellcheck="false"${extra}>`;
  function twHtml() {
    if (!TW.exists()) {
      if (WM.step === "create") return `<div class="tw-form"><b>New trading wallet</b><p class="muted sm">A new wallet is created in this browser. Pick a password to encrypt it.</p>${inp("tw-pw", "Password (10+ characters)")}${inp("tw-pw2", "Repeat password")}<div class="tw-acts"><button type="button" class="bgo pri" data-wa="create"${WM.busy ? " disabled" : ""}>Create wallet</button><button type="button" class="sk-btn" data-wa="back">Back</button></div></div>`;
      if (WM.step === "import") return `<div class="tw-form"><b>Import a private key</b>${inp("tw-key", "Private key (0x…)")}${inp("tw-pw", "Password (10+ characters)")}${inp("tw-pw2", "Repeat password")}<div class="tw-acts"><button type="button" class="bgo pri" data-wa="import"${WM.busy ? " disabled" : ""}>Import wallet</button><button type="button" class="sk-btn" data-wa="back">Back</button></div></div>`;
      return `<div class="tw-intro"><b>Trade without popups</b><p class="muted">Create a trading wallet in this browser, send it some ETH, and every buy and sell goes through in one click.</p><div class="tw-choice"><button type="button" class="bgo" data-wa="step" data-s="create">Create new wallet</button><button type="button" class="sk-btn" data-wa="step" data-s="import">Import key</button></div></div>`;
    }
    const rec = TW.rec(), bk = TW.backupKey();
    if (!TW.unlocked()) return `<div class="tw-form"><div class="tw-addr"><span class="blab">Trading wallet</span><b class="mono">${esc(rec.address)}</b></div>${TW.lockReason() ? `<p class="muted sm">${esc(TW.lockReason())}</p>` : ""}${inp("tw-upw", "Password", "password", " autofocus")}<div class="tw-acts"><button type="button" class="bgo pri" data-wa="unlock"${WM.busy ? " disabled" : ""}>Unlock</button><button type="button" class="sk-btn danger" data-wa="forget">Forget</button></div></div>`;
    if (bk) return `<div class="tw-form"><b>Back up your key</b><p class="muted sm">This key is the only way to restore the wallet. Save it somewhere safe and never share it.</p><div class="tw-key mono">${esc(bk)}</div><div class="tw-acts"><button type="button" class="sk-btn" data-wa="copykey">Copy key</button><button type="button" class="bgo pri" data-wa="saved">I saved my key</button></div></div>`;
    const a = rec.address;
    return `<div class="tw-live">
      <div class="tw-dep"><div class="tw-qr" id="tw-qr"></div><div class="tw-depinfo"><span class="blab">Deposit ETH on Robinhood Chain</span><b class="mono tw-a">${esc(a)}</b><div class="tw-acts"><button type="button" class="sk-btn" data-wa="copyaddr">Copy address</button>${mode !== "tw" ? '<button type="button" class="sk-btn pri" data-wa="use">Use for trading</button>' : '<span class="tw-on"><span class="dot"></span>Trading with this wallet</span>'}</div>
        <div class="tw-bal"><span>Balance</span><b class="mono" id="tw-bal">${WM.bal != null ? fmt(WM.bal, 18, 5) + " ETH" : "…"}</b></div></div></div>
      ${WM.reveal ? `<div class="tw-form"><b>Private key</b><div class="tw-key mono">${esc(WM.reveal)}</div><div class="tw-acts"><button type="button" class="sk-btn" data-wa="copyreveal">Copy key</button><button type="button" class="sk-btn" data-wa="hide">Hide</button></div></div>` : ""}
      <details class="tw-more"><summary>Withdraw, export, settings</summary>
        <div class="tw-form"><span class="blab">Withdraw all ETH</span><div class="tw-row">${inp("tw-to", "Destination address 0x…", "text")}<button type="button" class="sk-btn pri" data-wa="withdraw"${WM.busy ? " disabled" : ""}>Withdraw</button></div></div>
        <div class="tw-form"><span class="blab">Export private key</span><div class="tw-row">${inp("tw-xpw", "Password")}<button type="button" class="sk-btn" data-wa="export"${WM.busy ? " disabled" : ""}>Show key</button></div></div>
        <div class="tw-form"><span class="blab">Auto-lock</span><select id="tw-idle" class="tw-in">${[[0, "When the tab closes"], [15, "After 15 min idle"], [60, "After 1 h idle"], [240, "After 4 h idle"]].map(([v, t]) => `<option value="${v}"${TW.idleMin() === v ? " selected" : ""}>${t}</option>`).join("")}</select></div>
      </details>
      <div class="tw-acts"><button type="button" class="sk-btn" data-wa="lock">Lock</button><button type="button" class="sk-btn danger" data-wa="forget">Forget wallet</button></div>
    </div>`;
  }
  function extHtml() {
    if (W.account) return `<div class="tw-form"><div class="tw-addr"><span class="blab">Browser wallet</span><b class="mono">${esc(W.account)}</b></div><div class="tw-acts">${mode !== "ext" ? '<button type="button" class="bgo pri" data-wa="useext">Use for trading</button>' : '<span class="tw-on"><span class="dot"></span>Trading with this wallet</span>'}<button type="button" class="sk-btn" data-wa="disconnect">Disconnect</button></div></div>`;
    const l = walletOptions();
    return `<div class="tw-form"><b>Connect a browser wallet</b><p class="muted sm">Each trade is confirmed in your wallet.</p>${l.length ? l.map((o, i) => `<button type="button" class="tw-w" data-wallet="${i}">${o.info.icon ? `<img src="${esc(o.info.icon)}" alt="" width="24" height="24">` : '<span class="sp-ph sm">W</span>'}<span>${esc(o.info.name)}</span></button>`).join("") : '<p class="muted">No browser wallet found. Install MetaMask, Rabby or Coinbase Wallet, then reload.</p>'}</div>`;
  }
  function wmRender() {
    const el = wmEl();
    if (!WM.open) { el.innerHTML = ""; return; }
    const ae = document.activeElement, keep = ae && ae.id && el.contains(ae) ? ae.id : null;
    el.innerHTML = `<div class="bmodal" data-wa="close"><div class="bpick tw-p" role="dialog" aria-label="Wallet">
      <div class="tw-h"><b>Wallet</b><button type="button" class="tw-x" data-wa="x" aria-label="Close">×</button></div>
      <div class="seg tw-tabs"><button type="button" data-wa="tab" data-t="tw" class="${WM.tab === "tw" ? "on" : ""}">Trading wallet</button><button type="button" data-wa="tab" data-t="ext" class="${WM.tab === "ext" ? "on" : ""}">Browser wallet</button></div>
      ${WM.tab === "tw" ? twHtml() : extHtml()}
      ${WM.err ? `<div class="berr">${esc(WM.err)}</div>` : WM.ok ? `<div class="bdone">${esc(WM.ok)}</div>` : ""}
    </div></div>`;
    if (keep) { const i = el.querySelector("#" + keep); i && i.focus(); } else { const a = el.querySelector("[autofocus]"); a && a.focus(); }
    const q = el.querySelector("#tw-qr"); if (q && TW.address()) TW.qr(TW.address(), 132).then((svg) => { const q2 = el.querySelector("#tw-qr"); if (q2) q2.innerHTML = svg; }).catch(() => {});
  }
  async function wmAct(fn) { WM.busy = true; WM.err = ""; WM.ok = ""; wmRender(); try { await fn(); } catch (e) { WM.err = (e && e.message) || "Something went wrong."; } WM.busy = false; wmRender(); }
  function wmClick(e) {
    const w = e.target.closest("[data-wallet]");
    if (w) return wmAct(async () => { const o = walletOptions()[+w.dataset.wallet]; if (!o) return; await useWallet(o, true); setMode("ext"); WM.close(); });
    const b = e.target.closest("[data-wa]"); if (!b) return;
    const a = b.dataset.wa, val = (id) => WM.f[id] || "";
    if (a === "close") { if (e.target === b) WM.close(); return; }
    if (a === "x") return WM.close();
    if (a === "tab") { WM.tab = b.dataset.t; WM.err = ""; return wmRender(); }
    if (a === "step") { WM.step = b.dataset.s; WM.err = ""; return wmRender(); }
    if (a === "back") { WM.step = ""; WM.err = ""; return wmRender(); }
    if (a === "create") return wmAct(async () => { const er = TW.checkPassword(val("tw-pw"), val("tw-pw2")); if (er) throw new Error(er); await TW.create(val("tw-pw")); WM.f = {}; WM.step = ""; setMode("tw"); });
    if (a === "import") return wmAct(async () => { const er = TW.checkPassword(val("tw-pw"), val("tw-pw2")); if (er) throw new Error(er); await TW.importKey(val("tw-key"), val("tw-pw")); WM.f = {}; WM.step = ""; setMode("tw"); WM.bal = await TW.balance(); });
    if (a === "unlock") return wmAct(async () => { await TW.unlock(val("tw-upw")); WM.f = {}; setMode("tw"); WM.bal = await TW.balance(); WM.close(); });
    if (a === "saved") { TW.confirmBackup(); TW.balance().then((x) => { WM.bal = x; wmRender(); }).catch(() => {}); return wmRender(); }
    if (a === "copykey") return PS.copy(TW.backupKey() || "");
    if (a === "copyreveal") return PS.copy(WM.reveal || "");
    if (a === "copyaddr") return PS.copy(TW.address() || "");
    if (a === "hide") { WM.reveal = null; return wmRender(); }
    if (a === "use") { setMode("tw"); return wmRender(); }
    if (a === "useext") { setMode("ext"); return WM.close(); }
    if (a === "disconnect") { W.account = null; localStorage.removeItem("ps_wallet"); if (mode === "ext") setMode("tw"); notify(); return wmRender(); }
    if (a === "lock") { TW.lock("Locked."); WM.reveal = null; return wmRender(); }
    if (a === "export") return wmAct(async () => { WM.reveal = await TW.exportKey(val("tw-xpw")); WM.f["tw-xpw"] = ""; });
    if (a === "withdraw") return wmAct(async () => { const r = await TW.withdrawAll(val("tw-to")); WM.ok = `Withdrew ${fmt(r.amount, 18, 5)} ETH.`; WM.bal = await TW.balance(); notify(); setTimeout(WM.refreshBal, 3000); });
    if (a === "forget") { if (!confirm("Forget the trading wallet in this browser? Without a backup of the key, any funds in it are lost.")) return; TW.forget(); WM.reveal = null; WM.bal = null; return wmRender(); }
  }
  TW.onChange(() => WM.open && wmRender());

  const stageTag = (r) => r.stage === "curve" ? `<span class="sp-tag cv">Bonding curve${r.cs && r.cs.sellable > 0n ? "" : ""}</span>` : r.stage === "pool" ? '<span class="sp-tag gd">Graduated</span>' : r.stage === "graduating" ? '<span class="sp-tag wt">Graduating</span>' : '<span class="sp-tag no">Not tradable here</span>';

  // One trade controller shared by the Sniper page and the token panel.
  function controller(onChange) {
    const T = { r: null, bal: null, cfg: loadCfg(), busy: false, status: "", err: "", ok: "", tx: null, pick: false, quote: null, custom: "", side: "buy", sellPct: null, log: [] };
    T.set = (o) => { Object.assign(T, o); onChange(); };
    T.load = async (addr) => {
      T.set({ r: null, bal: null, err: "", ok: "", quote: null, loading: true });
      try { const r = await loadToken(addr); T.set({ r, loading: false }); T.refresh(); }
      catch (e) { T.set({ loading: false, err: "Could not read this token. " + errMsg(e) }); }
    };
    T.refresh = async () => { const a = acct(); if (!T.r || !a || T.r.stage === "unsupported") { if (!a) { T.bal = null; } return; } try { T.bal = await balances(T.r, a); onChange(); } catch {} };
    T.connect = async (i) => { const o = walletOptions()[i]; T.pick = false; if (!o) return onChange(); try { await useWallet(o, true); T.err = ""; } catch (e) { T.err = errMsg(e); } onChange(); T.refresh(); };
    T.run = async (side, amount, label) => {
      if (T.busy || !T.r) return;
      if (!ready()) { WM.show(); return; }
      T.set({ busy: true, err: "", ok: "", status: label });
      try {
        const st = (s) => T.set({ status: label + ": " + s.toLowerCase() });
        const h = side === "buy" ? await doBuy(T.r, amount, T.cfg.slip * 100, st) : await doSell(T.r, amount, T.cfg.slip * 100, st);
        T.log.unshift({ side, label, hash: h, t: Date.now(), sym: T.r.symbol });
        T.set({ busy: false, status: "", ok: label + " confirmed.", tx: h });
        await refreshCurve(T.r).catch(() => {}); T.refresh();
      } catch (e) { T.set({ busy: false, status: "", err: errMsg(e) }); }
    };
    T.buy = (eth) => { const v = toUnits(eth, 18); if (v <= 0n) return T.set({ err: "Enter an ETH amount." }); if (T.bal && v > T.bal.eth) return T.set({ err: "Not enough ETH." }); T.run("buy", v, `Buy ${eth} ETH`); };
    T.sell = (pct) => { if (!ready()) return WM.show(); const b = T.bal ? T.bal.tok : 0n; if (b <= 0n) return T.set({ err: `No ${T.r.symbol} to sell.` }); const a = pct >= 100 ? b : (b * BigInt(pct)) / 100n; T.run("sell", a, `Sell ${pct}%`); };
    T.preview = async (side, amount) => { const my = (T.qid = (T.qid || 0) + 1); if (!T.r || amount <= 0n) return T.set({ quote: null }); try { const q = await quote(T.r, side, amount); if (my === T.qid) T.set({ quote: q && { ...q, side, amount } }); } catch { if (my === T.qid) T.set({ quote: null }); } };
    W.subs.add(() => { onChange(); T.refresh(); });
    return T;
  }

  function msgHtml(T) {
    return T.err ? `<div class="berr">${esc(T.err)}</div>` : T.status ? `<div class="sp-status"><span class="sp-spin"></span>${esc(T.status)}</div>` : T.ok ? `<div class="bdone sp-ok">${esc(T.ok)}${T.tx && !C.dev ? ` <a href="${C.explorer}/tx/${esc(T.tx)}" target="_blank" rel="noopener">View transaction</a>` : ""}</div>` : "";
  }
  function quoteHtml(T, d) {
    const q = T.quote; if (!q) return "";
    const outTxt = q.side === "buy" ? `${fmtTok(q.out, d)} ${esc(T.r.symbol)}` : `${fmt(q.out, 18, 6)} ETH`;
    const min = SC.applySlippage(q.out, T.cfg.slip * 100);
    return `<div class="bq sp-q"><div><span>You get</span><b class="mono">≈ ${outTxt}</b></div><div><span>Minimum</span><span class="mono">${q.side === "buy" ? fmtTok(min, d) + " " + esc(T.r.symbol) : fmt(min, 18, 6) + " ETH"}</span></div>${q.impact != null ? `<div><span>Price impact</span><span class="${q.impact > 0.15 ? "high" : q.impact > 0.05 ? "warn" : ""}">${(q.impact * 100).toFixed(2)}%</span></div>` : ""}${q.refund ? `<div><span>Refunded</span><span class="mono">${fmt(q.refund, 18, 6)} ETH</span></div>` : ""}</div>`;
  }
  const slipHtml = (T) => `<div class="sp-f"><span class="blab">Slippage</span><div class="bseg sm sp-slip">${SLIPS.map((s) => `<button type="button" data-slip="${s}" class="${T.cfg.slip === s ? "on" : ""}">${s}%</button>`).join("")}<input class="sp-in sm" data-cfg="slip" inputmode="decimal" value="${SLIPS.includes(T.cfg.slip) ? "" : esc(T.cfg.slip)}" placeholder="Custom" aria-label="Custom slippage %"></div></div>`;

  // ---------- Sniper page ----------
  PS.sniperPage = (el) => {
    document.title = "Sniper — ScopePump";
    let root = null, timer = null, edit = false;
    const T = controller(() => render());
    function tokenCard() {
      const r = T.r;
      if (T.loading) return `<div class="card sp-tok"><div class="loading">Reading token…</div></div>`;
      if (!r) return `<div class="card sp-tok sp-empty"><span class="sk-icon" aria-hidden="true">${ICON}</span><b>Paste a Pons CA to start</b><span class="muted">Curve and graduated tokens, quoted live from the chain.</span></div>`;
      const L = (PS.listState && PS.listState.all || []).find((x) => x.address.toLowerCase() === r.token);
      const d = r.decimals, b = T.bal;
      return `<div class="card sp-tok">
        <div class="sp-th">${L ? PS.logo(L, 44) : `<span class="sp-ph">${esc((r.symbol || "?").slice(0, 2))}</span>`}<div><h2>${esc(r.name || r.symbol)}${r.name && r.symbol && r.name !== r.symbol ? ` <span class="muted">${esc(r.symbol)}</span>` : ""}</h2><div class="sp-sub"><span class="mono">${esc(r.token.slice(0, 6) + "…" + r.token.slice(-4))}</span>${stageTag(r)}${L && PS.isNum(L.marketCapUsd) ? `<span class="muted">MC ${PS.compact(L.marketCapUsd)}</span>` : ""}</div></div>
        <a class="chip" href="#/token/${esc(r.token)}">Chart</a></div>
        ${r.stage === "unsupported" ? `<div class="bwarn">${esc(r.why || "Not tradable here")}</div>` : ""}
        ${r.stage === "graduating" ? `<div class="bwarn">This token filled its curve and is moving to its pool. Trading opens again in a moment.</div>` : ""}
        ${r.stage === "curve" && r.cs ? `<div class="sp-prog"><div><span>Curve</span><b>${(() => { const L2 = L && PS.isNum(L.progress) ? L.progress * 100 : null; return L2 != null ? L2.toFixed(1) + "%" : "Live"; })()}</b></div><i style="width:${L && PS.isNum(L.progress) ? Math.min(100, L.progress * 100).toFixed(1) : 0}%"></i></div>` : ""}
        <div class="sp-bals"><div><span>You hold</span><b class="mono">${acct() ? (b ? fmtTok(b.tok, d) : "…") : "—"}</b><em>${esc(r.symbol)}</em></div><div><span>ETH balance</span><b class="mono">${acct() ? (b ? fmt(b.eth, 18, 4) : "…") : "—"}</b><em>${acct() ? (mode === "tw" ? "Trading wallet" : "Browser wallet") : "Set up a wallet"}</em></div></div>
      </div>`;
    }
    function render() {
      if (!root) return;
      const r = T.r, ok = r && (r.stage === "curve" || r.stage === "pool"), dis = !ok || T.busy ? " disabled" : "";
      const d = r ? r.decimals : 18;
      const ae = document.activeElement, keep = ae && ae.dataset && (ae.dataset.k || null), pos = ae && ae.selectionStart;
      root.innerHTML = `
        <div class="sk-head"><div><span class="sk-icon" aria-hidden="true">${ICON}</span><h1>Sniper</h1><p class="muted">Paste a CA, buy in one click, sell by percent.</p></div>${walletBtn()}</div>
        <form class="sp-ca" data-act="load"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><input id="spca" data-k="ca" spellcheck="false" autocomplete="off" placeholder="Paste token contract address (0x…)" value="${esc(T.ca || "")}" aria-label="Token contract address"><button type="button" class="sk-btn" data-act="paste">Paste</button><button type="submit" class="sk-btn pri">Load</button></form>
        <div class="sp-grid">
          <div class="sp-left">${tokenCard()}</div>
          <div class="bcard sp-trade">
            <div class="brow"><span class="blab">Quick buy</span><button type="button" class="sp-edit" data-act="edit">${edit ? "Done" : "Edit"}</button></div>
            <div class="sp-quick">${T.cfg.quick.map((q, i) => edit ? `<label class="sp-qe"><input data-k="q${i}" data-q="${i}" inputmode="decimal" value="${esc(q)}" aria-label="Quick buy ${i + 1} ETH"><span>ETH</span></label>` : `<button type="button" class="sp-qb" data-buy="${esc(q)}"${dis}><b>${esc(q)}</b><span>ETH</span></button>`).join("")}</div>
            <div class="bbox sp-custom"><div class="brow"><span class="blab">Custom</span><span class="sm muted">${T.bal ? "Balance " + fmt(T.bal.eth, 18, 4) + " ETH" : ""}</span></div>
              <div class="bamt"><input id="spcustom" data-k="custom" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${esc(T.custom)}" aria-label="Custom ETH amount"${T.busy ? " disabled" : ""}><span class="bsym">ETH</span><button type="button" class="sk-btn pri sp-cb" data-act="custombuy"${dis}>Buy</button></div></div>
            ${T.quote && T.quote.side === "buy" ? quoteHtml(T, d) : ""}
            <div class="brow sp-sh"><span class="blab">Sell</span><span class="sm muted">${T.bal && r ? fmtTok(T.bal.tok, d) + " " + esc(r.symbol) : ""}</span></div>
            <div class="sp-sells">${T.cfg.sells.map((p) => `<button type="button" class="sp-sb" data-sell="${p}"${dis || (T.bal && T.bal.tok === 0n ? " disabled" : "")}>${p === 100 ? "Sell all" : p + "%"}</button>`).join("")}</div>
            ${T.quote && T.quote.side === "sell" ? quoteHtml(T, d) : ""}
            ${slipHtml(T)}
            ${msgHtml(T)}
          </div>
        </div>
        ${T.log.length ? `<div class="card sk-card sp-log"><div class="sk-ct"><h2>This session</h2></div>${T.log.slice(0, 8).map((x) => `<div class="sp-lr"><span class="${x.side === "buy" ? "up" : "down"}">${x.side === "buy" ? "Buy" : "Sell"}</span><span>${esc(x.sym)}</span><span class="muted">${esc(x.label)}</span>${C.dev ? `<span class="mono muted">${esc(x.hash.slice(0, 10))}…</span>` : `<a class="mono" href="${C.explorer}/tx/${esc(x.hash)}" target="_blank" rel="noopener">${esc(x.hash.slice(0, 10))}…</a>`}</div>`).join("")}</div>` : ""}
        `;
      if (keep) { const i = root.querySelector(`[data-k="${keep}"]`); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch {} } }
    }
    const load = (v) => { v = String(v || "").trim(); T.ca = v; if (!isAddr(v)) { T.set({ err: "That is not a contract address." }); return; } T.custom = ""; T.quote = null; history.replaceState(null, "", "#/sniper?ca=" + v.toLowerCase()); T.load(v); };
    function onClick(e) {
      const b = e.target.closest("[data-act],[data-buy],[data-sell],[data-slip],[data-wallet]"); if (!b) return;
      if (b.dataset.wallet != null) return T.connect(+b.dataset.wallet);
      if (b.dataset.buy) return T.buy(b.dataset.buy);
      if (b.dataset.sell) return T.sell(+b.dataset.sell);
      if (b.dataset.slip) { T.cfg.slip = +b.dataset.slip; saveCfg(T.cfg); return render(); }
      const a = b.dataset.act;
      if (a === "wallet") WM.show();
      else if (a === "edit") { edit = !edit; if (!edit) { T.cfg.quick = T.cfg.quick.map((q, i) => (toUnits(q) > 0n ? q : DEF.quick[i])); saveCfg(T.cfg); } render(); }
      else if (a === "custombuy") T.buy(T.custom);
      else if (a === "paste") navigator.clipboard && navigator.clipboard.readText().then((t) => load(t)).catch(() => root.querySelector("#spca").focus());
    }
    function onInput(e) {
      const t = e.target;
      if (t.dataset.k === "ca") { T.ca = t.value; if (isAddr(t.value) && (!T.r || T.r.token !== t.value.trim().toLowerCase())) load(t.value); return; }
      if (t.dataset.q != null) { T.cfg.quick[+t.dataset.q] = t.value.replace(/[^\d.]/g, ""); return; }
      if (t.dataset.cfg === "slip") { const v = parseFloat(t.value); if (v > 0 && v <= 50) { T.cfg.slip = v; saveCfg(T.cfg); } return; }
      if (t.dataset.k === "custom") { T.custom = t.value.replace(/[^\d.]/g, ""); clearTimeout(T._qt); T._qt = setTimeout(() => T.preview("buy", toUnits(T.custom)), 250); }
    }
    const onSubmit = (e) => { e.preventDefault(); load(root.querySelector("#spca").value); };
    const onOver = (e) => { const b = e.target.closest("[data-sell]"); if (b && T.bal && T.bal.tok > 0n && !T.busy) { const p = +b.dataset.sell; if (T.sellPct !== p) { T.sellPct = p; T.preview("sell", p >= 100 ? T.bal.tok : (T.bal.tok * BigInt(p)) / 100n); } } };
    el.innerHTML = `<section class="staking sniper-pg" id="sniperpg"></section>`;
    root = el.querySelector("#sniperpg");
    root.addEventListener("click", onClick); root.addEventListener("input", onInput); root.addEventListener("submit", onSubmit); root.addEventListener("mouseover", onOver);
    render(); autoReconnect().then(() => { render(); T.refresh(); });
    const qs = new URLSearchParams((location.hash.split("?")[1]) || ""); const ca = qs.get("ca");
    if (ca && isAddr(ca)) { T.ca = ca; T.load(ca); }
    PS.ensureTokens && PS.ensureTokens().then(() => render());
    timer = setInterval(() => { if (!document.hidden && !T.busy) T.refresh(); }, 12000);
    return () => { clearInterval(timer); root = null; };
  };

  // ---------- token page trade panel ----------
  PS.tradePanel = (box, L) => {
    if (!box) return null;
    let alive = true, amt = "", timer = null;
    const T = controller(() => alive && render());
    function render() {
      const r = T.r, ok = r && (r.stage === "curve" || r.stage === "pool"), d = r ? r.decimals : 18;
      const dis = !ok || T.busy ? " disabled" : "";
      const side = T.side;
      const ae = document.activeElement, keep = ae && ae.dataset && ae.dataset.k, pos = ae && ae.selectionStart;
      box.innerHTML = `
        <div class="tp-h"><b>${ICON.replace('width="26" height="26"', 'width="16" height="16"')}Trade ${esc(L.symbol)}</b>${walletBtn("sm")}</div>
        <div class="seg tp-tabs"><button type="button" data-side="buy" class="${side === "buy" ? "on" : ""}">Buy</button><button type="button" data-side="sell" class="${side === "sell" ? "on" : ""}">Sell</button></div>
        ${!r ? `<div class="loading sm">Loading…</div>` : r.stage === "unsupported" ? `<div class="bwarn">${esc(r.why || "Not tradable here")}</div>` : r.stage === "graduating" ? `<div class="bwarn">Moving to its pool. Trading opens again in a moment.</div>` : ""}
        ${side === "buy" ? `
          <div class="bbox"><div class="brow"><span class="blab">Amount</span><span class="sm muted">${T.bal ? fmt(T.bal.eth, 18, 4) + " ETH" : ""}</span></div>
          <div class="bamt"><input data-k="amt" inputmode="decimal" placeholder="0.0" value="${esc(amt)}" aria-label="ETH amount"${T.busy ? " disabled" : ""}><span class="bsym">ETH</span></div></div>
          <div class="bseg sm sp-pre">${T.cfg.quick.map((q) => `<button type="button" data-amt="${esc(q)}" class="${amt === q ? "on" : ""}">${esc(q)}</button>`).join("")}</div>`
        : `<div class="bbox"><div class="brow"><span class="blab">Sell</span><span class="sm muted">${T.bal && r ? fmtTok(T.bal.tok, d) + " " + esc(r.symbol) : ""}</span></div>
          <div class="bamt out"><span class="mono">${T.sellPct ? (T.sellPct === 100 ? "All" : T.sellPct + "%") : "Pick %"}</span><span class="bsym">${esc(L.symbol)}</span></div></div>
          <div class="bseg sm sp-pre">${T.cfg.sells.map((p) => `<button type="button" data-pct="${p}" class="${T.sellPct === p ? "on" : ""}">${p === 100 ? "Max" : p + "%"}</button>`).join("")}</div>`}
        ${T.quote && T.quote.side === side ? quoteHtml(T, d) : ""}
        ${slipHtml(T)}
        <button type="button" class="bgo tp-go" data-act="go"${dis}>${T.busy ? "Working…" : !ready() ? needLabel() : side === "buy" ? `Buy ${esc(L.symbol)}` : `Sell ${esc(L.symbol)}`}</button>
        ${msgHtml(T)}
        <a class="tp-foot sm" href="#/sniper?ca=${esc(L.address)}">Open in Sniper</a>`;
      if (keep) { const i = box.querySelector(`[data-k="${keep}"]`); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch {} } }
    }
    const pq = () => { if (T.side === "buy") T.preview("buy", toUnits(amt)); else if (T.sellPct && T.bal) T.preview("sell", T.sellPct >= 100 ? T.bal.tok : (T.bal.tok * BigInt(T.sellPct)) / 100n); else T.set({ quote: null }); };
    function onClick(e) {
      const b = e.target.closest("[data-act],[data-side],[data-amt],[data-pct],[data-slip],[data-wallet]"); if (!b) return;
      if (b.dataset.wallet != null) return T.connect(+b.dataset.wallet);
      if (b.dataset.side) { T.side = b.dataset.side; T.quote = null; T.err = ""; T.ok = ""; render(); return pq(); }
      if (b.dataset.amt) { amt = b.dataset.amt; render(); return pq(); }
      if (b.dataset.pct) { T.sellPct = +b.dataset.pct; render(); return pq(); }
      if (b.dataset.slip) { T.cfg.slip = +b.dataset.slip; saveCfg(T.cfg); return render(); }
      const a = b.dataset.act;
      if (a === "wallet") WM.show();
      else if (a === "go") { if (!ready()) return WM.show(); T.side === "buy" ? T.buy(amt) : T.sellPct ? T.sell(T.sellPct) : T.set({ err: "Pick how much to sell." }); }
    }
    function onInput(e) {
      const t = e.target;
      if (t.dataset.k === "amt") { amt = t.value.replace(/[^\d.]/g, ""); clearTimeout(T._qt); T._qt = setTimeout(pq, 250); }
      if (t.dataset.cfg === "slip") { const v = parseFloat(t.value); if (v > 0 && v <= 50) { T.cfg.slip = v; saveCfg(T.cfg); } }
    }
    box.addEventListener("click", onClick); box.addEventListener("input", onInput);
    render(); T.load(L.address); autoReconnect().then(() => { render(); T.refresh(); });
    timer = setInterval(() => { if (!document.hidden && !T.busy) T.refresh(); }, 15000);
    return () => { alive = false; clearInterval(timer); };
  };

  // Nav: drop the Sniper Soon badge once live.
  if (PS.SNIPER_LIVE) { const b = document.querySelector('#mainnav a[data-nav="sniper"] .soon'); b && b.remove(); }
})(window.PS);
