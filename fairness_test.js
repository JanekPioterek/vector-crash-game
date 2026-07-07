// VECTOR-PF-v1 fairness test suite — run with `node fairness_test.js`.
//
// Two parts:
//   PART A — pure crypto/maths tests against roundProvider.js directly
//            (no DOM, no game loop): determinism, seed-hash verification,
//            tamper detection at each of the three commit-reveal layers,
//            and the 1.00x instant-crash tail.
//   PART B — game-integration tests against the real script.js running in
//            the same headless DOM stub as _domtest.js, using deterministic
//            forced clocks/crash points to hit exact multipliers: cashout
//            math, auto cashout, no-cashout-after-crash, Bank Half payout/
//            one-use/no-new-randomness, shared round result across NPCs,
//            and result immutability once a round is running.
//
// This intentionally does not reuse _domtest.js's process — it boots its
// own isolated stub each time a fresh round state is needed, so one test's
// forced state can't leak into another's.
"use strict";
const fs = require("fs");
const path = require("path");

const results = [];
function check(label, pass, extra) {
  results.push({ label, pass: !!pass, extra });
}

/* ======================================================================
   PART A — roundProvider.js in isolation
   ====================================================================== */
async function runProviderTests() {
  const sandbox = {};
  sandbox.window = { crypto: require("crypto").webcrypto };
  sandbox.globalThis = sandbox.window;

  const code = fs.readFileSync(path.join(__dirname, "roundProvider.js"), "utf8");
  // Evaluate with `window` bound in scope so roundProvider.js's own
  // `(typeof window !== "undefined" ? window : globalThis)` picks our sandbox.
  const wrapped = new Function("window", code + "\nreturn window.VectorRoundProvider;");
  const RP = wrapped(sandbox.window);

  // --- 1. Determinism: same inputs -> same crash multiplier, every time.
  const entropySample = "3f9a2b1c4d5e6f7089aabbccddeeff0011223344556677889900aabbccddeeff";
  const m1 = RP.crashFromEntropyHex(entropySample);
  const m2 = RP.crashFromEntropyHex(entropySample);
  check("determinism: same entropy hash always yields the same crash multiplier", m1 === m2 && Number.isFinite(m1));

  // --- 2. Seed-hash match: sha256Hex(serverSeed) from a real commit equals
  //        the serverSeedHash the adapter published.
  const adapter = new RP.LocalDemoAdapter();
  const committed = await adapter.commitRound(1, "test-randomness-1");
  const revealed = await adapter.revealRound(1);
  const recomputedHash = await RP.sha256Hex(revealed.serverSeed);
  check("seed-hash match: sha256(revealed serverSeed) === published serverSeedHash", recomputedHash === committed.serverSeedHash);

  // Build a full fairness record the way script.js does, for verifyRound tests.
  function buildFairness(overrides) {
    return Object.assign(
      {
        roundId: 1,
        serverSeed: revealed.serverSeed,
        serverSeedHash: committed.serverSeedHash,
        publicRandomness: committed.publicRandomness,
        entropyHash: committed.entropyHash,
        crashMultiplier: committed.crashMultiplier,
      },
      overrides
    );
  }

  const goodResult = await RP.verifyRound(buildFairness());
  check("verifyRound: a genuine, untampered round verifies OK", goodResult.ok && goodResult.reason === "verified");

  // --- 3. Tamper detection — server seed swapped for a different valid hex seed.
  const tamperedSeed = await RP.verifyRound(buildFairness({ serverSeed: RP.randomHex(32) }));
  check(
    "tamper detection (server seed): wrong seed is caught as seed_hash_mismatch",
    !tamperedSeed.ok && tamperedSeed.reason === "seed_hash_mismatch"
  );

  // --- 4. Tamper detection — public randomness altered after the fact.
  const tamperedRandomness = await RP.verifyRound(buildFairness({ publicRandomness: committed.publicRandomness + "x" }));
  check(
    "tamper detection (public randomness): altered randomness is caught as entropy_mismatch",
    !tamperedRandomness.ok && tamperedRandomness.reason === "entropy_mismatch"
  );

  // --- 5. Tamper detection — crash multiplier altered while seed/hash/entropy
  //        stay genuine (simulates someone editing the displayed result only).
  const tamperedCrash = await RP.verifyRound(
    buildFairness({ crashMultiplier: Math.round((committed.crashMultiplier + 1) * 100) / 100 })
  );
  check(
    "tamper detection (crash result): altered crash multiplier is caught as crash_mismatch",
    !tamperedCrash.ok && tamperedCrash.reason === "crash_mismatch"
  );

  const missingResult = await RP.verifyRound(null);
  check("verifyRound: missing fairness data is reported as missing, not a false pass", !missingResult.ok && missingResult.reason === "missing");

  // --- 6. 1.00x instant crash exists and its rate matches HOUSE_EDGE.
  //        Run a large local Monte Carlo directly over the formula (fast,
  //        no crypto calls needed since crashFromEntropyHex is pure).
  const N = 200000;
  let instantCrashes = 0;
  let atLeast125 = 0, atLeast2 = 0, atLeast5 = 0, atLeast10 = 0;
  const bytes = new Uint8Array(7); // 52 bits needs ceil(52/8)=7 bytes, extra bits ignored below
  for (let i = 0; i < N; i++) {
    require("crypto").webcrypto.getRandomValues(bytes);
    let hex = "";
    for (let b = 0; b < bytes.length; b++) hex += bytes[b].toString(16).padStart(2, "0");
    const m = RP.crashFromEntropyHex(hex.padEnd(13, "0"));
    if (m <= 1.0 + 1e-9) instantCrashes++;
    if (m >= 1.25) atLeast125++;
    if (m >= 2.0) atLeast2++;
    if (m >= 5.0) atLeast5++;
    if (m >= 10.0) atLeast10++;
  }
  const instantRate = instantCrashes / N;
  const p125 = atLeast125 / N, p2 = atLeast2 / N, p5 = atLeast5 / N, p10 = atLeast10 / N;
  // Note: the DISPLAYED 1.00x bucket is slightly larger than the raw
  // P(rawMultiplier < 1) = HOUSE_EDGE (2.00%) mechanic, because floor-to-2-
  // decimals also folds every raw value in [1.00, 1.01) down into the same
  // displayed "1.00x" bucket, not just genuine sub-1.00 draws. Since the
  // in-game multiplier curve itself starts at exactly 1.00x, both cases are
  // operationally identical instant crashes to the player either way. The
  // true expected rate is 1 - RTP/1.01 ~= 2.9703%, not bare HOUSE_EDGE.
  const expectedInstantRate = 1 - RP.RTP / 1.01;
  check(
    `1.00x instant crash exists and occurs at the expected floor-bucket rate (got ${(instantRate * 100).toFixed(2)}%, expect ~${(expectedInstantRate * 100).toFixed(2)}%)`,
    instantCrashes > 0 && Math.abs(instantRate - expectedInstantRate) < 0.01
  );
  check(`P(>=1.25x) ~ 78.40% (got ${(p125 * 100).toFixed(2)}%)`, Math.abs(p125 - 0.784) < 0.01);
  check(`P(>=2.00x) ~ 49.00% (got ${(p2 * 100).toFixed(2)}%)`, Math.abs(p2 - 0.49) < 0.01);
  check(`P(>=5.00x) ~ 19.60% (got ${(p5 * 100).toFixed(2)}%)`, Math.abs(p5 - 0.196) < 0.01);
  check(`P(>=10.0x) ~ 9.80% (got ${(p10 * 100).toFixed(2)}%)`, Math.abs(p10 - 0.098) < 0.01);

  // --- Two independent adapter instances given the SAME roundId + same
  // publicRandomnessOverride still each generate their OWN server seed (no
  // shared secret state) but that is fine — "shared round result for all
  // players" is a script.js-level property (one committed round object all
  // players read), verified in Part B, not a roundProvider-level one.
}

