/* Ponscope: browser trading wallet (a plain EOA whose private key lives only in this browser).
   - Generate: 32 random bytes from crypto.getRandomValues, or Import: a pasted hex key, validated here.
   - At rest: the key is encrypted with AES-GCM-256 under a key derived from the user's password with PBKDF2-SHA256
     (600,000 iterations, random 16-byte salt, random 12-byte IV, the address as additional data) and stored in localStorage
     under "ps_tw:v1". The password is never stored.
   - Unlocked: the decrypted key exists only in memory, inside this closure, until Lock, the idle timer, or the tab closes.
     Nothing here writes the key or password to the console, the network or any storage.
   - Trades: transactions are signed here and sent as eth_sendRawTransaction to the Robinhood Chain RPC. */
(function (PS) {
  "use strict";
  const LIB = "vendor/ps-wallet.js?v=20261110a";
  const REC = "ps_tw:v1", USE = "ps_tw_use", IDLE = "ps_tw_idle";
  const ITER = 600000;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1 group order
  let lib = null, libP = null;
  function loadLib() {
    if (lib) return Promise.resolve(lib);
    if (!libP) libP = new Promise((res, rej) => { const s = document.createElement("script"); s.src = LIB; s.async = true; s.onload = () => (window.PSW ? res((lib = window.PSW)) : rej(new Error("Wallet library failed to load."))); s.onerror = () => { libP = null; rej(new Error("Could not load the wallet library. Check your connection and reload.")); }; document.head.appendChild(s); });
    return libP;
  }
  const te = new TextEncoder();
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u))), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toBytes = (h) => { const s = h.slice(2), u = new Uint8Array(s.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16); return u; };
  const toHex = (u) => "0x" + Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
  async function kek(password, salt, iter) {
    const base = await crypto.subtle.importKey("raw", te.encode(String(password).normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function seal(pk, password, address) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), pt = toBytes(pk);
    try {
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(address.toLowerCase()) }, await kek(password, salt, ITER), pt);
      return { kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
    } finally { pt.fill(0); }
  }
  async function unseal(r, password) {
    let pt;
    try { pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.enc.iv), additionalData: te.encode(r.address.toLowerCase()) }, await kek(password, unb64(r.enc.salt), r.enc.iter), unb64(r.enc.ct))); }
    catch { throw new Error("Wrong password."); }
    try { const pk = toHex(pt); await loadLib(); if (lib.privateKeyToAccount(pk).address.toLowerCase() !== r.address.toLowerCase()) throw new Error("Stored wallet is damaged."); return pk; }
    finally { pt.fill(0); }
  }
  /** Normalises a pasted key; never echoes the input in an error. */
  function parseKey(s) {
    let v = String(s || "").trim().replace(/\s+/g, "");
    if (/^[0-9a-fA-F]{64}$/.test(v)) v = "0x" + v;
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) return { err: v ? "A private key is 64 hex characters (0-9, a-f), optionally starting with 0x. Seed phrases are not supported." : "" };
    const n = BigInt(v); if (n === 0n || n >= N) return { err: "This is not a valid secp256k1 private key." };
    return { pk: v.toLowerCase() };
  }
  const readRec = () => { try { const r = JSON.parse(localStorage.getItem(REC) || "null"); return r && r.v === 1 && r.address && r.enc ? r : null; } catch { return null; } };
  const writeRec = (r) => localStorage.setItem(REC, JSON.stringify(r));

  PS.tradeWalletInit = (D) => {
    const { C, rpc, call, log, sleep } = D;
    const hex = (n) => "0x" + BigInt(n).toString(16);
    let acct = null, pending = null, nonceNext = null, q = Promise.resolve(), lastAct = Date.now(), lockWhy = "";
    const subs = new Set(), emit = () => subs.forEach((f) => { try { f(); } catch {} });
    const fmt = (w) => { const n = Number(BigInt(w)) / 1e18; return n === 0 ? "0" : n >= 1 ? n.toFixed(4) : n.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); };
    function setUnlocked(a) { acct = a; nonceNext = null; lockWhy = ""; lastAct = Date.now(); emit(); }
    const T = {
      load: loadLib,
      onChange(f) { subs.add(f); return () => subs.delete(f); },
      exists: () => !!readRec(),
      rec: () => { const r = readRec(); return r && { address: r.address, origin: r.origin, created: r.created, backedUp: !!r.backedUp }; },
      address: () => { const r = readRec(); return r ? r.address : null; },
      unlocked: () => !!acct,
      lockReason: () => lockWhy,
      use: () => localStorage.getItem(USE) === "1",
      setUse(v) { localStorage.setItem(USE, v ? "1" : "0"); emit(); },
      /** Trading wallet is the active trading account (it may still be locked). */
      active: () => !!readRec() && localStorage.getItem(USE) === "1",
      idleMin: () => { const v = parseInt(localStorage.getItem(IDLE) || "0", 10); return [0, 15, 60, 240].includes(v) ? v : 0; },
      setIdleMin(v) { localStorage.setItem(IDLE, String(v)); lastAct = Date.now(); emit(); },
      parseKey,
      async addressOf(s) { const k = parseKey(s); if (!k.pk) return k; await loadLib(); try { return { address: lib.privateKeyToAccount(k.pk).address }; } catch { return { err: "This is not a valid secp256k1 private key." }; } },
      checkPassword(pw, pw2) { if (String(pw).length < 10) return "Use a password of at least 10 characters."; if (pw !== pw2) return "The two passwords do not match."; return ""; },
      async create(password) {
        await loadLib(); if (readRec()) throw new Error("A trading wallet already exists in this browser. Forget it first.");
        const pk = lib.generatePrivateKey(), a = lib.privateKeyToAccount(pk);
        writeRec({ v: 1, address: a.address, origin: "generated", created: Date.now(), backedUp: false, enc: await seal(pk, password, a.address) });
        pending = pk; localStorage.setItem(USE, "1"); setUnlocked(a); return a.address;
      },
      async importKey(s, password) {
        await loadLib(); if (readRec()) throw new Error("A trading wallet already exists in this browser. Forget it first.");
        const k = parseKey(s); if (!k.pk) throw new Error(k.err || "Paste a private key.");
        let a; try { a = lib.privateKeyToAccount(k.pk); } catch { throw new Error("This is not a valid secp256k1 private key."); }
        writeRec({ v: 1, address: a.address, origin: "imported", created: Date.now(), backedUp: true, enc: await seal(k.pk, password, a.address) });
        localStorage.setItem(USE, "1"); setUnlocked(a); return a.address;
      },
      /** The new key, only between Create and "I saved it" while unlocked. */
      backupKey: () => (acct && pending ? pending : null),
      confirmBackup() { const r = readRec(); if (r) { r.backedUp = true; writeRec(r); } pending = null; emit(); },
      async unlock(password) { const r = readRec(); if (!r) throw new Error("No trading wallet in this browser."); const pk = await unseal(r, password); setUnlocked(lib.privateKeyToAccount(pk)); },
      lock(why) { if (!acct && !pending) return; acct = null; pending = null; nonceNext = null; lockWhy = why || ""; emit(); },
      /** Decrypts again with the password (also when unlocked) and returns the key for display. */
      async exportKey(password) { const r = readRec(); if (!r) throw new Error("No trading wallet in this browser."); return unseal(r, password); },
      forget() { localStorage.removeItem(REC); localStorage.setItem(USE, "0"); acct = null; pending = null; nonceNext = null; emit(); },
      touch() { lastAct = Date.now(); },
      /** Sign locally and send; resolves with the receipt. Serialized so nonces stay in order. */
      send(tx, label) { const p = q.then(() => doSend(tx, label)); q = p.catch(() => {}); return p; },
      withdrawAll(to) { const p = q.then(() => doWithdraw(to)); q = p.catch(() => {}); return p; },
      validAddress: async (s) => { await loadLib(); const v = String(s || "").trim(); return lib.isAddress(v, { strict: true }) ? lib.getAddress(v) : null; },
      qr: async (text, px) => { await loadLib(); return lib.qrSvg(text, px); },
      balance: async () => { const a = T.address(); return a ? BigInt(await rpc("eth_getBalance", [a, "latest"])) : 0n; },
    };
    async function fees() {
      const b = await rpc("eth_getBlockByNumber", ["latest", false]);
      const base = BigInt((b && b.baseFeePerGas) || "0x989680");
      return { base, maxFee: base * 2n };
    }
    async function nextNonce(a) {
      try { const n = BigInt(await rpc("eth_getTransactionCount", [a, "pending"])); return nonceNext != null && nonceNext > n ? nonceNext : n; }
      catch (e) { if (nonceNext != null) return nonceNext; throw e; }
    }
    // Direct to the RPC; on 429 / network / 5xx the same signed bytes are sent again with backoff.
    // Re-sending identical signed bytes is safe: same hash, the node answers "already known" or the nonce is already used.
    let proxyNoSend = false;
    async function post(url, raw) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "eth_sendRawTransaction", params: [raw] }) });
      if (r.status === 403 && url !== C.rpc) { proxyNoSend = true; throw Object.assign(new Error("proxy refuses sendRaw"), { retry: true }); }
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error("RPC busy (HTTP " + r.status + ")"), { retry: true });
      const d = await r.json();
      if (d && d.error) {
        if (d.error.code === 429) throw Object.assign(new Error("RPC rate limit"), { retry: true });
        if (/already known|known transaction/i.test(d.error.message || "")) return null;
        throw Object.assign(new Error(d.error.message || "The RPC rejected the transaction."), { data: d.error.data });
      }
      return d.result;
    }
    async function broadcast(raw) {
      let wait = 600, last;
      for (let i = 0; i < 6; i++) {
        try { return await post(C.rpc, raw); } catch (e) { last = e; if (!e.retry && !(e instanceof TypeError)) throw e; }
        await sleep(wait); wait = Math.min(wait * 2, 4000);
      }
      throw new Error("Could not reach the Robinhood Chain RPC to send the transaction (" + (last && last.message) + "). Nothing was charged; try again.");
    }
    async function receipt(hash, label) {
      for (let i = 0; i < 240; i++) {
        let r = null; try { r = await rpc("eth_getTransactionReceipt", [hash]); } catch {}
        if (r && r.blockNumber) { if (r.status === "0x0") throw Object.assign(new Error(label + " failed on-chain."), { hash }); return r; }
        await sleep(i < 40 ? 400 : 2000);
      }
      throw Object.assign(new Error("Timed out waiting for confirmation. Check the transaction on the explorer."), { hash });
    }
    async function signSend(a, t, label) {
      const nonce = await nextNonce(a.address);
      const raw = await a.signTransaction({ chainId: C.chainId, type: "eip1559", nonce: Number(nonce), maxPriorityFeePerGas: 0n, ...t });
      const hash = lib.keccak256(raw);
      await broadcast(raw); nonceNext = nonce + 1n;
      log && log(label, hash);
      return receipt(hash, label);
    }
    async function doSend(tx, label) {
      const a = acct; if (!a) throw new Error("Unlock your trading wallet first."); lastAct = Date.now();
      await loadLib();
      const value = BigInt(tx.value || 0n), data = tx.data || "0x", base = { from: a.address, to: tx.to, data, value: hex(value) };
      const [{ maxFee }, bal] = await Promise.all([fees(), rpc("eth_getBalance", [a.address, "latest"]).then(BigInt)]);
      if (bal < value) throw new Error(`Not enough ETH in your trading wallet: this needs ${fmt(value)} ETH plus a small network fee, it holds ${fmt(bal)} ETH.`);
      await call(tx.to, data, { from: a.address, value: base.value }); // throws with the revert reason if it would fail
      const gas = (BigInt(await rpc("eth_estimateGas", [base])) * 13n) / 10n;
      if (bal < value + gas * maxFee) throw new Error(`Not enough ETH in your trading wallet: this needs about ${fmt(value + gas * maxFee)} ETH including the network fee, it holds ${fmt(bal)} ETH.`);
      if (acct !== a) throw new Error("The trading wallet was locked before the transaction was signed. Nothing was sent.");
      return signSend(a, { to: tx.to, value, data, gas, maxFeePerGas: maxFee }, label);
    }
    async function doWithdraw(toRaw) {
      const a = acct; if (!a) throw new Error("Unlock your trading wallet first.");
      const to = await T.validAddress(toRaw); if (!to) throw new Error("Enter a valid destination address (0x followed by 40 hex characters; mixed case must match the checksum).");
      if (to.toLowerCase() === a.address.toLowerCase()) throw new Error("That is the trading wallet itself. Enter another address.");
      const [{ base }, bal] = await Promise.all([fees(), rpc("eth_getBalance", [a.address, "latest"]).then(BigInt)]);
      const gas = (BigInt(await rpc("eth_estimateGas", [{ from: a.address, to, value: "0x1" }])) * 12n) / 10n, maxFee = (base * 3n) / 2n;
      const amount = bal - gas * maxFee;
      if (amount <= 0n) throw new Error(`The balance (${fmt(bal)} ETH) does not cover the network fee.`);
      const rc = await signSend(a, { to, value: amount, data: "0x", gas, maxFeePerGas: maxFee }, `Withdraw ${fmt(amount)} ETH`);
      return { receipt: rc, amount, to };
    }
    // Auto-lock: when the tab is closed or put in the back/forward cache, and optionally after inactivity.
    window.addEventListener("pagehide", () => T.lock("Locked when the page was closed."));
    ["pointerdown", "keydown"].forEach((ev) => window.addEventListener(ev, () => { lastAct = Date.now(); }, { capture: true, passive: true }));
    setInterval(() => { const m = T.idleMin(); if (acct && m && Date.now() - lastAct > m * 60000) T.lock(`Locked after ${m >= 60 ? m / 60 + " h" : m + " min"} without activity.`); }, 15000);
    return T;
  };
})(window.PS);
