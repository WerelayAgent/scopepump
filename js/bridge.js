/* ScopePump — Solana Cross-Chain Bridge page (#/bridge). */
(function (PS) {
  const { esc } = PS;

  const CHAINS = [
    { id: "solana", name: "Solana", syms: ["SOL", "USDC"] },
    { id: "ethereum", name: "Ethereum", syms: ["ETH", "USDC"] },
    { id: "base", name: "Base", syms: ["ETH", "USDC"] },
    { id: "arbitrum", name: "Arbitrum", syms: ["ETH", "USDC"] },
  ];
  const RATES_USD = { SOL: 185, ETH: 3250, USDC: 1 };

  const S = { dir: "in", other: "base", fromSym: "ETH", toSym: "SOL", amount: "0.25", pick: false, walletName: null, walletAddr: null, msg: "" };
  let root = null;

  function detectWallets() {
    const out = [];
    if (window.phantom?.solana) out.push({ id: "phantom", name: "Phantom (Solana)" });
    if (window.solflare) out.push({ id: "solflare", name: "Solflare (Solana)" });
    if (window.solana && !window.phantom?.solana) out.push({ id: "solana", name: "Solana Browser Wallet" });
    if (window.ethereum) out.push({ id: "evm", name: window.ethereum.isMetaMask ? "MetaMask (EVM)" : "Browser EVM Wallet" });
    return out;
  }

  async function connectWallet(w) {
    S.pick = false;
    try {
      if (w.id === "phantom" || w.id === "solflare" || w.id === "solana") {
        const provider = w.id === "phantom" ? window.phantom.solana : w.id === "solflare" ? window.solflare : window.solana;
        const resp = await provider.connect();
        S.walletName = w.name;
        S.walletAddr = resp?.publicKey?.toString?.() || provider.publicKey?.toString?.() || "Connected";
      } else if (w.id === "evm") {
        const acc = await window.ethereum.request({ method: "eth_requestAccounts" });
        S.walletName = w.name;
        S.walletAddr = acc?.[0] || "Connected";
      }
      S.msg = "";
    } catch {
      S.msg = "Connection request cancelled in wallet.";
    }
    render();
  }

  function render() {
    if (!root) return;
    const fromChain = S.dir === "in" ? CHAINS.find((c) => c.id === S.other) : CHAINS[0];
    const toChain = S.dir === "in" ? CHAINS[0] : CHAINS.find((c) => c.id === S.other);
    const amt = parseFloat(S.amount);
    const valid = isFinite(amt) && amt > 0;
    const usdIn = valid ? amt * (RATES_USD[S.fromSym] || 1) : 0;
    const feeUsd = valid ? Math.max(0.15, usdIn * 0.0012) : 0;
    const estOut = valid ? Math.max(0, (usdIn - feeUsd) / (RATES_USD[S.toSym] || 1)) : 0;
    const wallets = detectWallets();

    root.innerHTML = `
      <div class="bridge">
        <div class="bhead">
          <div>
            <h1>Bridge</h1>
            <p class="muted">Move liquidity between EVM networks and Solana mainnet with low-latency cross-chain intents.</p>
          </div>
          ${
            S.walletAddr
              ? `<button type="button" class="wbtn on" data-b="disconnect"><span class="dot"></span><span class="mono">${esc(PS.short(S.walletAddr))}</span></button>`
              : `<button type="button" class="wbtn" data-b="openpick">Connect wallet</button>`
          }
        </div>
        <div class="bcard">
          <div class="bbox">
            <div class="brow">
              <span class="blab">From</span>
              ${
                S.dir === "in"
                  ? `<label class="bchain"><select id="bother">${CHAINS.filter((c) => c.id !== "solana").map((c) => `<option value="${c.id}"${c.id === S.other ? " selected" : ""}>${c.name}</option>`).join("")}</select></label>`
                  : `<span class="bchain fixed">Solana</span>`
              }
            </div>
            <div class="bseg">${fromChain.syms.map((s) => `<button type="button" data-from="${s}" class="${S.fromSym === s ? "on" : ""}">${s}</button>`).join("")}</div>
            <div class="bamt"><input id="bamt" type="number" step="any" min="0" value="${esc(S.amount)}" aria-label="Bridge amount"><span class="bsym">${esc(S.fromSym)}</span></div>
          </div>

          <button type="button" class="bflip" data-b="flip" aria-label="Reverse bridge direction">⇅</button>

          <div class="bbox">
            <div class="brow">
              <span class="blab">To</span>
              ${
                S.dir === "out"
                  ? `<label class="bchain"><select id="bother">${CHAINS.filter((c) => c.id !== "solana").map((c) => `<option value="${c.id}"${c.id === S.other ? " selected" : ""}>${c.name}</option>`).join("")}</select></label>`
                  : `<span class="bchain fixed">Solana</span>`
              }
            </div>
            <div class="bseg">${toChain.syms.map((s) => `<button type="button" data-to="${s}" class="${S.toSym === s ? "on" : ""}">${s}</button>`).join("")}</div>
            <div class="bamt out"><span>${valid ? estOut.toFixed(S.toSym === "USDC" ? 2 : 4) : "0"}</span><span class="bsym">${esc(S.toSym)}</span></div>
          </div>

          <div class="bq">
            <div><span>Estimated rate</span><span class="mono">1 ${esc(S.fromSym)} ≈ ${((RATES_USD[S.fromSym] || 1) / (RATES_USD[S.toSym] || 1)).toFixed(4)} ${esc(S.toSym)}</span></div>
            <div><span>Est. time on Solana</span><span>~8 seconds</span></div>
            <div><span>Relayer fee</span><span class="mono">${valid ? "$" + feeUsd.toFixed(2) : "—"}</span></div>
          </div>

          ${S.msg ? `<div class="bdone">${esc(S.msg)}</div>` : ""}

          <button type="button" class="bgo" data-b="go"${!valid ? " disabled" : ""}>${S.walletAddr ? `Bridge ${esc(S.fromSym)} → ${esc(S.toSym)}` : "Connect Solana or EVM wallet to bridge"}</button>
        </div>
        <p class="bfoot">Solana settlement powered by ScopePump router · <a href="#/">Back to screener</a></p>
      </div>
      ${
        S.pick
          ? `<div class="bmodal" data-b="closepick"><div class="bpick" role="dialog" aria-label="Connect wallet">
              <b>Connect wallet</b>
              ${
                wallets.length
                  ? wallets.map((w, i) => `<button type="button" data-wallet="${i}">${esc(w.name)}</button>`).join("")
                  : '<p class="muted sm">Install Phantom, Solflare, or MetaMask to sign cross-chain bridge intents.</p>'
              }
              <button type="button" class="bclose" data-b="closepick">Close</button>
            </div></div>`
          : ""
      }`;
  }

  function handleClick(e) {
    const t = e.target;
    const f = t.closest("[data-from]");
    if (f) {
      S.fromSym = f.dataset.from;
      render();
      return;
    }
    const to = t.closest("[data-to]");
    if (to) {
      S.toSym = to.dataset.to;
      render();
      return;
    }
    const w = t.closest("[data-wallet]");
    if (w) {
      const opts = detectWallets();
      if (opts[+w.dataset.wallet]) connectWallet(opts[+w.dataset.wallet]);
      return;
    }
    const b = t.closest("[data-b]");
    if (!b) return;
    const act = b.dataset.b;
    if (act === "flip") {
      S.dir = S.dir === "in" ? "out" : "in";
      const tmp = S.fromSym;
      S.fromSym = S.toSym;
      S.toSym = tmp;
      render();
    } else if (act === "openpick") {
      S.pick = true;
      render();
    } else if (act === "closepick") {
      if (e.target === b || b.classList.contains("bclose")) {
        S.pick = false;
        render();
      }
    } else if (act === "disconnect") {
      S.walletAddr = null;
      S.walletName = null;
      render();
    } else if (act === "go") {
      if (!S.walletAddr) {
        S.pick = true;
        render();
      } else {
        S.msg = `Ready to route ${S.amount} ${S.fromSym} → ${S.toSym} to ${PS.short(S.walletAddr)} once on-chain executor confirms.`;
        render();
      }
    }
  }

  function handleInput(e) {
    if (e.target.id === "bamt") {
      S.amount = e.target.value;
      render();
      const inp = root?.querySelector("#bamt");
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }
  }

  function handleChange(e) {
    if (e.target.id === "bother") {
      S.other = e.target.value;
      render();
    }
  }

  PS.bridgePage = function (el) {
    root = el;
    render();
    el.addEventListener("click", handleClick);
    el.addEventListener("input", handleInput);
    el.addEventListener("change", handleChange);
    return () => {
      el.removeEventListener("click", handleClick);
      el.removeEventListener("input", handleInput);
      el.removeEventListener("change", handleChange);
      root = null;
    };
  };
})(window.PS);
