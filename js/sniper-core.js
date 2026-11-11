/* Ponscope — Sniper core (no DOM). Pure calldata building / decoding for Pons launchpad tokens on Robinhood Chain (4663).
   Checked against the chain (Pons front-end bundle, live mainnet trades, and real swaps replayed on an anvil fork; see /workspace/ponscope/RESEARCH.md):
   - Curve stage (not graduated): PonscopeSniperRouter.buy / sell. The Pons curve's own buy(quoteIn,minOut,recipient) / sell(tokensIn,minOut,recipient)
     has no integrator-fee argument, so the router (a small stateless contract, no owner) takes the 1% from the ETH side and calls the curve
     in the same transaction. Tokens / ETH go straight to the signer.
   - Pool stage (graduated): Uniswap v4 UniversalRouter.execute on the Pons pool (native ETH / token, Pons hook). Fee = TRANSFER from msg.value
     (buys) or PAY_PORTION 99% to the signer + SWEEP the rest (sells), inside the same execute().
   This file never signs or sends anything; it only builds calldata the user's own wallet signs. */
(function (root) {
  const Z = "0x0000000000000000000000000000000000000000";
  const cfg = (root && root.PONSCOPE_CONFIG) || {};
  const C = {
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", // Pons launch factory
    hook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044", // Pons v4 hook of graduated pools
    router: String(cfg.SNIPER_ROUTER || "").trim().toLowerCase(), // PonscopeSniperRouter (curve stage). Empty = curve trades disabled.
    ur: "0x8876789976decbfcbbbe364623c63652db8c0904", // Uniswap UniversalRouter (v4) on Robinhood Chain
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94", // Uniswap V4Quoter (same numbers as Pons' quoter 0xe202…982ef)
    permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
    multicall3: "0xca11bde05977b3631167028862be2a173976ca11",
    eth: Z,
    // Platform fee: 100 bps = 1% of the ETH side of every trade, paid in the same tx. The curve router has the same 1% hard-coded.
    fee: { bps: 100, recipient: "0x311d209fe9b7e7ebfc36cd9dd03c3cf6cf79a8bd" },
  };
  const SEL = {
    getLaunched: "0x3cf28b5a", routerBuy: "0xcce7ec13", routerSell: "0x6a272462",
    getReserves: "0x0902f1ac", sellable: "0x808bcddc", feeBps: "0x24a9d853", creatorTax: "0xc1bb8901", graduated: "0xe7c2b772", ready: "0xc68360a5", native: "0xdc08e094",
    snipeTax: "0xd7e1ef39", quoteSingle: "0xaa9d21cb", execute: "0x3593564c",
    name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", balanceOf: "0x70a08231", allowance: "0xdd62ed3e", approve: "0x095ea7b3",
    p2allowance: "0x927da105", p2approve: "0x87517c45", aggregate3: "0x82ad56cb",
  };
  const CMD = { SWEEP: "04", TRANSFER: "05", PAY_PORTION: "06", V4_SWAP: "10" };
  const ACT = { SWAP_EXACT_IN_SINGLE: "06", SETTLE_ALL: "0c", TAKE: "0e", TAKE_ALL: "0f" };
  const MSG_SENDER = "0x0000000000000000000000000000000000000001", ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
  const MAX_U128 = (1n << 128n) - 1n, MAX_U160 = (1n << 160n) - 1n, MAX_U256 = (1n << 256n) - 1n;

  // ---------- minimal ABI encoder ----------
  const strip = (h) => String(h || "").replace(/^0x/, "");
  const lc = (a) => String(a || "").toLowerCase();
  function w(v) { v = BigInt(v); if (v < 0n) v = (1n << 256n) + v; if (v < 0n || v > MAX_U256) throw new Error("abi: out of range"); return v.toString(16).padStart(64, "0"); }
  const wa = (a) => { const s = strip(a).toLowerCase(); if (!/^[0-9a-f]{40}$/.test(s)) throw new Error("abi: bad address " + a); return s.padStart(64, "0"); };
  const isDyn = (t) => t === "bytes" || (Array.isArray(t) && (t[0] === "array" || t[1].some(isDyn)));
  function encOne(t, v) {
    if (t === "address") return wa(v);
    if (t === "uint" || t === "int") return w(v);
    if (t === "bool") return w(v ? 1 : 0);
    if (t === "bytes") { const b = strip(v); if (b.length % 2) throw new Error("abi: odd bytes"); return w(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, "0"); }
    if (t[0] === "tuple") return encTuple(t[1], v);
    if (t[0] === "array") return w(v.length) + encTuple(v.map(() => t[1]), v);
    throw new Error("abi: type");
  }
  const headSize = (t) => (Array.isArray(t) && t[0] === "tuple" && !isDyn(t) ? t[1].reduce((n, x) => n + headSize(x), 0) : 32);
  function encTuple(types, vals) {
    const heads = [], tails = []; const size = types.reduce((n, t) => n + headSize(t), 0);
    types.forEach((t, i) => { if (isDyn(t)) { heads.push(null); tails.push(encOne(t, vals[i])); } else { heads.push(encOne(t, vals[i])); tails.push(""); } });
    let out = "", tail = "";
    types.forEach((t, i) => { if (heads[i] === null) { out += w(size + tail.length / 2); tail += tails[i]; } else out += heads[i]; });
    return out + tail;
  }
  const encode = (types, vals) => encTuple(types, vals);
  const words = (h) => { h = strip(h); const o = []; for (let i = 0; i + 64 <= h.length; i += 64) o.push(BigInt("0x" + h.slice(i, i + 64))); return o; };
  const wordAddr = (x) => "0x" + BigInt(x).toString(16).padStart(40, "0").slice(-40);
  const toInt = (v, bits) => { v = BigInt(v) & ((1n << BigInt(bits)) - 1n); return v >= 1n << BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v; };
  function decString(h) {
    h = strip(h); if (!h) return "";
    try {
      if (h.length === 64) { let s = ""; for (let i = 0; i < 64; i += 2) { const c = parseInt(h.slice(i, i + 2), 16); if (!c) break; s += String.fromCharCode(c); } return s; }
      const off = Number(BigInt("0x" + h.slice(0, 64))) * 2, len = Number(BigInt("0x" + h.slice(off, off + 64)));
      const bytes = h.slice(off + 64, off + 64 + len * 2); const arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) arr[i] = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
      return new TextDecoder().decode(arr);
    } catch { return ""; }
  }
  const decodePoolKey = (h) => { const W = words(h); return { currency0: wordAddr(W[0]), currency1: wordAddr(W[1]), fee: Number(W[2]), tickSpacing: Number(toInt(W[3], 24)), hooks: wordAddr(W[4]) }; };
  const KEY_T = ["tuple", ["address", "address", "uint", "int", "address"]];
  const keyArr = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];

  // ---------- fee ----------
  const feeBps = () => BigInt(C.fee.bps || 0);
  const feeOf = (gross) => (BigInt(gross) * feeBps()) / 10000n;
  const applySlippage = (amt, bps) => (BigInt(amt) * BigInt(10000 - Math.round(bps))) / 10000n;

  // ---------- launch / curve state ----------
  // Factory.getLaunchedToken(token) -> 15 static words
  const launchedData = (token) => SEL.getLaunched + wa(token);
  function decodeLaunched(h) {
    const W = words(h); if (W.length < 15) return null;
    return { token: wordAddr(W[0]), curve: wordAddr(W[1]), deployer: wordAddr(W[2]), pairToken: wordAddr(W[4]), threshold: W[5], poolFee: Number(W[6]), tickSpacing: Number(toInt(W[7], 24)), creatorTaxBps: Number(W[8]), phase: Number(W[10]), exists: W[14] === 1n };
  }
  const curveCalls = (curve) => [SEL.getReserves, SEL.sellable, SEL.feeBps, SEL.creatorTax, SEL.graduated, SEL.ready, SEL.native].map((d) => ({ to: curve, data: d }));
  function decodeCurve(res) { // res: aggregate3 results for curveCalls
    const v = (i) => (res[i] && res[i].ok ? words(res[i].data) : []);
    const r = v(0);
    return { quoteReserve: r[0] || 0n, tokenReserve: r[1] || 0n, sellable: v(1)[0] || 0n, feeBps: v(2)[0] || 0n, taxBps: v(3)[0] || 0n, graduated: v(4)[0] === 1n, ready: v(5)[0] === 1n, native: v(6)[0] === 1n };
  }
  // stage: "curve" (trade on the curve), "pool" (graduated, v4 pool), "graduating" (curve full, pool not open yet), "unsupported"
  function makeRoute(token, L, cs) {
    token = lc(token);
    if (!L || !L.exists) return { token, stage: "unsupported", why: "Not a Pons token" };
    if (L.pairToken !== Z) return { token, stage: "unsupported", why: "Quoted in another token, not ETH" };
    const key = { currency0: Z, currency1: token, fee: L.poolFee, tickSpacing: L.tickSpacing, hooks: C.hook };
    const base = { token, curve: L.curve, launch: L, key };
    if (cs && cs.graduated) return { ...base, stage: "pool" };
    if (cs && (cs.ready || cs.sellable === 0n)) return { ...base, stage: "graduating", cs };
    return { ...base, stage: "curve", cs };
  }

  // ---------- curve stage (PonscopeSniperRouter) ----------
  // Same math as the Pons front end, applied to the ETH the curve actually receives (gross - 1%).
  const cpOut = (inp, rIn, rOut) => (inp <= 0n || rIn <= 0n || rOut <= 0n ? 0n : (inp * rOut) / (rIn + inp));
  function curveQuoteBuy(cs, gross) {
    gross = BigInt(gross); const fee = feeOf(gross); let n = gross - fee;
    if (n <= 0n) return { out: 0n, fee, refund: 0n, completes: false };
    let pf = (n * cs.feeBps) / 10000n, tx = (n * cs.taxBps) / 10000n, out = cpOut(n - pf - tx, cs.quoteReserve, cs.tokenReserve), refund = 0n;
    if (out > cs.sellable) {
      out = cs.sellable;
      const s = cs.sellable, q = cs.quoteReserve, t = cs.tokenReserve, keep = 10000n - cs.feeBps - cs.taxBps;
      const need = s <= 0n || q <= 0n || t <= s ? 0n : (s * q) / (t - s) + 1n;
      const max = (need * 10000n + keep - 1n) / keep;
      if (max < n) { refund = n - max; n = max; }
      pf = (n * cs.feeBps) / 10000n; tx = (n * cs.taxBps) / 10000n;
    }
    return { out, fee, ponsFee: pf, tax: tx, refund, completes: out >= cs.sellable };
  }
  function curveQuoteSell(cs, tokensIn) {
    tokensIn = BigInt(tokensIn);
    const g = cpOut(tokensIn, cs.tokenReserve, cs.quoteReserve), pf = (g * cs.feeBps) / 10000n, tx = (g * cs.taxBps) / 10000n, gross = g - pf - tx, fee = feeOf(gross);
    return { out: gross - fee, gross, fee, ponsFee: pf, tax: tx };
  }
  function curveBuy(r, gross, minOut) {
    if (!/^0x[0-9a-f]{40}$/.test(C.router)) throw new Error("Sniper router not set");
    return { to: C.router, value: BigInt(gross), data: SEL.routerBuy + encode(["address", "uint"], [r.curve, BigInt(minOut)]), fee: feeOf(gross) };
  }
  function curveSell(r, tokensIn, minOut) {
    if (!/^0x[0-9a-f]{40}$/.test(C.router)) throw new Error("Sniper router not set");
    return { to: C.router, value: 0n, data: SEL.routerSell + encode(["address", "uint", "uint"], [r.curve, BigInt(tokensIn), BigInt(minOut)]) };
  }

  // ---------- pool stage (UniversalRouter, Pons v4 pool ETH/token) ----------
  // ExactInputSingleParams of this v4-periphery build (same struct Pons' own front end encodes):
  // (PoolKey poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)
  const exactInSingle = (key, zfo, amountIn, minOut) => encode([["tuple", [KEY_T, "bool", "uint", "uint", "uint", "bytes"]]], [[keyArr(key), zfo, amountIn, minOut, 0n, "0x"]]);
  const v4 = (actions, params) => "0x" + encode(["bytes", ["array", "bytes"]], ["0x" + actions, params.map((x) => "0x" + x)]);
  const execute = (cmds, inputs, deadline) => SEL.execute + encode(["bytes", ["array", "bytes"], "uint"], ["0x" + cmds, inputs, deadline]);
  const tri = (a, b, n) => "0x" + encode(["address", "address", "uint"], [a, b, n]);
  // currency0 is always native ETH (0x0 sorts first): buy = zeroForOne, sell = oneForZero.
  // Buy: msg.value = gross. TRANSFER(ETH) the 1% from the router-held msg.value, then swap exactly net.
  function poolBuy(r, gross, minOut, deadline) {
    gross = BigInt(gross); minOut = BigInt(minOut);
    const fee = feeOf(gross), net = gross - fee;
    if (net <= 0n || net > MAX_U128) throw new Error("Amount out of range");
    let cmds = "", inputs = [];
    if (fee > 0n) { cmds += CMD.TRANSFER; inputs.push(tri(C.eth, C.fee.recipient, fee)); }
    cmds += CMD.V4_SWAP;
    inputs.push(v4(ACT.SWAP_EXACT_IN_SINGLE + ACT.SETTLE_ALL + ACT.TAKE_ALL, [exactInSingle(r.key, true, net, minOut), encode(["address", "uint"], [C.eth, net]), encode(["address", "uint"], [r.token, minOut])]));
    return { to: C.ur, value: gross, data: execute(cmds, inputs, deadline), fee, net };
  }
  // Sell: tokens pulled through Permit2. The whole ETH output lands in the router, then PAY_PORTION(signer, 99%) and SWEEP(rest -> fee wallet).
  // minGross is enforced by the swap itself, so the signer's 99% is >= minNet.
  function poolSell(r, amountIn, minNet, deadline) {
    amountIn = BigInt(amountIn); minNet = BigInt(minNet);
    if (amountIn <= 0n || amountIn > MAX_U128) throw new Error("Amount out of range");
    const keep = 10000n - feeBps(), minGross = keep > 0n ? (minNet * 10000n + keep - 1n) / keep : minNet;
    let cmds = CMD.V4_SWAP;
    const inputs = [v4(ACT.SWAP_EXACT_IN_SINGLE + ACT.SETTLE_ALL + ACT.TAKE, [exactInSingle(r.key, false, amountIn, minGross), encode(["address", "uint"], [r.token, amountIn]), encode(["address", "address", "uint"], [C.eth, ADDRESS_THIS, 0n])])];
    if (feeBps() > 0n) { cmds += CMD.PAY_PORTION; inputs.push(tri(C.eth, MSG_SENDER, keep)); }
    cmds += CMD.SWEEP; inputs.push(tri(C.eth, feeBps() > 0n ? C.fee.recipient : MSG_SENDER, 0n));
    return { to: C.ur, value: 0n, data: execute(cmds, inputs, deadline), minGross };
  }
  // V4Quoter.quoteExactInputSingle((PoolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) -> (amountOut, gasEstimate)
  const poolQuoteData = (r, side, amount) => SEL.quoteSingle + encode([["tuple", [KEY_T, "bool", "uint", "bytes"]]], [[keyArr(r.key), side === "buy", BigInt(amount), "0x"]]);

  // ---------- helpers ----------
  const erc20Approve = (spender, amt) => SEL.approve + encode(["address", "uint"], [spender, amt]);
  const p2Approve = (token, spender, amt, exp) => SEL.p2approve + encode(["address", "address", "uint", "uint"], [token, spender, amt > MAX_U160 ? MAX_U160 : amt, exp]);
  const p2AllowanceData = (owner, token, spender) => SEL.p2allowance + encode(["address", "address", "address"], [owner, token, spender]);
  const balanceData = (a) => SEL.balanceOf + wa(a);
  const allowanceData = (o, s) => SEL.allowance + wa(o) + wa(s);
  const aggregate3Data = (calls) => SEL.aggregate3 + encode([["array", ["tuple", ["address", "bool", "bytes"]]]], [calls.map((c) => [c.to, true, c.data])]);
  function decodeAggregate3(h) {
    h = strip(h); const at = (o) => Number(BigInt("0x" + h.slice(o * 2, o * 2 + 64)));
    const base = at(0), n = at(base), out = [];
    for (let i = 0; i < n; i++) { const eo = base + 32 + at(base + 32 + i * 32); const ok = at(eo) === 1, bo = eo + at(eo + 32), len = at(bo); out.push({ ok, data: "0x" + h.slice((bo + 32) * 2, (bo + 32 + len) * 2) }); }
    return out;
  }

  const API = { C, SEL, CMD, ACT, MSG_SENDER, ADDRESS_THIS, MAX_U128, MAX_U160, MAX_U256, encode, words, wordAddr, toInt, decString, lc, strip, wa,
    feeOf, applySlippage, launchedData, decodeLaunched, curveCalls, decodeCurve, makeRoute, curveQuoteBuy, curveQuoteSell, curveBuy, curveSell,
    poolBuy, poolSell, poolQuoteData, execute, erc20Approve, p2Approve, p2AllowanceData, balanceData, allowanceData, aggregate3Data, decodeAggregate3 };
  // Local testing only: on localhost / 127.0.0.1, localStorage "ps_sniper_dev" = {"rpc":"http://127.0.0.1:8546","router":"0x…"} points at an anvil fork.
  try {
    if (typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      const d = JSON.parse(localStorage.getItem("ps_sniper_dev") || "null");
      if (d && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(d.rpc || "")) { C.rpc = d.rpc; C.dev = true; }
      if (d && /^0x[0-9a-fA-F]{40}$/.test(d.router || "")) C.router = d.router.toLowerCase();
    }
  } catch {}
  if (typeof module !== "undefined" && module.exports) module.exports = API; else { (root.PS = root.PS || {}).SC = API; }
})(typeof window !== "undefined" ? window : globalThis);
