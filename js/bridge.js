/* ScopePump — Bridge page (#/bridge). Relay (relay.link) intents bridge via our /api/relay proxy (no integrator fee).
   Plain JS, injected EIP-1193 wallets with EIP-6963 discovery (MetaMask, Rabby, Coinbase Wallet, ...). */
(function (PS) {
  const { esc } = PS;
  const API = "/api/relay";
  const RH = 4663;
  const NATIVE = "0x0000000000000000000000000000000000000000";
  const PLACEHOLDER_USER = "0x000000000000000000000000000000000000dEaD"; // quote preview before a wallet is connected
  const ETH_ICON = "https://assets.relay.link/icons/1/light.png";
  // Robinhood Chain network params (docs.robinhood.com/chain/connecting)
  const RH_PARAMS = { chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] };
  const RH_TX = "https://robin.etherscan.io/tx/";
  // Chains offered on the other side (kept only if Relay reports them enabled with ETH as gas).
  const CURATED = [8453, 1, 42161, 10, 130, 59144, 57073, 534352];
  const RH_TOKENS = {
    ETH: { symbol: "ETH", address: NATIVE, decimals: 18 },
    USDG: { symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, logo: "https://assets.coingecko.com/coins/images/51281/standard/GDN_USDG_Token_200x200.png" },
  };
  const IMPACT_WARN = 2, IMPACT_HIGH = 5; // percent

  // ---------- helpers ----------
  const hex = (n) => "0x" + BigInt(n).toString(16);
  function toUnits(s, d) {
    s = String(s || "").trim(); if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
    let [i, f = ""] = s.split("."); f = (f + "0".repeat(d)).slice(0, d);
    return BigInt(i || "0") * 10n ** BigInt(d) + BigInt(f || "0");
  }
  function fromUnits(v, d, max = 6) {
    v = BigInt(v); const neg = v < 0n; if (neg) v = -v;
    const b = 10n ** BigInt(d), i = v / b; let f = (v % b).toString().padStart(d, "0").slice(0, max).replace(/0+$/, "");
    return (neg ? "-" : "") + i.toLocaleString("en-US") + (f ? "." + f : "");
  }
  function fmtNum(s, max = 6) { const n = Number(s); if (!isFinite(n)) return "—"; if (n === 0) return "0"; if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 }); if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 }); return n.toLocaleString("en-US", { maximumSignificantDigits: max }); }
  const usd = (s) => { const n = Number(s); return isFinite(n) ? (n < 0.01 && n > 0 ? "<$0.01" : "$" + n.toFixed(2)) : "—"; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function j(url, init) {
    const r = await fetch(url, init); let d = null; try { d = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((d && (d.message || d.error)) || "HTTP " + r.status); e.status = r.status; e.code = d && d.errorCode; throw e; }
    return d;
  }

  // ---------- Relay chain metadata ----------
  let CH = null; // Map id -> chain
  async function chains() {
    if (CH) return CH;
    const d = await j(API + "?ep=chains");
    CH = new Map();
    for (const c of d.chains || []) if (!c.disabled && c.depositEnabled && c.vmType === "evm" && c.currency && c.currency.symbol === "ETH") CH.set(c.id, c);
    return CH;
  }
  const others = () => CURATED.filter((id) => CH && CH.has(id)).map((id) => CH.get(id));
  function token(chainId, sym) {
    if (sym === "ETH") return { symbol: "ETH", address: NATIVE, decimals: 18, logo: ETH_ICON };
    if (chainId === RH) return RH_TOKENS[sym] || null;
    const c = CH && CH.get(chainId); const t = c && (c.erc20Currencies || []).find((x) => x.symbol === sym);
    if (!t) return null;
    const f = (c.featuredTokens || []).find((x) => x.symbol === sym);
    return { symbol: t.symbol, address: t.address, decimals: t.decimals, logo: f && f.metadata && f.metadata.logoURI };
  }
  const rpcUrl = (id) => (id === RH ? RH_PARAMS.rpcUrls[0] : CH && CH.get(id) && CH.get(id).httpRpcUrl);
  const explorer = (id) => (id === RH ? "https://robin.etherscan.io" : (CH && CH.get(id) && CH.get(id).explorerUrl) || "");
  const chainName = (id) => (id === RH ? "Robinhood Chain" : (CH && CH.get(id) && CH.get(id).displayName) || "Chain " + id);
  const chainIcon = (id) => `https://assets.relay.link/icons/${id}/light.png`;

  // ---------- wallet (EIP-6963 + window.ethereum fallback) ----------
  const W = PS.wallet = PS.wallet || { list: [], p: null, info: null, account: null, chainId: null, hooked: new WeakSet() };
  if (!W.discovering) {
    W.discovering = true;
    window.addEventListener("eip6963:announceProvider", (e) => {
      const d = e.detail; if (!d || !d.provider || !d.info) return;
      if (!W.list.some((x) => x.info.uuid === d.info.uuid)) W.list.push(d);
      PS.bridgeRender && PS.bridgeRender();
    });
  }
  function requestWallets() { window.dispatchEvent(new Event("eip6963:requestProvider")); }
  function walletOptions() {
    const l = W.list.slice();
    if (!l.length && window.ethereum) l.push({ info: { uuid: "injected", name: window.ethereum.isMetaMask ? "MetaMask" : window.ethereum.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet", icon: "", rdns: "injected" }, provider: window.ethereum });
    return l;
  }
  function hook(p) {
    if (W.hooked.has(p) || !p.on) return; W.hooked.add(p);
    p.on("accountsChanged", (a) => { if (W.p !== p) return; W.account = (a && a[0]) || null; if (!W.account) localStorage.removeItem("ps_wallet"); PS.bridgeChanged && PS.bridgeChanged("account"); });
    p.on("chainChanged", (c) => { if (W.p !== p) return; W.chainId = parseInt(c, 16); PS.bridgeChanged && PS.bridgeChanged("chain"); });
  }
  async function useWallet(opt, prompt) {
    const p = opt.provider;
    const acc = await p.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" });
    if (!acc || !acc[0]) return false;
    W.p = p; W.info = opt.info; W.account = acc[0];
    W.chainId = parseInt(await p.request({ method: "eth_chainId" }), 16);
    hook(p); localStorage.setItem("ps_wallet", opt.info.rdns || opt.info.name);
    return true;
  }
  async function autoReconnect() {
    const want = localStorage.getItem("ps_wallet"); if (!want || W.account) return;
    await sleep(250);
    const o = walletOptions().find((x) => (x.info.rdns || x.info.name) === want);
    if (o) { try { await useWallet(o, false); } catch {} }
  }
  async function ensureChain(id) {
    if (W.chainId === id) return;
    const p = W.p, cid = hex(id);
    try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cid }] }); }
    catch (e) {
      const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e && e.message))) throw e;
      const params = id === RH ? RH_PARAMS : { chainId: cid, chainName: chainName(id), nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [rpcUrl(id)], blockExplorerUrls: [explorer(id)] };
      await p.request({ method: "wallet_addEthereumChain", params: [params] });
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cid }] }).catch(() => {});
    }
    W.chainId = parseInt(await p.request({ method: "eth_chainId" }), 16);
    if (W.chainId !== id) throw new Error("Please switch your wallet to " + chainName(id));
  }

  // ---------- balances ----------
  async function rpc(chainId, method, params) {
    if (W.p && W.chainId === chainId) return W.p.request({ method, params });
    const u = rpcUrl(chainId); if (!u) throw new Error("no rpc");
    const d = await j(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (d.error) throw new Error(d.error.message); return d.result;
  }
  async function balanceOf(chainId, t, who) {
    if (t.address === NATIVE) return BigInt(await rpc(chainId, "eth_getBalance", [who, "latest"]));
    const r = await rpc(chainId, "eth_call", [{ to: t.address, data: "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0") }, "latest"]);
    return BigInt(r && r !== "0x" ? r : 0);
  }

  // ---------- page state ----------
  const S = { dir: "in", other: 8453, fromSym: "ETH", toSym: "ETH", amount: "0.1", slip: "auto", quote: null, qErr: "", qLoading: false, qKey: "", ack: false, bal: null, balKey: "", busy: false, steps: [], status: "", done: null, err: "" };
  const route = () => {
    const fromChain = S.dir === "in" ? S.other : RH, toChain = S.dir === "in" ? RH : S.other;
    return { fromChain, toChain, from: token(fromChain, S.fromSym), to: token(toChain, S.toSym) };
  };
  const fromSyms = () => (S.dir === "in" ? ["ETH", "USDC"].filter((s) => token(S.other, s)) : ["ETH", "USDG"]);
  const toSyms = () => (S.dir === "in" ? ["ETH", "USDG"] : ["ETH", "USDC"].filter((s) => token(S.other, s)));
  const isBuy = () => S.dir === "in" && S.toSym !== "ETH";
  function impact(q) {
    if (!q || !q.details) return null;
    const a = Math.abs(Number(q.details.swapImpact && q.details.swapImpact.percent) || 0), b = Math.abs(Number(q.details.totalImpact && q.details.totalImpact.percent) || 0);
    return { swap: a, total: b, worst: Math.max(a, b) };
  }

  let root = null, qTimer = null, refreshTimer = null, qSeq = 0;
  function scheduleQuote(delay = 450) { clearTimeout(qTimer); qTimer = setTimeout(getQuote, delay); }
  async function getQuote() {
    const { fromChain, toChain, from, to } = route();
    const amt = from ? toUnits(S.amount, from.decimals) : 0n;
    if (!from || !to || amt <= 0n) { S.quote = null; S.qErr = ""; S.qLoading = false; S.qKey = ""; render(); return; }
    const user = W.account || PLACEHOLDER_USER;
    const body = { user, recipient: user, originChainId: fromChain, destinationChainId: toChain, originCurrency: from.address, destinationCurrency: to.address, amount: amt.toString(), tradeType: "EXACT_INPUT" };
    if (S.slip !== "auto") body.slippageTolerance = String(Math.round(Number(S.slip) * 100));
    const key = JSON.stringify(body); const seq = ++qSeq;
    if (key !== S.qKey) { S.ack = false; }
    S.qLoading = true; render();
    try {
      const q = await j(API + "?ep=quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (seq !== qSeq) return;
      S.quote = q; S.qErr = ""; S.qKey = key; S.quoteAt = Date.now();
    } catch (e) {
      if (seq !== qSeq) return;
      S.quote = null; S.qKey = key;
      S.qErr = e.code === "AMOUNT_TOO_LOW" ? "Amount too low for this route." : e.status === 429 ? "Too many requests, wait a moment." : e.message || "Quote unavailable.";
    }
    S.qLoading = false; render();
  }
  async function loadBalance() {
    const { fromChain, from } = route();
    if (!W.account || !from) { S.bal = null; render(); return; }
    const k = [W.account, fromChain, from.address].join("|"); S.balKey = k;
    try { const b = await balanceOf(fromChain, from, W.account); if (S.balKey === k) { S.bal = b; render(); } }
    catch { if (S.balKey === k) { S.bal = null; render(); } }
  }
  function changed(what) {
    if (what !== "amount") { S.bal = null; loadBalance(); }
    S.done = null; S.err = ""; S.quote = null; S.qErr = ""; qSeq++; // never show a quote for different inputs
    if (what !== "amount") render();
    scheduleQuote(what === "amount" ? 450 : 50);
  }
  PS.bridgeChanged = (what) => { if (!root) return; if (what === "account") { loadBalance(); scheduleQuote(50); } else { loadBalance(); render(); } };
  PS.bridgeRender = () => root && render();

  // ---------- execution ----------
  async function execute() {
    const { fromChain, toChain } = route();
    S.busy = true; S.err = ""; S.done = null; S.steps = []; S.status = "Getting a fresh quote…"; render();
    try {
      await getQuote(); // fresh quote for the connected address
      const q = S.quote; if (!q || !q.steps) throw new Error(S.qErr || "No quote");
      const imp = impact(q); if (imp && imp.worst >= IMPACT_HIGH && !S.ack) throw new Error("Confirm the price impact first.");
      const txs = []; let requestId = null;
      for (const step of q.steps) {
        if (step.kind !== "transaction") throw new Error("This route needs a signature step, which this page does not support yet. Try ETH.");
        for (const item of step.items || []) {
          if (item.status === "complete") continue;
          const d = item.data; const cid = Number(d.chainId);
          S.status = `Switching to ${chainName(cid)}…`; render();
          await ensureChain(cid);
          const label = step.id === "approve" ? "Approve " + S.fromSym : "Bridge";
          S.status = `${label}: confirm in your wallet`; render();
          const tx = { from: W.account, to: d.to, data: d.data || "0x", value: hex(d.value || 0), chainId: hex(cid) };
          if (d.gas) tx.gas = hex(d.gas);
          const hash = await W.p.request({ method: "eth_sendTransaction", params: [tx] });
          txs.push({ chainId: cid, hash, label }); S.steps = txs.slice(); S.status = `${label}: waiting for confirmation…`; render();
          await waitReceipt(cid, hash);
          const ep = item.check && item.check.endpoint; const m = ep && /requestId=(0x[0-9a-fA-F]{64})/.exec(ep);
          if (m) { requestId = m[1]; await waitRelay(requestId); }
        }
      }
      if (!requestId) requestId = q.steps.find((s) => s.requestId) && q.steps.find((s) => s.requestId).requestId;
      S.done = { txs, requestId, dest: S.destTxs || [], fromChain, toChain, out: q.details && q.details.currencyOut };
      S.status = ""; S.amount = ""; S.quote = null; S.qKey = "";
      loadBalance();
    } catch (e) {
      const rejected = e && (e.code === 4001 || /reject|denied|cancel/i.test(String(e.message)));
      S.err = rejected ? "Request rejected in wallet." : (e && e.message) || "Something went wrong.";
      S.status = "";
    }
    S.busy = false; render();
  }
  async function waitReceipt(chainId, hash) {
    for (let i = 0; i < 180; i++) {
      let r = null; try { r = await W.p.request({ method: "eth_getTransactionReceipt", params: [hash] }); } catch {}
      if (!r) { try { r = await rpc(chainId, "eth_getTransactionReceipt", [hash]); } catch {} }
      if (r && r.blockNumber) { if (r.status === "0x0") throw new Error("Transaction failed on " + chainName(chainId) + "."); return r; }
      await sleep(2000);
    }
    throw new Error("Timed out waiting for confirmation. Check your wallet activity.");
  }
  async function waitRelay(id) {
    S.destTxs = [];
    for (let i = 0; i < 150; i++) {
      let d = null; try { d = await j(API + "?ep=status&requestId=" + id); } catch {}
      const st = d && d.status;
      if (st) { S.status = st === "success" ? "Arrived" : st === "waiting" || st === "pending" || st === "submitted" ? "Relay is filling your order…" : st === "delayed" ? "Delayed, still processing…" : "Status: " + st; render(); }
      if (st === "success") { S.destTxs = d.txHashes || []; return; }
      if (st === "failure" || st === "refund" || st === "refunded") throw new Error(st === "failure" ? "Relay reported a failure. Funds are refunded per Relay's rules; see the Relay link." : "Order refunded by Relay.");
      await sleep(2000);
    }
    throw new Error("Still processing. Track it on relay.link.");
  }

  // ---------- render ----------
  const tokIcon = (t, chainId) => {
    if (!t) return "";
    if (false) {
      const L = (PS.listState && PS.listState.all || []).find((x) => x.address && x.address.toLowerCase() === t.address.toLowerCase());
      if (L) return PS.logo(L, 20);
    }
    const src = t.logo || (t.symbol === "ETH" ? ETH_ICON : "");
    return src ? `<img class="bti" src="${esc(src)}" alt="" width="20" height="20">` : `<span class="bti ph">${esc(t.symbol[0])}</span>`;
  };
  function button() {
    const { fromChain, from } = route();
    const amt = from ? toUnits(S.amount, from.decimals) : 0n; const imp = impact(S.quote);
    if (S.busy) return { t: S.status || "Working…", dis: true };
    if (!W.account) return { t: walletOptions().length ? "Connect wallet" : "No wallet detected", act: "connect", dis: false };
    if (amt <= 0n) return { t: "Enter an amount", dis: true };
    if (S.bal !== null && amt > S.bal) return { t: `Insufficient ${S.fromSym} balance`, dis: true };
    if (S.qErr) return { t: "Quote unavailable", dis: true };
    if (!S.quote) return { t: "Getting quote…", dis: true };
    if (W.chainId !== fromChain) return { t: `Switch to ${chainName(fromChain)}`, act: "switch" };
    if (imp && imp.worst >= IMPACT_HIGH && !S.ack) return { t: "Confirm price impact above", dis: true };
    const needsApprove = S.quote.steps && S.quote.steps.some((s) => s.id === "approve");
    return { t: (needsApprove ? "Approve and " : "") + (isBuy() ? `Bridge and buy ${S.toSym}` : "Bridge"), act: "go" };
  }
  function render() {
    if (!root) return;
    const { fromChain, toChain, from, to } = route();
    const q = S.quote, d = q && q.details, imp = impact(q);
    const chainSel = (id, side) => {
      if (id === RH) return `<div class="bchain fixed"><img src="${chainIcon(RH)}" alt="" width="22" height="22"><span>Robinhood Chain</span></div>`;
      return `<label class="bchain"><img src="${chainIcon(id)}" alt="" width="22" height="22"><select data-k="other" aria-label="${side} chain">${others().map((c) => `<option value="${c.id}"${c.id === id ? " selected" : ""}>${esc(c.displayName)}</option>`).join("")}</select><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></label>`;
    };
    const seg = (k, list, cur, chainId) => `<div class="bseg" role="radiogroup">${list.map((s) => `<button type="button" role="radio" aria-checked="${s === cur}" data-${k}="${s}" class="${s === cur ? "on" : ""}">${tokIcon(token(chainId, s), chainId)}<span>${s}</span></button>`).join("")}</div>`;
    const balTxt = W.account && from ? (S.bal === null ? "Balance —" : "Balance " + fromUnits(S.bal, from.decimals, from.decimals === 6 ? 2 : 6)) : "";
    const outAmt = d && d.currencyOut ? fmtNum(d.currencyOut.amountFormatted) : S.qLoading ? "…" : "0";
    const minOut = d && d.currencyOut && d.currencyOut.minimumAmount && to ? fromUnits(d.currencyOut.minimumAmount, to.decimals, 6) : null;
    const fees = q && q.fees || {};
    const sev = imp ? (imp.worst >= IMPACT_HIGH ? "high" : imp.worst >= IMPACT_WARN ? "warn" : "") : "";
    const B = button();
    const wl = W.account ? `<button type="button" class="wbtn on" data-act="wallet" title="Disconnect">${W.info && W.info.icon ? `<img src="${esc(W.info.icon)}" alt="" width="16" height="16">` : '<i class="dot"></i>'}<span class="mono">${PS.short(W.account)}</span></button>` : `<button type="button" class="wbtn" data-act="connect">Connect wallet</button>`;
    root.innerHTML = `
      <div class="bhead"><div><h1>Bridge</h1><p class="muted">Move ETH to and from Robinhood Chain in seconds.</p></div>${wl}</div>
      <div class="bcard">
        <div class="bbox">
          <div class="brow"><span class="blab">From</span>${chainSel(fromChain, "From")}</div>
          ${seg("from", fromSyms(), S.fromSym, fromChain)}
          <div class="bamt"><input id="bamount" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${esc(S.amount)}" aria-label="Amount"${S.busy ? " disabled" : ""}><span class="bsym">${esc(S.fromSym)}</span></div>
          <div class="bbal"><span>${balTxt}</span>${W.account && S.bal ? `<button type="button" data-act="max">Max</button>` : ""}</div>
        </div>
        <button type="button" class="bflip" data-act="flip" aria-label="Switch direction" title="Switch direction"${S.busy ? " disabled" : ""}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg></button>
        <div class="bbox">
          <div class="brow"><span class="blab">To</span>${chainSel(toChain, "To")}</div>
          ${seg("to", toSyms(), S.toSym, toChain)}
          <div class="bamt out"><span class="${S.qLoading ? "pulse" : ""}">${outAmt}</span><span class="bsym">${esc(S.toSym)}</span></div>
          ${isBuy() ? `<div class="bnote">Bridges your ${esc(S.fromSym)} and buys ${esc(S.toSym)} on Robinhood Chain in one step.</div>` : ""}
        </div>
        <div class="bslip"><span>Max slippage</span><div class="bseg sm">${["auto", "0.5", "1", "3"].map((v) => `<button type="button" data-slip="${v}" class="${S.slip === v ? "on" : ""}">${v === "auto" ? "Auto" : v + "%"}</button>`).join("")}</div></div>
        ${q && d ? `<div class="bq">
          <div><span>You receive</span><b class="mono">${fmtNum(d.currencyOut.amountFormatted)} ${esc(S.toSym)}</b></div>
          ${minOut ? `<div><span>Minimum received</span><span class="mono">${minOut} ${esc(S.toSym)}</span></div>` : ""}
          <div><span>Price impact</span><span class="mono ${sev}">${imp ? "-" + imp.worst.toFixed(2) + "%" : "—"}</span></div>
          <div><span>Estimated time</span><span>${d.timeEstimate != null ? "~" + d.timeEstimate + "s" : "—"}</span></div>
          <div><span>Network fee</span><span class="mono">${usd(fees.gas && fees.gas.amountUsd)}</span></div>
          <div><span>Relay fee</span><span class="mono">${usd(fees.relayer && fees.relayer.amountUsd)}</span></div>
          <div><span>ScopePump fee</span><span class="mono">$0.00</span></div>
        </div>` : S.qErr ? `<div class="berr">${esc(S.qErr)}</div>` : ""}
        ${sev === "high" ? `<label class="bwarn high"><input type="checkbox" data-act="ack"${S.ack ? " checked" : ""}><span><b>High price impact (${imp.worst.toFixed(2)}%).</b> ${esc(S.toSym)} liquidity is thin, so you would receive much less than the market price. Tick to continue anyway.</span></label>` : sev === "warn" ? `<div class="bwarn">Price impact is ${imp.worst.toFixed(2)}%. Consider a smaller amount.</div>` : ""}
        <button type="button" class="bgo" data-act="${B.act || ""}"${B.dis ? " disabled" : ""}>${esc(B.t)}</button>
        ${S.err ? `<div class="berr">${esc(S.err)}</div>` : ""}
        ${S.busy && S.steps.length ? `<div class="bprog">${S.steps.map((t) => `<a href="${explorer(t.chainId)}/tx/${t.hash}" target="_blank" rel="noopener">${esc(t.label)} tx on ${esc(chainName(t.chainId))}</a>`).join("")}</div>` : ""}
        ${S.done ? `<div class="bdone"><b>Done.</b> ${S.done.out ? esc(fmtNum(S.done.out.amountFormatted)) + " " + esc(S.done.out.currency.symbol) + " sent to " + esc(chainName(S.done.toChain)) + "." : ""}
          <div class="blinks">${S.done.txs.map((t) => `<a href="${explorer(t.chainId)}/tx/${t.hash}" target="_blank" rel="noopener">${esc(t.label)} tx (${esc(chainName(t.chainId))})</a>`).join("")}
          ${S.done.dest.map((h) => `<a href="${S.done.toChain === RH ? RH_TX + h : explorer(S.done.toChain) + "/tx/" + h}" target="_blank" rel="noopener">Destination tx (${esc(chainName(S.done.toChain))})</a>`).join("")}
          ${S.done.requestId ? `<a href="https://relay.link/transaction/${S.done.requestId}" target="_blank" rel="noopener">View on Relay</a>` : ""}</div></div>` : ""}
      </div>
      ${S.pick ? `<div class="bmodal" data-act="close"><div class="bpick" role="dialog" aria-label="Choose a wallet"><b>Connect a wallet</b>${walletOptions().length ? walletOptions().map((o, i) => `<button type="button" data-wallet="${i}">${o.info.icon ? `<img src="${esc(o.info.icon)}" alt="" width="24" height="24">` : '<span class="bti ph">W</span>'}<span>${esc(o.info.name)}</span></button>`).join("") : `<p class="muted">No browser wallet detected. Install MetaMask, Rabby or Coinbase Wallet, then reload this page.</p>`}<button type="button" class="bclose" data-act="close">Cancel</button></div></div>` : ""}`;
    const inp = root.querySelector("#bamount");
    if (S.focusAmt && inp) { inp.focus(); const n = inp.value.length; inp.setSelectionRange(n, n); }
  }

  // ---------- events ----------
  async function onClick(e) {
    const el = e.target.closest("[data-act],[data-from],[data-to],[data-slip],[data-wallet]"); if (!el || !root.contains(el)) return;
    if (el.dataset.from && !S.busy) { S.fromSym = el.dataset.from; S.amount = ""; changed("token"); return; }
    if (el.dataset.to && !S.busy) { S.toSym = el.dataset.to; changed("token"); return; }
    if (el.dataset.slip && !S.busy) { S.slip = el.dataset.slip; changed("slip"); return; }
    if (el.dataset.wallet) { const o = walletOptions()[+el.dataset.wallet]; S.pick = false; render(); try { await useWallet(o, true); changed("wallet"); } catch (er) { S.err = er && er.code === 4001 ? "Connection rejected in wallet." : (er && er.message) || "Could not connect."; render(); } return; }
    const a = el.dataset.act;
    if (a === "close") { if (e.target === el || el.classList.contains("bclose")) { S.pick = false; render(); } return; }
    if (a === "connect") { requestWallets(); const l = walletOptions(); if (l.length === 1) { try { await useWallet(l[0], true); changed("wallet"); } catch (er) { S.err = er && er.code === 4001 ? "Connection rejected in wallet." : (er && er.message) || "Could not connect."; render(); } } else { S.pick = true; render(); } return; }
    if (a === "wallet") { if (confirm("Disconnect this wallet from ScopePump?")) { W.account = null; W.p = null; localStorage.removeItem("ps_wallet"); changed("wallet"); } return; }
    if (a === "flip" && !S.busy) { S.dir = S.dir === "in" ? "out" : "in"; S.fromSym = "ETH"; S.toSym = "ETH"; S.amount = ""; changed("dir"); return; }
    if (a === "max" && S.bal) { const { fromChain, from } = route(); let v = S.bal; if (from.address === NATIVE) { const reserve = fromChain === 1 ? 3n * 10n ** 15n : 2n * 10n ** 14n; v = v > reserve ? v - reserve : 0n; } S.amount = fromUnits(v, from.decimals, from.decimals).replace(/,/g, ""); changed("amount"); return; }
    if (a === "ack") { S.ack = el.checked; render(); return; }
    if (a === "switch") { try { await ensureChain(route().fromChain); S.err = ""; } catch (er) { S.err = er && er.code === 4001 ? "Network switch rejected." : (er && er.message) || "Could not switch network."; } loadBalance(); render(); return; }
    if (a === "go") { execute(); return; }
  }
  function onInput(e) {
    if (e.target.id === "bamount") { const v = e.target.value.replace(",", "."); if (!/^\d*\.?\d*$/.test(v)) { e.target.value = S.amount; return; } if (v === S.amount) return; S.amount = v; S.focusAmt = true; S.done = null; S.err = ""; S.quote = null; S.qErr = ""; qSeq++; render(); scheduleQuote(450); return; }
  }
  function onChange(e) { if (e.target.dataset.k === "other" && !S.busy) { S.other = +e.target.value; if (!fromSyms().includes(S.fromSym)) S.fromSym = "ETH"; if (!toSyms().includes(S.toSym)) S.toSym = "ETH"; changed("chain"); } }

  PS.bridgePage = (el) => {
    document.title = "Bridge to Robinhood Chain — ScopePump";
    el.innerHTML = `<section class="bridge" id="bridge"><div class="loading">Loading bridge…</div></section>`;
    root = el.querySelector("#bridge");
    root.addEventListener("click", onClick); root.addEventListener("input", onInput); root.addEventListener("change", onChange);
    root.addEventListener("focusout", (e) => { if (e.target.id === "bamount") S.focusAmt = false; });
    requestWallets();
    PS.ensureTokens && PS.ensureTokens().then(() => render());
    chains().then(async () => { if (!CH.has(S.other)) S.other = (others()[0] || {}).id || 8453; await autoReconnect(); render(); loadBalance(); scheduleQuote(10); })
      .catch(() => { root.innerHTML = `<div class="berr">Could not load bridge routes from Relay. Please try again later.</div>`; });
    refreshTimer = setInterval(() => { if (!S.busy && S.quote && document.visibilityState === "visible" && Date.now() - (S.quoteAt || 0) > 20000) getQuote(); }, 5000);
    return () => { clearInterval(refreshTimer); clearTimeout(qTimer); root = null; };
  };
})(window.PS);