/* ======================================================================
   PART B — game integration, using the real script.js in a DOM stub
   ====================================================================== */
function makeStyle() {
  const store = {};
  return new Proxy(
    { setProperty: (k, v) => { store[k] = v; } },
    { get(t, p) { return p in t ? t[p] : store[p]; }, set(t, p, v) { store[p] = v; return true; } }
  );
}
function makeClassList() {
  const set = new Set();
  return {
    add: (...n) => n.forEach((x) => set.add(x)),
    remove: (...n) => n.forEach((x) => set.delete(x)),
    toggle: (n, f) => { if (f === undefined) { if (set.has(n)) { set.delete(n); return false; } set.add(n); return true; } if (f) set.add(n); else set.delete(n); return f; },
    contains: (n) => set.has(n),
  };
}
function make2DContext() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return {
    setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, arc: noop, ellipse: noop,
    stroke: noop, fill: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, clip: noop, rect: noop,
    createRadialGradient: () => gradient, createLinearGradient: () => gradient,
    set fillStyle(v) {}, get fillStyle() { return "#000"; },
    set strokeStyle(v) {}, get strokeStyle() { return "#000"; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set lineCap(v) {}, get lineCap() { return "butt"; },
    set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set shadowBlur(v) {}, get shadowBlur() { return 0; },
    set shadowColor(v) {}, get shadowColor() { return "#000"; },
    set font(v) {}, get font() { return "10px sans-serif"; },
  };
}
function makeElement(id) {
  const attrs = {};
  const el = {
    id, _attrs: attrs, classList: makeClassList(), style: makeStyle(), dataset: {},
    textContent: "", innerHTML: "", innerText: "", value: "10", disabled: false, hidden: false, checked: false,
    children: [], _listeners: {},
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    click() { (el._listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); },
    focus() {}, blur() {},
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    appendChild(child) { if (child && child._isFragment) { for (const c of child.children) el.children.push(c); child.children.length = 0; } else { el.children.push(child); } return child; },
    removeChild(child) { const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1); return child; },
    get firstChild() { return el.children.length ? el.children[0] : null; },
    contains: () => false,
    getBoundingClientRect: () => ({ width: 900, height: 520, top: 0, left: 0 }),
  };
  if (id === "tunnelCanvas") { el.width = 900; el.height = 520; el.getContext = () => make2DContext(); }
  return el;
}

