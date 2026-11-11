/* ScopePump — Staking page (#/staking).
   Stake $SCOPEPUMP into a 7 / 30 / 90 day lock, earn native ETH deposited by the ScopePump team.
   Contract: ScopePumpStaking (/workspace/ponscope/staking/contract/src/ScopePumpStaking.sol). Plain JS, raw JSON-RPC, injected EIP-1193 wallet.
   Every number on this page is read from the chain. While STAKING.address is empty the page shows how staking works,
   the planned tiers and a "contract not deployed yet" note, with no numbers. */
(function (PS) {
  const { esc } = PS;

  // ---------- single config constant: set `address` after the contract is deployed ----------
  const STAKING = {
    address: String((window.SCOPEPUMP_CONFIG || {}).STAKING || "").trim(), // ScopePumpStaking address, from js/config.js. Empty = Soon.
    token: (/^0x[0-9a-fA-F]{40}$/.test(String((window.SCOPEPUMP_CONFIG || {}).CA || "")) ? String(window.SCOPEPUMP_CONFIG.CA) : "0x5338e45ca67c7727b8f720deee713808ab5878fe").toLowerCase(), // $SCOPEPUMP EVM staking token on Robinhood Chain
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
  };
  // Local testing only (localhost / 127.0.0.1): localStorage "ps_staking_dev" = {"address","token","chainId","rpc"} points the page at an anvil node.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    try { const d = JSON.parse(localStorage.getItem("ps_staking_dev") || "null"); if (d && /^0x[0-9a-fA-F]{40}$/.test(d.address || "")) Object.assign(STAKING, d, { dev: true }); } catch {}
  }
  const LIVE = /^0x[0-9a-fA-F]{40}$/.test(STAKING.address);
  PS.STAKING = STAKING; PS.STAKING_LIVE = LIVE;

  // Planned tiers shown before launch (the deployed contract's own values are shown once live).
  const PLANNED_TIERS = [{ days: 7, bps: 10000 }, { days: 30, bps: 15000 }, { days: 90, bps: 25000 }];
  const RH_PARAMS = { chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] };
  const PRECISION = 10n ** 36n;
  const SEL = {
    totalStaked: "0x817b1cd2", accRewardPerWeight: "0xaa6bb09a", totalRewardsDistributed: "0xee172546", queuedRewards: "0x63d38c3b",
    stakingPaused: "0xbbb781cc", tiers: "0x4a95d9d5", positionsOf: "0xf867d46b", unclaimedRewards: "0x949813b8",
    stake: "0x10087fb1", withdraw: "0x2e1a7d4d", claimAll: "0xd1058e59",
    approve: "0x095ea7b3", allowance: "0xdd62ed3e", balanceOf: "0x70a08231", totalSupply: "0x18160ddd", decimals: "0x313ce567", symbol: "0x95d89b41",
  };


  // ---------- helpers ----------
  const hex = (n) => "0x" + BigInt(n).toString(16);
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  const words = (h) => { h = (h || "0x").slice(2); const out = []; for (let i = 0; i < h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64))); return out; };
  function toUnits(s, d) {
    s = String(s || "").trim(); if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
    let [i, f = ""] = s.split("."); if (f.length > d) f = f.slice(0, d); f = f.padEnd(d, "0");
    return BigInt(i || "0") * 10n ** BigInt(d) + BigInt(f || "0");
  }
  function fmt(v, d = 18, max = 4) {
    v = BigInt(v); const b = 10n ** BigInt(d), i = v / b;
    let f = (v % b).toString().padStart(d, "0").slice(0, max).replace(/0+$/, "");
    if (i === 0n && !f && v > 0n) { // tiny non-zero: show significant digits instead of 0
      const full = (v % b).toString().padStart(d, "0"); const nz = full.search(/[1-9]/); f = full.slice(0, Math.min(d, nz + 3)).replace(/0+$/, "");
    }
    return i.toLocaleString("en-US") + (f ? "." + f : "");
  }
  const plain = (v, d) => fmt(v, d, d).replace(/,/g, "");
  const mult = (bps) => { const x = Number(bps) / 10000; return (Number.isInteger(x) ? x.toFixed(1) : String(+x.toFixed(2))) + "x"; };
  const days = (sec) => Math.round(Number(sec) / 86400);
  const dateFmt = (ts) => new Date(Number(ts) * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  function left(ts) {
    const s = Number(ts) - Date.now() / 1000; if (s <= 0) return "Unlocked";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${Math.max(1, m)}m left`;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errMsg = (e) => {
    if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) return "Request rejected in wallet.";
    const m = (e && (e.data && e.data.message || e.message)) || "Something went wrong.";
    return String(m).replace(/^execution reverted:?\s*/i, "Transaction would fail: ").slice(0, 220);
  };

  // ---------- chain reads ----------
  let rpcId = 0;
  async function rpc(method, params) {
    const r = await fetch(STAKING.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    const d = await r.json(); if (d.error) { const e = new Error(d.error.message || "RPC error"); e.data = d.error.data; throw e; } return d.result;
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  async function readGlobal() {
    const C = STAKING.address, T = STAKING.token;
    const [ts, acc, dist, queued, paused, tiers, supply, dec] = await Promise.all([
      call(C, SEL.totalStaked), call(C, SEL.accRewardPerWeight), call(C, SEL.totalRewardsDistributed), call(C, SEL.queuedRewards),
      call(C, SEL.stakingPaused), call(C, SEL.tiers), call(T, SEL.totalSupply), S.decimals == null ? call(T, SEL.decimals) : null,
    ]);
    if (dec) S.decimals = Number(words(dec)[0]);
    const tw = words(tiers);
    return {
      totalStaked: words(ts)[0], acc: words(acc)[0], distributed: words(dist)[0], queued: words(queued)[0], paused: words(paused)[0] === 1n,
      tiers: [0, 1, 2].map((i) => ({ duration: tw[i * 2], bps: tw[i * 2 + 1] })), supply: words(supply)[0],
    };
  }
  async function readUser(a) {
    const C = STAKING.address, T = STAKING.token;
    const [pos, unc, bal, alw, eth] = await Promise.all([
      call(C, SEL.positionsOf + addrWord(a)), call(C, SEL.unclaimedRewards + addrWord(a)),
      call(T, SEL.balanceOf + addrWord(a)), call(T, SEL.allowance + addrWord(a) + addrWord(C)), rpc("eth_getBalance", [a, "latest"]),
    ]);
    const w = words(pos), n = Number(w[1] || 0n), list = [];
    for (let i = 0; i < n; i++) {
      const o = 2 + i * 7;
      list.push({ id: i, amount: w[o], start: w[o + 1], unlockAt: w[o + 2], tier: Number(w[o + 3]), withdrawn: w[o + 4] === 1n, weight: w[o + 5], debt: w[o + 6] });
    }
    return { positions: list, unclaimed: words(unc)[0], bal: words(bal)[0], allowance: words(alw)[0], eth: BigInt(eth) };
  }
  const pendingOf = (p) => { if (p.withdrawn || !S.g) return 0n; const a = (p.weight * S.g.acc) / PRECISION; return a > p.debt ? a - p.debt : 0n; };

  // ---------- wallet (shares PS.wallet with the bridge page) ----------
  const W = PS.wallet = PS.wallet || { list: [], p: null, info: null, account: null, chainId: null, hooked: new WeakSet() };
  W.hookedStake = W.hookedStake || new WeakSet();
  if (!W.discoveringStake) {
    W.discoveringStake = true;
    window.addEventListener("eip6963:announceProvider", (e) => {
      const d = e.detail; if (!d || !d.provider || !d.info) return;
      if (!W.list.some((x) => x.info.uuid === d.info.uuid)) W.list.push(d);
      root && render();
    });
  }
  const requestWallets = () => window.dispatchEvent(new Event("eip6963:requestProvider"));
  function walletOptions() {
    const l = W.list.slice();
    if (!l.length && window.ethereum) l.push({ info: { uuid: "injected", name: window.ethereum.isMetaMask ? "MetaMask" : window.ethereum.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet", icon: "", rdns: "injected" }, provider: window.ethereum });
    return l;
  }
  function hook(p) {
    if (W.hookedStake.has(p) || !p.on) return; W.hookedStake.add(p);
    p.on("accountsChanged", (a) => { if (W.p !== p) return; W.account = (a && a[0]) || null; if (!W.account) localStorage.removeItem("ps_wallet"); S.user = null; root && (render(), refresh()); });
    p.on("chainChanged", (c) => { if (W.p !== p) return; W.chainId = parseInt(c, 16); root && render(); });
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
    const want = localStorage.getItem("ps_wallet"); if (!want || W.account) { W.account && W.p && hook(W.p); return; }
    await sleep(250);
    const o = walletOptions().find((x) => (x.info.rdns || x.info.name) === want);
    if (o) { try { await useWallet(o, false); } catch {} }
  }
  async function ensureChain() {
    const id = STAKING.chainId; if (W.chainId === id) return;
    const cid = hex(id);
    try { await W.p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cid }] }); }
    catch (e) {
      const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e && e.message))) throw e;
      if (id !== 4663) throw e;
      await W.p.request({ method: "wallet_addEthereumChain", params: [RH_PARAMS] });
      await W.p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: cid }] }).catch(() => {});
    }
    W.chainId = parseInt(await W.p.request({ method: "eth_chainId" }), 16);
    if (W.chainId !== id) throw new Error("Please switch your wallet to Robinhood Chain.");
  }
  async function send(to, data, label) {
    await ensureChain();
    S.status = `${label}: confirm in your wallet`; render();
    // Explicit gas limit and gasPrice: some wallets on Robinhood Chain only confirm when both are set.
    const [est, gp] = await Promise.all([rpc("eth_estimateGas", [{ from: W.account, to, data, value: "0x0" }]), rpc("eth_gasPrice", [])]);
    const gas = (BigInt(est) * 13n) / 10n, gasPrice = (BigInt(gp) * 12n) / 10n;
    const hash = await W.p.request({ method: "eth_sendTransaction", params: [{ from: W.account, to, data, value: "0x0", gas: hex(gas), gasPrice: hex(gasPrice), chainId: hex(STAKING.chainId) }] });
    S.lastTx = hash; S.status = `${label}: waiting for confirmation`; render();
    for (let i = 0; i < 120; i++) {
      let r = null; try { r = await rpc("eth_getTransactionReceipt", [hash]); } catch {}
      if (r && r.blockNumber) { if (r.status === "0x0") throw new Error(label + " failed on-chain."); return hash; }
      await sleep(i < 10 ? 1000 : 2000);
    }
    throw new Error("Timed out waiting for confirmation. Check your wallet activity.");
  }

  // ---------- page state ----------
  const S = { g: null, user: null, decimals: null, amount: "", tier: 2, busy: false, status: "", err: "", ok: "", lastTx: null, pick: false, loadErr: "", price: null };
  let root = null, timer = null;

  async function refresh() {
    if (!LIVE || !root) return;
    try {
      S.g = await readGlobal(); S.loadErr = "";
      if (W.account) { const a = W.account; const u = await readUser(a); if (W.account === a) S.user = u; } else S.user = null;
    } catch (e) { S.loadErr = "Could not read the staking contract from Robinhood Chain. Retrying…"; console.warn(e); }
    if (!S.price && PS.ensureTokens) {
      try { const L = (await PS.ensureTokens()).find((x) => x.address && x.address.toLowerCase() === STAKING.token.toLowerCase()); if (L && PS.isNum(L.priceUsd)) S.price = L.priceUsd; } catch {}
    }
    render();
  }

  // ---------- render ----------
  const ICON = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="9" cy="16.5" rx="6" ry="2.5"/><path d="M3 16.5v2.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-2.5"/><ellipse cx="9" cy="10.5" rx="6" ry="2.5"/><path d="M3 10.5v2.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-2.5"/><path d="M19.5 13V3.5M16.5 6.5l3-3 3 3"/></svg>';
  const tokenLink = `<a class="mono addr" href="#/token/${STAKING.token}">${PS.short(STAKING.token)}</a>`;
  const walletBtn = () => W.account
    ? `<button type="button" class="wbtn on" data-act="wallet" title="Disconnect">${W.info && W.info.icon ? `<img src="${esc(W.info.icon)}" alt="" width="16" height="16">` : ""}<span class="mono">${PS.short(W.account)}</span></button>`
    : `<button type="button" class="wbtn" data-act="connect">Connect wallet</button>`;
  const howItWorks = () => `
    <div class="sk-how">
      <div><b>1</b><span><strong>Stake SCOPEPUMP</strong>Pick a lock of 7, 30 or 90 days. Longer locks carry a bigger reward weight.</span></div>
      <div><b>2</b><span><strong>Earn ETH</strong>The ScopePump team deposits ETH rewards into the contract. Each deposit is split across all active stakes by weight.</span></div>
      <div><b>3</b><span><strong>Claim any time</strong>ETH rewards can be claimed whenever you like. Staked tokens return after the lock ends.</span></div>
    </div>`;
  const rules = () => `
    <ul class="sk-rules">
      <li>Staked tokens cannot be withdrawn before the unlock date. There is no early exit.</li>
      <li>Rewards are paid in native ETH on Robinhood Chain and can be claimed at any time, including while locked.</li>
      <li>After the unlock date a position keeps earning until you withdraw it.</li>
      <li>The contract owner can deposit rewards and pause new stakes, but has no function to move staked tokens.</li>
    </ul>`;
  const tierCards = (tiers, selectable) => `<div class="sk-tiers" ${selectable ? 'role="radiogroup" aria-label="Lock period"' : ""}>${tiers.map((t, i) => {
    const on = selectable && S.tier === i;
    const tag = selectable ? "button" : "div";
    return `<${tag} ${selectable ? `type="button" role="radio" aria-checked="${on}" data-tier="${i}"` : ""} class="sk-tier${on ? " on" : ""}">
      <span class="sk-td">${days(t.duration)} days</span><span class="sk-tm">${mult(Number(t.bps))}</span><span class="sk-tl">reward weight</span></${tag}>`;
  }).join("")}</div>`;

  function renderSoon() {
    root.innerHTML = `
      <div class="sk-head"><div><span class="sk-icon" aria-hidden="true">${ICON}</span><h1>Staking</h1><p class="muted">Stake $SCOPEPUMP and earn ETH rewards.</p></div></div>
      <div class="sk-retry"><span>The staking contract is not deployed yet. Staking, total staked and rewards appear here once it is live on Robinhood Chain.</span></div>
      <div class="sk-grid pre">
        <div class="card sk-card"><div class="sk-ct"><h2>How it works</h2></div>${howItWorks()}</div>
        <div class="card sk-card"><div class="sk-ct"><h2>Lock tiers</h2><span class="muted sm">Planned</span></div>
          ${tierCards(PLANNED_TIERS.map((t) => ({ duration: t.days * 86400, bps: t.bps })), false)}
          ${rules()}
        </div>
      </div>
      <div class="sk-foot"><span class="muted">Staking token</span> <span>$SCOPEPUMP</span> ${tokenLink} <span class="muted">on Robinhood Chain. The staking contract address will be published here once deployed.</span></div>`;
  }

  function stakeButton() {
    const d = S.decimals ?? 18, amt = toUnits(S.amount, d), u = S.user, g = S.g;
    if (S.busy) return { t: S.status || "Working", dis: true };
    if (!W.account) return { t: walletOptions().length ? "Connect wallet" : "No wallet detected", act: "connect" };
    if (W.chainId !== STAKING.chainId) return { t: "Switch to Robinhood Chain", act: "switch" };
    if (g && g.paused) return { t: "New stakes are paused", dis: true };
    if (!u) return { t: "Loading balance", dis: true };
    if (amt <= 0n) return { t: "Enter an amount", dis: true };
    if (amt > u.bal) return { t: "Insufficient SCOPEPUMP balance", dis: true };
    if (u.allowance < amt) return { t: "Approve SCOPEPUMP", act: "approve" };
    return { t: `Stake for ${days(g.tiers[S.tier].duration)} days`, act: "stake" };
  }

  function renderLive() {
    const g = S.g, u = S.user, d = S.decimals ?? 18;
    if (!g) { root.innerHTML = `<div class="sk-head"><div><span class="sk-icon" aria-hidden="true">${ICON}</span><h1>Staking</h1><p class="muted">Stake $SCOPEPUMP and earn ETH rewards.</p></div>${walletBtn()}</div>${S.loadErr ? `<div class="berr">${esc(S.loadErr)}</div>` : '<div class="loading">Reading staking contract…</div>'}`; return; }
    const active = u ? u.positions.filter((p) => !p.withdrawn) : [];
    const myStaked = active.reduce((s, p) => s + p.amount, 0n);
    const claimable = u ? active.reduce((s, p) => s + pendingOf(p), 0n) + u.unclaimed : 0n;
    const tvlUsd = S.price != null ? Number(fmt(g.totalStaked, d, 2).replace(/,/g, "")) * S.price : null;
    const pctSupply = g.supply > 0n ? Number((g.totalStaked * 1000000n) / g.supply) / 10000 : null;
    const amt = toUnits(S.amount, d), t = g.tiers[S.tier];
    const unlockPreview = dateFmt(Math.floor(Date.now() / 1000) + Number(t.duration));
    const B = stakeButton();
    const rows = u ? u.positions.slice().sort((a, b) => (a.withdrawn - b.withdrawn) || Number(a.unlockAt - b.unlockAt)) : [];
    const now = Date.now() / 1000;
    const posTable = !W.account ? `<div class="sk-empty">Connect a wallet to see your positions.</div>`
      : !u ? `<div class="sk-empty">Loading positions…</div>`
      : !rows.length ? `<div class="sk-empty">No positions yet. Stake SCOPEPUMP to start earning ETH.</div>`
      : `<div class="tblwrap sk-tbl"><table class="tbl"><thead><tr><th>Amount</th><th>Lock</th><th>Unlocks</th><th class="r">Pending ETH</th><th class="r"></th></tr></thead><tbody>${rows.map((p) => {
          const tt = g.tiers[p.tier] || { duration: 0n, bps: 0n }, unlocked = now >= Number(p.unlockAt);
          return `<tr class="${p.withdrawn ? "sk-done" : ""}">
            <td class="mono">${fmt(p.amount, d, 2)}</td>
            <td>${days(tt.duration)}d <span class="muted">${mult(Number(tt.bps))}</span></td>
            <td><div>${dateFmt(p.unlockAt)}</div><div class="sm ${unlocked ? "acc" : "muted"}">${p.withdrawn ? "Withdrawn" : left(p.unlockAt)}</div></td>
            <td class="mono r">${p.withdrawn ? "—" : fmt(pendingOf(p), 18, 6)}</td>
            <td class="r">${p.withdrawn ? '<span class="muted sm">Closed</span>' : unlocked ? `<button type="button" class="sk-btn" data-act="withdraw" data-id="${p.id}"${S.busy ? " disabled" : ""}>Withdraw</button>` : '<span class="muted sm">Locked</span>'}</td>
          </tr>`; }).join("")}</tbody></table></div>`;
    const msg = S.err ? `<div class="berr">${esc(S.err)}</div>` : S.ok ? `<div class="bdone">${esc(S.ok)}${S.lastTx && !STAKING.dev ? ` <a href="${STAKING.explorer}/tx/${esc(S.lastTx)}" target="_blank" rel="noopener">View transaction</a>` : ""}</div>` : "";
    root.innerHTML = `
      <div class="sk-head"><div><span class="sk-icon" aria-hidden="true">${ICON}</span><h1>Staking</h1><p class="muted">Stake $SCOPEPUMP and earn ETH rewards.</p></div>${walletBtn()}</div>
      ${S.loadErr ? `<div class="berr">${esc(S.loadErr)}</div>` : ""}
      <div class="sk-stats">
        <div class="kv"><span>Total staked</span><b>${fmt(g.totalStaked, d, 0)}</b><em>SCOPEPUMP${tvlUsd != null ? ` &middot; ${PS.compact(tvlUsd)}` : ""}${pctSupply != null ? ` &middot; ${pctSupply.toFixed(2)}% of supply` : ""}</em></div>
        <div class="kv"><span>ETH rewards distributed</span><b>${fmt(g.distributed, 18, 4)}</b><em>ETH all time${g.queued > 0n ? ` &middot; ${fmt(g.queued, 18, 4)} queued` : ""}</em></div>
        <div class="kv"><span>Your stake</span><b>${W.account && u ? fmt(myStaked, d, 0) : "—"}</b><em>${W.account && u ? `${active.length} active position${active.length === 1 ? "" : "s"}` : "Connect a wallet"}</em></div>
        <div class="kv sk-claim"><span>Your claimable ETH</span><b>${W.account && u ? fmt(claimable, 18, 6) : "—"}</b>${W.account && u && claimable > 0n ? `<button type="button" class="sk-btn pri" data-act="claim"${S.busy ? " disabled" : ""}>Claim</button>` : "<em>Claimable any time</em>"}</div>
      </div>
      ${g.paused ? `<div class="bwarn">New stakes are paused by the team. Claims and withdrawals work as normal.</div>` : ""}
      <div class="sk-grid">
        <div class="bcard sk-form">
          <div class="bbox">
            <div class="brow"><span class="blab">Stake</span><span class="sm muted">${W.account && u ? "Balance " + fmt(u.bal, d, 2) : ""}</span></div>
            <div class="bamt"><input id="skamount" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${esc(S.amount)}" aria-label="Amount to stake"${S.busy ? " disabled" : ""}><span class="bsym">SCOPEPUMP</span></div>
            ${W.account && u && u.bal > 0n ? `<div class="bbal"><span></span><button type="button" data-act="max">Max</button></div>` : ""}
          </div>
          <div class="blab sk-lab">Lock period</div>
          ${tierCards(g.tiers, true)}
          <div class="bq">
            <div><span>Unlock date</span><span>${unlockPreview}</span></div>
            <div><span>Reward weight</span><span class="mono">${amt > 0n ? fmt((amt * t.bps) / 10000n, d, 2) : "0"}</span></div>
          </div>
          <p class="sk-note">Tokens cannot be withdrawn before the unlock date. ETH rewards are claimable any time.</p>
          <button type="button" class="bgo" data-act="${B.act || ""}"${B.dis ? " disabled" : ""}>${esc(B.t)}</button>
          ${msg}
        </div>
        <div class="card sk-card sk-pos"><div class="sk-ct"><h2>Your positions</h2>${W.account && u ? `<span class="muted sm">ETH balance ${fmt(u.eth, 18, 4)}</span>` : ""}</div>${posTable}</div>
      </div>
      <div class="card sk-card"><div class="sk-ct"><h2>How it works</h2></div>${howItWorks()}${rules()}</div>
      <div class="sk-foot"><span class="muted">Contract</span> <a class="mono addr" href="${STAKING.explorer}/address/${STAKING.address}" target="_blank" rel="noopener">${STAKING.address}</a><button type="button" class="ca-cp" data-cp="${STAKING.address}" title="Copy contract address" aria-label="Copy contract address"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button><span class="muted">Staking token</span> ${tokenLink}</div>
      ${S.pick ? `<div class="bmodal" data-act="close"><div class="bpick" role="dialog" aria-label="Choose a wallet"><b>Connect a wallet</b>${walletOptions().length ? walletOptions().map((o, i) => `<button type="button" data-wallet="${i}">${o.info.icon ? `<img src="${esc(o.info.icon)}" alt="" width="24" height="24">` : '<span class="bti ph">W</span>'}<span>${esc(o.info.name)}</span></button>`).join("") : `<p class="muted">No browser wallet detected. Install MetaMask, Rabby or Coinbase Wallet, then reload this page.</p>`}<button type="button" class="bclose" data-act="close">Cancel</button></div></div>` : ""}`;
    if (S.focusAmt) { const i = root.querySelector("#skamount"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }
  function render() { if (!root) return; LIVE ? renderLive() : renderSoon(); }
  PS.stakingRender = render;

  // ---------- actions ----------
  async function run(label, fn, okText) {
    S.busy = true; S.err = ""; S.ok = ""; S.lastTx = null; render();
    try { await fn(); S.ok = okText; } catch (e) { S.err = errMsg(e); }
    S.busy = false; S.status = ""; await refresh();
  }
  async function connect(opt) { try { await useWallet(opt, true); S.err = ""; } catch (er) { S.err = er && er.code === 4001 ? "Connection rejected in wallet." : (er && er.message) || "Could not connect."; } render(); refresh(); }
  async function onClick(e) {
    const el = e.target.closest("[data-act],[data-tier],[data-wallet]"); if (!el || !root || !root.contains(el)) return;
    if (el.dataset.tier && !S.busy) { S.tier = +el.dataset.tier; render(); return; }
    if (el.dataset.wallet) { const o = walletOptions()[+el.dataset.wallet]; S.pick = false; await connect(o); return; }
    const a = el.dataset.act, d = S.decimals ?? 18;
    if (a === "close") { if (e.target === el || el.classList.contains("bclose")) { S.pick = false; render(); } return; }
    if (a === "connect") { requestWallets(); const l = walletOptions(); if (l.length === 1) await connect(l[0]); else { S.pick = true; render(); } return; }
    if (a === "wallet") { if (confirm("Disconnect this wallet from ScopePump?")) { W.account = null; W.p = null; S.user = null; localStorage.removeItem("ps_wallet"); render(); } return; }
    if (a === "switch") { try { await ensureChain(); S.err = ""; } catch (er) { S.err = errMsg(er); } render(); refresh(); return; }
    if (a === "max" && S.user) { S.amount = plain(S.user.bal, d); render(); return; }
    if (S.busy) return;
    if (a === "approve") { const amt = toUnits(S.amount, d); await run("Approve", () => send(STAKING.token, SEL.approve + addrWord(STAKING.address) + word(amt), "Approve"), "Approved. Now confirm the stake."); return; }
    if (a === "stake") {
      const amt = toUnits(S.amount, d), t = S.tier, dd = days(S.g.tiers[t].duration);
      await run("Stake", () => send(STAKING.address, SEL.stake + word(amt) + word(t), "Stake"), `Staked ${fmt(amt, d, 2)} SCOPEPUMP for ${dd} days.`);
      if (!S.err) S.amount = ""; render(); return;
    }
    if (a === "claim") { await run("Claim", () => send(STAKING.address, SEL.claimAll, "Claim"), "ETH rewards claimed."); return; }
    if (a === "withdraw") { const id = BigInt(el.dataset.id); await run("Withdraw", () => send(STAKING.address, SEL.withdraw + word(id), "Withdraw"), "Tokens withdrawn. Any rewards from that position stay claimable."); return; }
  }
  function onInput(e) {
    if (e.target.id !== "skamount") return;
    const v = e.target.value.replace(",", "."); if (!/^\d*\.?\d*$/.test(v)) { e.target.value = S.amount; return; }
    S.amount = v; S.focusAmt = true; S.err = ""; S.ok = ""; render();
  }

  PS.stakingPage = (el) => {
    document.title = "Staking — ScopePump";
    el.innerHTML = `<section class="staking" id="staking"></section>`;
    root = el.querySelector("#staking");
    root.addEventListener("click", onClick); root.addEventListener("input", onInput);
    root.addEventListener("focusout", (e) => { if (e.target.id === "skamount") S.focusAmt = false; });
    render();
    if (LIVE) {
      requestWallets();
      autoReconnect().then(() => { render(); refresh(); });
      timer = setInterval(() => { if (!S.busy && document.visibilityState === "visible") refresh(); }, 15000);
    }
    return () => { clearInterval(timer); timer = null; root = null; S.pick = false; };
  };
})(window.PS);