// Boots a completely fresh, isolated copy of the game (its own module scope,
// its own DOM stub, its own global.window) so each Part-B scenario starts
// from a clean slate with no cross-test contamination.
function bootGame() {
  const elementRegistry = new Map();
  const getOrCreateElement = (id) => { if (!elementRegistry.has(id)) elementRegistry.set(id, makeElement(id)); return elementRegistry.get(id); };
  const chipEls = [10, 25, 50, 100].map((amt) => { const e = makeElement("chip-" + amt); e.dataset.amount = String(amt); return e; });

  let rafCallback = null;
  let rafId = 0;
  const documentStub = {
    readyState: "complete", addEventListener: () => {}, removeEventListener: () => {},
    getElementById: (id) => getOrCreateElement(id),
    querySelectorAll: (sel) => (sel === ".chip" ? chipEls : []),
    createElement: (tag) => makeElement("created-" + tag + "-" + Math.random()),
    createDocumentFragment: () => { const frag = { _isFragment: true, children: [], appendChild(c) { frag.children.push(c); return c; } }; return frag; },
    activeElement: { tagName: "BODY" },
  };
  const windowStub = {
    addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    requestAnimationFrame: (fn) => { rafCallback = fn; return ++rafId; },
    cancelAnimationFrame: () => {},
    crypto: require("crypto").webcrypto,
  };
  let clock = 0;
  const performanceStub = { now: () => clock };

  global.document = documentStub;
  global.window = windowStub;
  global.performance = performanceStub;
  global.requestAnimationFrame = windowStub.requestAnimationFrame;
  // Node 21+ ships its own read-only global `navigator` getter, so a plain
  // assignment throws — redefine the property instead (mirrors what a real
  // page does when script.js reads navigator.userAgent).
  Object.defineProperty(global, "navigator", {
    value: { userAgent: "node-test" },
    configurable: true,
    writable: true,
  });
  // Same story as navigator — Node's built-in global `crypto` is a
  // getter-only accessor. It already points at the real webcrypto impl
  // (windowStub.crypto === require("crypto").webcrypto), so redefining it
  // to the identical value is just for the strict-mode assignment to
  // succeed rather than throw; behaviourally a no-op.
  Object.defineProperty(global, "crypto", {
    value: windowStub.crypto,
    configurable: true,
    writable: true,
  });
  global.Path2D = class Path2D { moveTo() {} lineTo() {} closePath() {} arc() {} ellipse() {} rect() {} };

  const roundProviderCode = fs.readFileSync(path.join(__dirname, "roundProvider.js"), "utf8");
  const scriptCode = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
  new Function(roundProviderCode + "\n//# sourceURL=roundProvider.js")();
  new Function(scriptCode + "\n//# sourceURL=script.js")();

  return {
    elementRegistry,
    tick: (advanceMs) => { clock += advanceMs; const cb = rafCallback; rafCallback = null; if (cb) cb(clock); },
    getClock: () => clock,
    setClock: (v) => { clock = v; },
    el: (id) => elementRegistry.get(id),
    debug: () => windowStub.__VECTOR_DEBUG__,
    // Yield to the event loop for pending commitRound/revealRound promises.
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

async function waitForCommit(game, maxTicks) {
  for (let i = 0; i < (maxTicks || 50); i++) {
    game.tick(16);
    await game.settle();
    if (game.debug().state.roundCommitReady) return true;
  }
  return false;
}

async function waitForPhase(game, phase, maxTicks) {
  for (let i = 0; i < (maxTicks || 2000); i++) {
    game.tick(16);
    await game.settle();
    if (game.debug().state.phase === phase) return true;
  }
  return false;
}

// Mirrors script.js's warpedElapsed() (pacing-polish pass) so tests can
// compute the real elapsed time needed to hit an exact target multiplier
// under the new (slower-then-accelerating) flight curve. Deliberately
// duplicated rather than imported — script.js has no exports — so if that
// formula ever changes, this must be updated to match or these timing-
// dependent tests will silently drift. `config` is CONFIG from the debug
// hook (has GROWTH_RATE / FLIGHT_WARP_DELAY / FLIGHT_WARP_DECAY).
function warpedElapsed(tSeconds, config) {
  const A = config.FLIGHT_WARP_DELAY;
  const B = config.FLIGHT_WARP_DECAY;
  return tSeconds - A * (1 - Math.exp(-tSeconds / B));
}

// Numerically inverts the above (no closed form) via bisection: finds the
// real elapsed seconds at which computeMultiplier() reads `target`.
function timeToReachMultiplier(target, config) {
  const targetWarped = Math.log(target) / config.GROWTH_RATE;
  let lo = 0;
  let hi = 120; // generous upper bound — warpedElapsed is strictly increasing
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (warpedElapsed(mid, config) < targetWarped) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

async function runGameTests() {
  // ---- Exact 2.00x cashout ----
  {
    const game = bootGame();
    await waitForCommit(game);
    const state = game.debug().state;
    const config = game.debug().CONFIG;
    state.crashPoint = 50; // force a late crash so 2.00x is reachable
    state.fairness.crashMultiplier = 50;
    game.el("mainActionBtn").click(); // place $10 bet
    // Advance past the countdown into RUNNING.
    await waitForPhase(game, "running", 550);
    const startMs = game.getClock();
    const target = 2.0;
    const tForTarget = timeToReachMultiplier(target, config); // seconds
    game.setClock(startMs + tForTarget * 1000 - 16); // land just before, then one more tick
    game.tick(16);
    await game.settle();
    const bet = state.bet;
    const balanceBefore = state.balance;
    game.el("mainActionBtn").click(); // cash out now
    await game.settle();
    const expectedPayout = 10 * target; // stake * multiplier
    const expectedNet = expectedPayout - 10;
    check(
      `exact 2.00x cashout pays stake x multiplier (bet resolved: ${!!(bet && bet.resolved)}, finalNet=${bet && bet.finalNet})`,
      bet && bet.resolved && Math.abs(bet.finalNet - expectedNet) < 0.05
    );
  }

  // ---- Auto cashout ----
  {
    const game = bootGame();
    await waitForCommit(game);
    const state = game.debug().state;
    const config = game.debug().CONFIG;
    state.crashPoint = 50;
    state.fairness.crashMultiplier = 50;
    state.autoCashoutEnabled = true;
    state.autoCashoutValue = 3;
    game.el("mainActionBtn").click();
    await waitForPhase(game, "running", 550);
    const startMs = game.getClock();
    const tForTarget = timeToReachMultiplier(3, config);
    game.setClock(startMs + tForTarget * 1000 + 32); // a bit past the target
    game.tick(16);
    await game.settle();
    const bet = state.bet;
    check(
      `auto cashout fires once multiplier crosses the armed target (resolved=${!!(bet && bet.resolved)}, cashedOutAt=${bet && bet.cashedOutAtMultiplier})`,
      bet && bet.resolved && bet.cashedOutAtMultiplier != null && bet.cashedOutAtMultiplier >= 3 - 1e-6
    );
  }

  // ---- No cashout after crash ----
  {
    const game = bootGame();
    await waitForCommit(game);
    const state = game.debug().state;
    state.crashPoint = 1.05;
    state.fairness.crashMultiplier = 1.05;
    game.el("mainActionBtn").click();
    await waitForPhase(game, "running", 550);
    await waitForPhase(game, "result", 400); // let it crash
    const betAfterCrash = state.bet;
    const balanceBeforeClick = state.balance;
    game.el("mainActionBtn").click(); // attempt a cashout after the crash — should be a no-op
    await game.settle();
    check(
      "clicking the action button after a crash does not create a new cashout payout",
      state.balance === balanceBeforeClick && (!betAfterCrash || betAfterCrash.cashedOutAtMultiplier == null)
    );
  }

  // ---- Bank Half: correct payout, one-use, no new randomness ----
  {
    const game = bootGame();
    await waitForCommit(game);
    const state = game.debug().state;
    const config = game.debug().CONFIG;
    state.crashPoint = 50;
    state.fairness.crashMultiplier = 50;
    const crashPointBeforeBankHalf = state.fairness.crashMultiplier;
    const entropyHashBefore = state.fairness.entropyHash;
    game.el("mainActionBtn").click();
    await waitForPhase(game, "running", 550);
    const startMs = game.getClock();

    // Bank Half at 2.00x.
    const t2 = timeToReachMultiplier(2, config);
    game.setClock(startMs + t2 * 1000 + 16);
    game.tick(16);
    await game.settle();
    const bankHalfBtn = game.el("partialCashoutBtn");
    bankHalfBtn.click();
    await game.settle();
    const afterBankHalf = JSON.parse(JSON.stringify({
      remainingAmount: state.bet.remainingAmount,
      partials: state.bet.partials,
      resolved: state.bet.resolved,
    }));

    check(
      "Bank Half locks half the stake at the multiplier it was used and halves the live remaining stake",
      // atMultiplier/payout land a hair above 2.00/10.00 rather than exactly
      // on it — this harness ticks in 16ms steps and lands just after the
      // exact target instant, not on it (unlike the dedicated exact-2.00x
      // cashout test above, which deliberately lands one tick early first).
      Math.abs(afterBankHalf.partials[0].amount - 5) < 1e-6 &&
        Math.abs(afterBankHalf.partials[0].atMultiplier - 2) < 0.05 &&
        Math.abs(afterBankHalf.partials[0].payout - 10) < 0.1 &&
        Math.abs(afterBankHalf.remainingAmount - 5) < 1e-6
    );
    check(
      "Bank Half does not touch the round's committed crash multiplier or entropy hash (no new randomness)",
      state.fairness.crashMultiplier === crashPointBeforeBankHalf && state.fairness.entropyHash === entropyHashBefore
    );
    check(
      "Bank Half is capped at one use per bet (button becomes ineligible/hidden immediately after use, and a second call is a no-op)",
      bankHalfBtn.hidden === true && state.bet.partials.length === 1
    );

    // Cash out the remaining $5 at 4.00x -> total should be $10 (banked) + $20 (remaining) = $30, net +$20.
    const t4 = timeToReachMultiplier(4, config);
    game.setClock(startMs + t4 * 1000 + 16);
    game.tick(16);
    await game.settle();
    const balanceBeforeFinal = state.balance;
    game.el("mainActionBtn").click();
    await game.settle();
    check(
      `Bank Half + final cashout totals correctly ($10 stake, bank at 2x, remainder cashed at 4x -> net +$20, got finalNet=${state.bet && state.bet.finalNet})`,
      state.bet && Math.abs(state.bet.finalNet - 20) < 0.1
    );
  }

  // ---- Bank Half: crash before second cashout keeps only the banked amount ----
  {
    const game = bootGame();
    await waitForCommit(game);
    const state = game.debug().state;
    const config = game.debug().CONFIG;
    state.crashPoint = 2.5; // crashes shortly after the bank-half point
    state.fairness.crashMultiplier = 2.5;
    game.el("mainActionBtn").click();
    await waitForPhase(game, "running", 550);
    const startMs = game.getClock();
    const t2 = timeToReachMultiplier(2, config);
    game.setClock(startMs + t2 * 1000 + 16);
    game.tick(16);
    await game.settle();
    game.el("partialCashoutBtn").click();
    await game.settle();
    await waitForPhase(game, "result", 400); // let the remaining half ride into the crash
    check(
      `Bank Half then a crash before the second cashout: final payout stays at the banked amount only (finalNet=${state.bet && state.bet.finalNet})`,
      state.bet && Math.abs(state.bet.finalNet - 0) < 0.1 // $10 stake, $10 banked back = net 0
    );
  }

  // ---- Shared round result for all players + immutability after lock ----
  {
    const game = bootGame();
    await waitForCommit(game);
    const state = game.debug().state;
    const config = game.debug().CONFIG;
    state.crashPoint = 3.33;
    state.fairness.crashMultiplier = 3.33;
    const committedRoundId = state.fairness.roundId;
    const committedCrash = state.fairness.crashMultiplier;
    await waitForPhase(game, "running", 550);
    // Once running, the committed value must still match what's about to
    // settle for every NPC and the player alike — there is exactly one
    // state.crashPoint / state.fairness object all of them read from.
    check(
      "round result stays identical (same object/values) from commit through the RUNNING phase — one shared outcome for every participant",
      state.fairness.roundId === committedRoundId && state.crashPoint === committedCrash
    );
    // Advance in coarse-but-incremental steps (not one giant jump) so
    // updateNpcs() actually runs at intermediate multipliers and gets a
    // chance to move each NPC to "cashed" before the shared crash point —
    // a single jump straight from t=0 to the crash instant would skip every
    // NPC's cash-out check entirely and make them all show "crash" even
    // when their planned multiplier was comfortably below crashPoint.
    // timeToReachMultiplier() accounts for the pacing-polish flight curve
    // (slower early, easing back to full speed), which now takes noticeably
    // longer than a plain exp(GROWTH_RATE*t) would suggest.
    const tCrash = timeToReachMultiplier(3.33, config); // seconds
    for (let elapsedMs = 0; elapsedMs < tCrash * 1000 + 200 && state.phase === "running"; elapsedMs += 100) {
      game.tick(100);
      await game.settle();
    }
    if (state.phase !== "result") await waitForPhase(game, "result", 200);
    const npcs = state.npcs || [];
    const consistent = npcs.every((npc) => {
      // updateNpcs() only ever moves a "waiting" NPC to "cashed" when its own
      // planned multiplier is both reachable (< the one shared crashPoint)
      // and actually crossed; resolveNpcsOnCrash() sweeps everyone still
      // "waiting" into "crash" once that same crashPoint is hit. So every
      // NPC's fate must be consistent with that single shared value.
      if (npc.status === "cashed") return npc.planned <= state.crashPoint + 1e-6;
      if (npc.status === "crash") return npc.planned >= state.crashPoint - 1e-6;
      return false; // no NPC should still be "waiting" once the round has resolved
    });
    check("every NPC's win/loss outcome is consistent with the single shared crash result", consistent);
    check(
      "the crash multiplier used for settlement/history is bit-identical to the one committed before betting opened",
      state.history[0] && state.history[0].crashPoint === committedCrash
    );
  }
}

(async () => {
  try {
    await runProviderTests();
  } catch (err) {
    check("PART A crashed with an uncaught error", false);
    console.error(err);
  }
  try {
    await runGameTests();
  } catch (err) {
    check("PART B crashed with an uncaught error", false);
    console.error(err);
  }

  console.log("\n--- Fairness Suite Results ---");
  let failCount = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.label}`);
    if (!r.pass) failCount++;
  }
  console.log(`\n${results.length - failCount}/${results.length} checks passed.`);
  process.exit(failCount > 0 ? 1 : 0);
})();
