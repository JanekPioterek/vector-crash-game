/* ==========================================================================
   VECTOR — script.js
   Front-end-only crash game prototype. No backend, no real money, no auth.

   Table of contents:
     1.  Configuration
     2.  DOM references
     3.  Game state
     4.  Seeded RNG / round generation (provably-fair simulation)
     5.  Multiplier calculation
     6.  Round loop (state machine)
     7.  Betting logic
     8.  Cashout logic
     9.  Overdrive logic
     10. Fake live bets (NPCs)
     11. History
     12. UI rendering
     13. Tunnel / pod canvas animation
     14. Input wiring
     15. Boot
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* 1. Configuration                                                    */
  /* ------------------------------------------------------------------ */
  // Feature flag: keeps the "table of ships" concept (colour-coded fleet
  // rendered around the hero, matching leaderboard ship icons) fully built
  // but switched off for a simpler MVP. Flip to true to re-enable — no
  // other code needs to change; every fleet-related function below checks
  // this flag and falls back to the plain NPC-list-only behaviour when off.
  const FEATURE_FLEET_TABLE = false;

  const CONFIG = {
    STARTING_BALANCE: 1250.0,
    MIN_BET: 1,
    MAX_BET: 500,
    HOUSE_EDGE: 0.04, // placeholder house edge, drives instant-crash probability
    COUNTDOWN_SECONDS: 3.0,
    RESULT_DISPLAY_SECONDS: 2.6,
    CRUISE_RATE: 0.1, // exponential growth constant, cruise mode (per second) — slower overall climb
    SPEED_RAMP_SECONDS: 2.4, // visual tunnel speed eases in over this many seconds after launch
    OVERDRIVE_RATE: 0.46, // exponential growth constant, overdrive mode (per second)
    MAX_VISIBLE_MULTIPLIER: 1000,
    TRAIL_BASE_LEN: 22, // px, contrail length at round start
    TRAIL_RATE_CRUISE: 30, // px/sec, contrail growth in cruise
    TRAIL_RATE_OVERDRIVE: 68, // px/sec, contrail growth in overdrive
    TRAIL_MAX_LEN: 210, // px, visual cap so the contrail never overruns the frame
    STORM_THRESHOLD_MULTIPLIER: 10, // energy-storm flickers only appear past this multiplier
    CASHOUT_WARP_MS: 680, // duration of the ship's jump-to-lightspeed departure on cashout
    CASHOUT_TRAIL_FADE_MS: 1800, // how long the afterimage streak lingers once the ship is gone
    QUICK_AMOUNTS: [10, 25, 50, 100],
    HISTORY_LENGTH: 20,
    // Table size when FEATURE_FLEET_TABLE is on: 3-5 opponents + the
    // player = 4-6 total, matching the "small table, visible fleet"
    // concept rather than an anonymous scrolling list.
    NPC_MIN_FLEET: 3,
    NPC_MAX_FLEET: 5,
    // Plain MVP list size when the fleet feature is off — the original,
    // larger anonymous-list range.
    NPC_MIN_MVP: 5,
    NPC_MAX_MVP: 9,
    NPC_NAMES: [
      "Kestrel_09", "Nyx.Vega", "Halcyon", "0xDrift", "Ionis", "Mara_K",
      "Pulsegrid", "Vantablk", "Wraith77", "Sable_Q", "Toru.eth", "Cinder",
      "Nova_Line", "Aeon_7", "Riven", "Kilo.Zed", "Ember_X", "Glasswing",
    ],
    // Identity colours for opponent ships/leaderboard icons. Deliberately
    // desaturated ("squadron badge" rather than rainbow) and kept clear of
    // the player's own functional colours (cyan cruise, violet-magenta
    // overdrive, gold-green success, red crash) so an opponent's identity
    // colour is never mistaken for a state change on the player's own ship.
    FLEET_COLORS: [
      { r: 255, g: 198, b: 92 },  // solar gold
      { r: 77, g: 217, b: 168 },  // emerald
      { r: 255, g: 111, b: 168 }, // rose
      { r: 207, g: 232, b: 255 }, // frost
      { r: 155, g: 140, b: 255 }, // slate violet
      { r: 255, g: 138, b: 92 },  // ember coral
    ],
  };

  // Formation slots for opponent ships, as fractional offsets from the
  // player's own ship position (so they scale with canvas size). All sit
  // within the same chase-camera depth band as the hero — nose away from
  // camera, engines toward it — just smaller and offset left/right, never
  // pushed up toward the vanishing point on their own.
  const FLEET_SLOTS = [
    { dxFrac: -0.16, dyFrac: -0.045, scale: 0.62 },  // closer left
    { dxFrac: 0.155, dyFrac: -0.05, scale: 0.6 },    // closer right
    { dxFrac: -0.245, dyFrac: -0.115, scale: 0.46 }, // farther left
    { dxFrac: 0.235, dyFrac: -0.105, scale: 0.46 },  // farther right
    { dxFrac: -0.02, dyFrac: -0.17, scale: 0.34 },   // farthest, center-back
  ];

  const PHASE = {
    COUNTDOWN: "countdown",
    RUNNING: "running",
    RESULT: "result",
  };

  const MODE = {
    CRUISE: "cruise",
    OVERDRIVE: "overdrive",
  };

  /* ------------------------------------------------------------------ */
  /* 2. DOM references                                                   */
  /* ------------------------------------------------------------------ */
  const el = {
    balanceValue: document.getElementById("balanceValue"),
    fairBadge: document.getElementById("fairBadge"),
    fairPopover: document.getElementById("fairPopover"),
    fairRound: document.getElementById("fairRound"),
    fairSeed: document.getElementById("fairSeed"),
    fairResult: document.getElementById("fairResult"),
    soundToggle: document.getElementById("soundToggle"),

    howToPlayBtn: document.getElementById("howToPlayBtn"),
    howToPlayOverlay: document.getElementById("howToPlayOverlay"),
    howToPlayClose: document.getElementById("howToPlayClose"),

    settingsBtn: document.getElementById("settingsBtn"),
    settingsPopover: document.getElementById("settingsPopover"),
    reduceMotionToggle: document.getElementById("reduceMotionToggle"),
    resetBalanceBtn: document.getElementById("resetBalanceBtn"),
    lowBalanceBanner: document.getElementById("lowBalanceBanner"),
    lowBalanceReset: document.getElementById("lowBalanceReset"),

    srAnnounce: document.getElementById("srAnnounce"),
    betHint: document.getElementById("betHint"),

    gameStage: document.getElementById("gameStage"),
    canvas: document.getElementById("tunnelCanvas"),
    modeLabel: document.getElementById("modeLabel"),
    multiplierValue: document.getElementById("multiplierValue"),
    resultBanner: document.getElementById("resultBanner"),
    countdownWrap: document.getElementById("countdownWrap"),
    countdownText: document.getElementById("countdownText"),
    crashFlash: document.getElementById("crashFlash"),

    betAmountInput: document.getElementById("betAmountInput"),
    betDecrease: document.getElementById("betDecrease"),
    betIncrease: document.getElementById("betIncrease"),
    chips: Array.from(document.querySelectorAll(".chip")),

    autoCashoutToggle: document.getElementById("autoCashoutToggle"),
    autoCashoutValue: document.getElementById("autoCashoutValue"),

    overdriveBtn: document.getElementById("overdriveBtn"),
    overdriveBtnLabel: document.getElementById("overdriveBtnLabel"),
    mainActionBtn: document.getElementById("mainActionBtn"),
    mainActionLabel: document.getElementById("mainActionLabel"),

    panelToggle: document.getElementById("panelToggle"),
    panelToggleLabel: document.getElementById("panelToggleLabel"),
    panelBody: document.getElementById("panelBody"),
    tabLive: document.getElementById("tabLive"),
    tabHistory: document.getElementById("tabHistory"),
    panelLive: document.getElementById("panelLive"),
    panelHistory: document.getElementById("panelHistory"),
    liveBetsList: document.getElementById("liveBetsList"),
    historyList: document.getElementById("historyList"),
  };

  // Mutable (not const): the Settings panel lets a player force this on
  // independent of their OS-level preference, so every draw function that
  // reads it keeps working unchanged when the value flips at runtime.
  let prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  /* ------------------------------------------------------------------ */
  /* 3. Game state                                                       */
  /* ------------------------------------------------------------------ */
  const state = {
    balance: CONFIG.STARTING_BALANCE,
    roundId: 0,
    phase: PHASE.COUNTDOWN,
    mode: MODE.CRUISE,

    crashPoint: null,
    seedHash: null,

    roundStartTime: null, // ms, performance.now() at moment round begins
    overdriveElapsedAtActivation: null, // seconds elapsed in round at activation
    overdriveActive: false,

    currentMultiplier: 1.0,
    countdownEndTime: null,
    resultEndTime: null,

    bet: null, // { amount, cashedOutAtMultiplier, mode, resolved }
    betAmount: 10,
    autoCashoutEnabled: false,
    autoCashoutValue: 2.0,

    npcs: [],
    history: [],

    soundOn: false,

    trailFrozenLen: null, // px, contrail length locked in at the moment of crash
    cashoutWarp: null, // { bornAt } — set the instant a successful cashout fires
    cashoutTrail: null, // { bornAt, x1, y1, x2, y2 } — fading afterimage left once the warp completes

    env: {
      starsBuilt: false,
      stars: [],
      constellations: [],
      debris: [],
      nebulae: [],
      pulsar: null,
      storm: null,
      nextStormAt: 0,
    },
  };

  let animRafId = null;

  /* ------------------------------------------------------------------ */
  /* 4. Seeded RNG / round generation                                    */
  /* ------------------------------------------------------------------ */
  // Mulberry32 — small, fast, deterministic PRNG. Seeded fresh each round so
  // the crash point is fully determined before the round starts and cannot
  // be influenced by any in-round player action (Overdrive included).
  function createRng(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let x = t;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeSeed(roundId) {
    // Simulates a server seed. In a real system this would be a committed
    // hash revealed after the round for verification.
    const raw = Date.now() ^ Math.imul(roundId + 1, 2654435761);
    return raw >>> 0;
  }

  function fakeHash(seed) {
    // Cosmetic only — represents a "committed" server seed hash shown in the
    // Provably Fair popover before the round result is known.
    const s = seed.toString(16).padStart(8, "0");
    return `0x${s}${s.split("").reverse().join("")}`.slice(0, 24) + "…";
  }

  // Standard crash-curve distribution: a house-edge chunk forces frequent
  // instant (1.00x) crashes, otherwise crash point follows a heavy-tailed
  // 1/(1-r) curve — lots of low multipliers, some mid-range, rare extremes.
  function generateCrashPoint(rng, houseEdge) {
    if (rng() < houseEdge) return 1.0;
    const r = rng();
    let crash = 0.99 / (1 - r);
    crash = Math.min(crash, CONFIG.MAX_VISIBLE_MULTIPLIER);
    crash = Math.max(1.0, crash);
    return Math.floor(crash * 100) / 100;
  }

  function generateRound() {
    state.roundId += 1;
    const seed = makeSeed(state.roundId);
    const rng = createRng(seed);
    state.crashPoint = generateCrashPoint(rng, CONFIG.HOUSE_EDGE);
    state.seedHash = fakeHash(seed);
    // Reserve extra rng draws for NPC planned-cashout generation so NPC
    // behaviour is also pre-determined and independent of the crash point.
    state._rng = rng;
    regenerateEnvironmentForRound(rng);
  }

  // Background nebulae and the pulsar re-seed each round from the same rng
  // that generates the crash point — purely cosmetic, but it keeps the
  // backdrop from looking identical round after round.
  function regenerateEnvironmentForRound(rng) {
    const nebulae = [];
    for (let i = 0; i < 2; i++) {
      nebulae.push({
        x: 0.15 + rng() * 0.7,
        y: 0.05 + rng() * 0.32,
        r: 0.16 + rng() * 0.14,
        hueTilt: rng() < 0.5 ? -1 : 1,
        driftVx: (rng() - 0.5) * 0.003,
        driftVy: (rng() - 0.5) * 0.0015,
      });
    }
    state.env.nebulae = nebulae;

    state.env.pulsar = {
      x: 0.1 + rng() * 0.8,
      y: 0.05 + rng() * 0.26,
      cyclePhase: rng() * Math.PI * 2,
      cycleSeconds: 5 + rng() * 3,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5. Multiplier calculation                                           */
  /* ------------------------------------------------------------------ */
  // multiplier(t) is a continuous piecewise-exponential curve. Overdrive
  // changes the growth *rate* from the moment of activation onward while
  // preserving continuity (no jump) — it never touches state.crashPoint.
  function computeMultiplier(nowMs) {
    const t = (nowMs - state.roundStartTime) / 1000;
    if (!state.overdriveActive) {
      return Math.exp(CONFIG.CRUISE_RATE * t);
    }
    const t0 = state.overdriveElapsedAtActivation;
    const m0 = Math.exp(CONFIG.CRUISE_RATE * t0);
    return m0 * Math.exp(CONFIG.OVERDRIVE_RATE * (t - t0));
  }

  // Contrail length follows the same piecewise growth shape as the
  // multiplier (linear here, exponential there) so the trail visibly
  // lengthens in step with the run, then kicks harder once Overdrive hits.
  function computeTrailLength(nowMs) {
    const t = (nowMs - state.roundStartTime) / 1000;
    let len;
    if (!state.overdriveActive) {
      len = CONFIG.TRAIL_BASE_LEN + CONFIG.TRAIL_RATE_CRUISE * t;
    } else {
      const t0 = state.overdriveElapsedAtActivation;
      const lenAtT0 = CONFIG.TRAIL_BASE_LEN + CONFIG.TRAIL_RATE_CRUISE * t0;
      len = lenAtT0 + CONFIG.TRAIL_RATE_OVERDRIVE * (t - t0);
    }
    return Math.min(CONFIG.TRAIL_MAX_LEN, len);
  }

  /* ------------------------------------------------------------------ */
  /* 6. Round loop (state machine)                                       */
  /* ------------------------------------------------------------------ */
  function startCountdown() {
    state.phase = PHASE.COUNTDOWN;
    state.mode = MODE.CRUISE;
    state.overdriveActive = false;
    state.overdriveElapsedAtActivation = null;
    state.currentMultiplier = 1.0;
    state.bet = null;
    state.cashoutWarp = null;
    state.cashoutTrail = null;
    state.countdownEndTime = performance.now() + CONFIG.COUNTDOWN_SECONDS * 1000;

    generateRound();
    generateNpcs();

    el.gameStage.dataset.mode = "cruise";
    renderAll();
  }

  function beginRound() {
    state.phase = PHASE.RUNNING;
    state.roundStartTime = performance.now();
    renderAll();
  }

  function triggerCrash(now) {
    state.trailFrozenLen = computeTrailLength(now);
    state.phase = PHASE.RESULT;
    state.currentMultiplier = state.crashPoint;
    state.resultEndTime = performance.now() + CONFIG.RESULT_DISPLAY_SECONDS * 1000;
    el.gameStage.dataset.mode = "crashed";

    resolveNpcsOnCrash();
    pushHistory(state.crashPoint);
    flashCrash();
    playSound("crash");

    if (state.bet && !state.bet.resolved) {
      state.bet.resolved = true;
      state.bet.lost = true;
      announce(`Collapsed at ${formatMult(state.crashPoint)} — lost ${formatMoney(state.bet.amount)}`);
    } else {
      announce(`Collapsed at ${formatMult(state.crashPoint)}`);
    }

    renderAll();
  }

  function endResultPhase() {
    startCountdown();
  }

  function tick() {
    const now = performance.now();

    // The whole per-frame body is guarded: a thrown error on any single
    // frame (rendering, NPC updates, whatever) must never permanently
    // freeze the loop. Without this, one bad frame silently kills every
    // future frame — including the ones that would render the ship, the
    // multiplier, and the live bets list — because requestAnimationFrame
    // never gets re-armed. Errors are logged so they're still diagnosable
    // via the browser console instead of failing invisibly.
    try {
      if (state.phase === PHASE.COUNTDOWN) {
        const remaining = Math.max(0, state.countdownEndTime - now);
        renderCountdown(remaining);
        if (remaining <= 0) beginRound();
      } else if (state.phase === PHASE.RUNNING) {
        const m = computeMultiplier(now);
        if (m >= state.crashPoint) {
          triggerCrash(now);
        } else {
          state.currentMultiplier = m;
          checkAutoCashout();
          updateNpcs(m);
          renderMultiplier();
          renderLiveBets();
        }
      } else if (state.phase === PHASE.RESULT) {
        if (now >= state.resultEndTime) endResultPhase();
      }

      drawTunnel(now);
    } catch (err) {
      console.error("[VECTOR] frame error (loop continues):", err);
    }

    // Belt-and-suspenders: attempt the live bets render unconditionally,
    // every frame, regardless of phase or whatever happened above. Its own
    // internals are already individually guarded (see renderLiveBets).
    try {
      renderLiveBets();
    } catch (err) {
      console.error("[VECTOR] live bets render failed:", err);
    }

    animRafId = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ */
  /* 7. Betting logic                                                    */
  /* ------------------------------------------------------------------ */
  function clampBetAmount(v) {
    if (isNaN(v)) return CONFIG.MIN_BET;
    return Math.min(CONFIG.MAX_BET, Math.max(CONFIG.MIN_BET, Math.round(v)));
  }

  function setBetAmount(v) {
    state.betAmount = clampBetAmount(v);
    el.betAmountInput.value = state.betAmount;
    syncChipActiveState();
  }

  function placeBet() {
    if (state.phase !== PHASE.COUNTDOWN) return;
    if (state.bet) return;
    const amount = clampBetAmount(Number(el.betAmountInput.value));
    if (amount > state.balance) return;

    state.balance -= amount;
    state.bet = {
      amount,
      cashedOutAtMultiplier: null,
      mode: MODE.CRUISE,
      resolved: false,
      lost: false,
    };
    playSound("bet");
    announce(`Bet placed: ${formatMoney(amount)}`);
    renderAll();
  }

  // Manual recovery path once balance runs out (or any time, via Settings)
  // — a prototype has no deposit flow, so without this a player who loses
  // everything has no way to keep testing the game.
  function resetBalance() {
    state.balance = CONFIG.STARTING_BALANCE;
    announce(`Balance reset to ${formatMoney(CONFIG.STARTING_BALANCE)}`);
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* 8. Cashout logic                                                    */
  /* ------------------------------------------------------------------ */
  function cashOut() {
    if (state.phase !== PHASE.RUNNING) return;
    if (!state.bet || state.bet.resolved) return;

    const multiplier = state.currentMultiplier;
    state.bet.cashedOutAtMultiplier = multiplier;
    state.bet.mode = state.mode;
    state.bet.resolved = true;

    const payout = state.bet.amount * multiplier;
    state.balance += payout;

    // Jump-to-lightspeed departure: the ship rockets forward into the
    // vanishing point and vanishes over CONFIG.CASHOUT_WARP_MS. Purely
    // cosmetic — the round keeps running underneath for NPCs/history.
    // The trail's path is fixed at this instant; it starts fading in once
    // the warp itself finishes (bornAt is set then, in drawShip).
    const shipPos = shipAnchor();
    const vp = vanishingPoint();
    state.cashoutWarp = { bornAt: performance.now() };
    state.cashoutTrail = { bornAt: null, x1: shipPos.x, y1: shipPos.y, x2: vp.x, y2: vp.y };

    el.gameStage.dataset.mode = "cashed";
    playSound("cashout");
    announce(`Cashed out at ${formatMult(multiplier)} for ${formatMoney(payout)}`);
    renderAll();
  }

  function checkAutoCashout() {
    if (!state.autoCashoutEnabled) return;
    if (!state.bet || state.bet.resolved) return;
    if (state.currentMultiplier >= state.autoCashoutValue) {
      cashOut();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 9. Overdrive logic                                                  */
  /* ------------------------------------------------------------------ */
  function activateOverdrive() {
    if (state.phase !== PHASE.RUNNING) return;
    if (state.overdriveActive) return;
    if (!state.bet || state.bet.resolved) return;

    const now = performance.now();
    const elapsed = (now - state.roundStartTime) / 1000;
    state.overdriveActive = true;
    state.overdriveElapsedAtActivation = elapsed;
    state.mode = MODE.OVERDRIVE;

    el.gameStage.dataset.mode = "overdrive";
    pulseOverdrive();
    playSound("overdrive");
    announce("Overdrive activated");
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* 10. Fake live bets (NPCs)                                           */
  /* ------------------------------------------------------------------ */
  // Bet sizes skew small — most players stake modestly, a shrinking few go
  // big — rather than picking uniformly across the chip values.
  const NPC_AMOUNT_WEIGHTS = [
    [5, 18], [10, 22], [15, 16], [20, 14], [25, 12], [50, 9], [75, 5], [100, 4],
  ];
  function weightedNpcAmount(rng) {
    const total = NPC_AMOUNT_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
    let roll = rng() * total;
    for (const [amount, w] of NPC_AMOUNT_WEIGHTS) {
      roll -= w;
      if (roll <= 0) return amount;
    }
    return NPC_AMOUNT_WEIGHTS[0][0];
  }

  // Each NPC's target cashout is its own independent heavy-tailed draw —
  // most players are cautious (1.0x-2x), a shrinking few ride further
  // (2x-6x), and a rare high-roller (~4% of players) aims for a genuinely
  // big multiplier. This is unrelated to state.crashPoint; whether any
  // given NPC "makes it" depends purely on whether the round crashes before
  // their target, exactly like a real opponent nobody can predict.
  function planNpcCashout(rng) {
    if (rng() < 0.04) {
      return Math.round((8 + rng() * 32) * 100) / 100; // rare high-roller: 8x-40x
    }
    let planned = 0.98 / (1 - rng() * 0.85);
    planned = Math.max(1.05, Math.min(planned, 9));
    return Math.round(planned * 100) / 100;
  }

  // Fisher-Yates using the round's seeded rng, so slot/colour assignment
  // is deterministic per round like everything else NPC-related.
  function shuffledIndices(count, rng) {
    const arr = Array.from({ length: count }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function generateNpcs() {
    const rng = state._rng;
    const npcMin = FEATURE_FLEET_TABLE ? CONFIG.NPC_MIN_FLEET : CONFIG.NPC_MIN_MVP;
    const npcMax = FEATURE_FLEET_TABLE ? CONFIG.NPC_MAX_FLEET : CONFIG.NPC_MAX_MVP;
    const count = npcMin + Math.floor(rng() * (npcMax - npcMin + 1));
    const usedNames = new Set();
    const npcs = [];

    // Colour/slot assignment only matters when the fleet is actually
    // rendered — still drawn from the round's rng either way so the
    // sequence of subsequent rng calls doesn't shift when the flag flips.
    const colorOrder = shuffledIndices(CONFIG.FLEET_COLORS.length, rng);
    const slotOrder = shuffledIndices(FLEET_SLOTS.length, rng);

    for (let i = 0; i < count; i++) {
      let name;
      do {
        name = CONFIG.NPC_NAMES[Math.floor(rng() * CONFIG.NPC_NAMES.length)];
      } while (usedNames.has(name) && usedNames.size < CONFIG.NPC_NAMES.length);
      usedNames.add(name);

      const amount = weightedNpcAmount(rng);
      const planned = planNpcCashout(rng);
      // Bolder targets are more likely to have needed Overdrive to get there.
      const willOverdrive = rng() < Math.min(0.7, 0.18 + (planned - 1) / 10);

      npcs.push({
        id: `${state.roundId}-${i}`,
        name,
        amount,
        planned,
        willOverdrive,
        status: "waiting", // waiting | cruise | overdrive | crash
        cashedAt: null,
        warpBornAt: null, // set the instant this NPC cashes out, for its own mini warp animation
        color: FEATURE_FLEET_TABLE ? CONFIG.FLEET_COLORS[colorOrder[i % colorOrder.length]] : null,
        slot: FEATURE_FLEET_TABLE ? FLEET_SLOTS[slotOrder[i % slotOrder.length]] : null,
      });
    }
    state.npcs = npcs;
  }

  function updateNpcs(currentMultiplier) {
    let changed = false;
    for (const npc of state.npcs) {
      if (npc.status !== "waiting") continue;
      if (npc.planned >= state.crashPoint) continue; // will crash, resolved on crash
      if (currentMultiplier >= npc.planned) {
        npc.status = npc.willOverdrive ? "overdrive" : "cruise";
        npc.cashedAt = npc.planned;
        npc.warpBornAt = performance.now();
        changed = true;
      }
    }
    if (changed) renderLiveBets();
  }

  function resolveNpcsOnCrash() {
    for (const npc of state.npcs) {
      if (npc.status === "waiting") {
        npc.status = "crash";
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 11. History                                                         */
  /* ------------------------------------------------------------------ */
  function pushHistory(crashPoint) {
    state.history.unshift({
      id: state.roundId,
      crashPoint,
      time: new Date(),
    });
    if (state.history.length > CONFIG.HISTORY_LENGTH) {
      state.history.length = CONFIG.HISTORY_LENGTH;
    }
  }

  function tierFor(multiplier) {
    if (multiplier >= 100) return "extreme";
    if (multiplier >= 10) return "high";
    if (multiplier >= 2) return "mid";
    return "low";
  }

  /* ------------------------------------------------------------------ */
  /* 12. UI rendering                                                    */
  /* ------------------------------------------------------------------ */
  function formatMoney(v) {
    return `$${v.toFixed(2)}`;
  }
  function formatMult(v) {
    return `${v.toFixed(2)}x`;
  }

  // Sparse, discrete-event screen-reader announcements — separate from the
  // multiplier's own aria-live="off" region, which would otherwise spam
  // assistive tech at the digit-roll's ~10/sec update rate.
  function announce(message) {
    if (el.srAnnounce) el.srAnnounce.textContent = message;
  }

  function renderAll() {
    renderBalance();
    renderModeLabel();
    renderMultiplier();
    renderMainButton();
    renderOverdriveButton();
    renderResultBanner();
    renderCountdownVisibility();
    renderLiveBets();
    renderHistory();
    renderBetHint();
    renderLowBalanceBanner();
  }

  function renderBalance() {
    el.balanceValue.textContent = formatMoney(state.balance);
  }

  // Inline "Insufficient balance" hint — only while the player is actually
  // choosing a bet amount, not once one is already placed.
  function renderBetHint() {
    if (!el.betHint) return;
    const amount = clampBetAmount(Number(el.betAmountInput.value));
    const insufficient = state.phase === PHASE.COUNTDOWN && !state.bet && amount > state.balance;
    el.betHint.hidden = !insufficient;
  }

  // Persistent recovery banner once the player genuinely can't afford the
  // minimum bet — separate from the transient per-keystroke hint above.
  function renderLowBalanceBanner() {
    if (!el.lowBalanceBanner) return;
    const outOfFunds = state.balance < CONFIG.MIN_BET && !state.bet;
    el.lowBalanceBanner.hidden = !outOfFunds;
  }

  function renderModeLabel() {
    let label = "CRUISE";
    if (state.phase === PHASE.RESULT) {
      label = state.bet && state.bet.cashedOutAtMultiplier ? "CASHED OUT" : "COLLAPSED";
    } else if (state.mode === MODE.OVERDRIVE) {
      label = "OVERDRIVE";
    }
    el.modeLabel.textContent = label;
  }

  // Odometer-style digit roll: the DOM is only rebuilt every ~90ms (rather
  // than every animation frame) so distinct characters visibly "tick" over
  // like a mechanical counter instead of the text just snapping in place.
  // Phase transitions (round start, cashout, crash) always update instantly.
  let lastDigitStr = "";
  let lastDigitTickAt = 0;
  const DIGIT_TICK_MS = 90;

  function updateDigitSpans(str) {
    const prev = lastDigitStr;
    lastDigitStr = str;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const span = document.createElement("span");
      span.className = "digit";
      span.textContent = ch;
      if (prev[i] !== ch) span.classList.add("tick");
      frag.appendChild(span);
    }
    el.multiplierValue.innerHTML = "";
    el.multiplierValue.appendChild(frag);
  }

  function renderMultiplier() {
    const m = state.currentMultiplier;
    const str = formatMult(m);
    const scale = 1 + Math.min(0.22, Math.log(Math.max(1, m)) * 0.055);
    el.multiplierValue.style.setProperty("--mscale", scale.toFixed(3));

    const now = performance.now();
    const forceUpdate = state.phase !== PHASE.RUNNING;
    if (str !== lastDigitStr && (forceUpdate || now - lastDigitTickAt >= DIGIT_TICK_MS)) {
      updateDigitSpans(str);
      lastDigitTickAt = now;
    }
  }

  function renderCountdown(remainingMs) {
    el.countdownText.textContent = `Next run in ${(remainingMs / 1000).toFixed(1)}s`;
  }

  function renderCountdownVisibility() {
    el.countdownWrap.style.opacity = state.phase === PHASE.COUNTDOWN ? "1" : "0";
  }

  function renderMainButton() {
    const btn = el.mainActionBtn;
    const label = el.mainActionLabel;
    btn.classList.remove("state-cashout", "state-success", "state-crashed");
    btn.disabled = false;

    if (state.phase === PHASE.COUNTDOWN) {
      if (state.bet) {
        label.textContent = "BET PLACED — WAITING";
        btn.disabled = true;
      } else {
        label.textContent = "PLACE BET";
        const amount = clampBetAmount(Number(el.betAmountInput.value));
        btn.disabled = amount > state.balance;
      }
    } else if (state.phase === PHASE.RUNNING) {
      if (!state.bet) {
        label.textContent = "NO ACTIVE BET";
        btn.disabled = true;
      } else if (state.bet.resolved) {
        label.textContent = `CASHED OUT AT ${formatMult(state.bet.cashedOutAtMultiplier)}`;
        btn.classList.add("state-success");
        btn.disabled = true;
      } else {
        const payout = state.bet.amount * state.currentMultiplier;
        label.textContent = `CASH OUT ${formatMoney(payout)}`;
        btn.classList.add("state-cashout");
      }
    } else if (state.phase === PHASE.RESULT) {
      if (state.bet && state.bet.cashedOutAtMultiplier) {
        label.textContent = `CASHED OUT AT ${formatMult(state.bet.cashedOutAtMultiplier)}`;
        btn.classList.add("state-success");
      } else if (state.bet && state.bet.lost) {
        label.textContent = `LOST ${formatMoney(state.bet.amount)}`;
        btn.classList.add("state-crashed");
      } else {
        label.textContent = `COLLAPSED AT ${formatMult(state.crashPoint)}`;
        btn.classList.add("state-crashed");
      }
      btn.disabled = true;
    }
  }

  function renderOverdriveButton() {
    const btn = el.overdriveBtn;
    btn.classList.remove("state-active");

    const canActivate =
      state.phase === PHASE.RUNNING &&
      !state.overdriveActive &&
      state.bet &&
      !state.bet.resolved;

    if (state.overdriveActive && state.phase === PHASE.RUNNING) {
      el.overdriveBtnLabel.textContent = "OVERDRIVE ACTIVE";
      btn.classList.add("state-active");
      btn.disabled = true;
    } else {
      el.overdriveBtnLabel.textContent = "ACTIVATE OVERDRIVE";
      btn.disabled = !canActivate;
    }
  }

  function renderResultBanner() {
    const banner = el.resultBanner;
    if (state.phase !== PHASE.RESULT) {
      banner.hidden = true;
      banner.className = "result-banner";
      return;
    }
    banner.hidden = false;

    if (state.bet && state.bet.cashedOutAtMultiplier) {
      const payout = state.bet.amount * state.bet.cashedOutAtMultiplier;
      banner.className = "result-banner success fade-in";
      banner.innerHTML = `CASHED OUT AT ${formatMult(state.bet.cashedOutAtMultiplier)}<span class="payout-line">+${formatMoney(payout)}</span>`;
    } else if (state.bet && state.bet.lost) {
      banner.className = "result-banner crash fade-in";
      banner.innerHTML = `COLLAPSED AT ${formatMult(state.crashPoint)}<span class="loss-line">LOST ${formatMoney(state.bet.amount)}</span>`;
    } else {
      banner.className = "result-banner crash fade-in";
      banner.innerHTML = `COLLAPSED AT ${formatMult(state.crashPoint)}`;
    }
  }

  // Builds one <li class="bet-row"> via plain DOM calls (createElement /
  // textContent) rather than an innerHTML template string — avoids any
  // possibility of a malformed string breaking the whole list, and each
  // row is independently guarded so one bad entry can't blank the rest.
  // Player's own ship keeps its functional cyan cruise colour for the
  // leaderboard icon too — it's the one ship that never gets an assigned
  // identity colour, since cyan/violet already mean something specific
  // for the player (mode), not "who is this".
  const SELF_SHIP_COLOR = { r: 79, g: 216, b: 255 };

  function buildBetRow(name, amount, tagCls, tagText, isSelf, color) {
    const li = document.createElement("li");
    li.className = isSelf ? "bet-row is-self" : "bet-row";
    if (FEATURE_FLEET_TABLE) li.classList.add("has-icon");

    if (FEATURE_FLEET_TABLE) {
      const icon = document.createElement("span");
      icon.className = "bet-ship-icon";
      icon.setAttribute("aria-hidden", "true");
      const c = color || SELF_SHIP_COLOR;
      icon.style.borderBottomColor = `rgb(${c.r},${c.g},${c.b})`;
      li.appendChild(icon);
    }

    const nameEl = document.createElement("span");
    nameEl.className = "bet-name";
    nameEl.textContent = name;

    const amountEl = document.createElement("span");
    amountEl.className = "bet-amount";
    amountEl.textContent = formatMoney(amount);

    const tagEl = document.createElement("span");
    tagEl.className = `bet-tag ${tagCls}`;
    tagEl.textContent = tagText;

    li.appendChild(nameEl);
    li.appendChild(amountEl);
    li.appendChild(tagEl);
    return li;
  }

  function renderLiveBets() {
    if (!el.liveBetsList) return;

    // Self-healing: a live round should never have zero NPCs. If it
    // somehow does (whatever the cause), regenerate right here rather
    // than leaving the panel empty for the rest of the round.
    if ((state.phase === PHASE.COUNTDOWN || state.phase === PHASE.RUNNING) && state.npcs.length === 0 && state._rng) {
      try {
        generateNpcs();
      } catch (err) {
        console.error("[VECTOR] NPC regeneration failed:", err);
      }
    }

    const frag = document.createDocumentFragment();
    let rowCount = 0;

    try {
      if (state.bet) {
        const tag = state.bet.resolved
          ? state.bet.lost
            ? { cls: "tag-crash", text: "CRASH" }
            : state.bet.mode === MODE.OVERDRIVE
            ? { cls: "tag-overdrive", text: "OVERDRIVE" }
            : { cls: "tag-cruise", text: "CRUISE" }
          : { cls: "tag-waiting", text: state.phase === PHASE.COUNTDOWN ? "PENDING" : "IN FLIGHT" };
        frag.appendChild(buildBetRow("You", state.bet.amount, tag.cls, tag.text, true, SELF_SHIP_COLOR));
        rowCount++;
      }
    } catch (err) {
      console.error("[VECTOR] failed to render own bet row:", err);
    }

    for (const npc of state.npcs) {
      try {
        let tag;
        if (npc.status === "waiting") tag = { cls: "tag-waiting", text: "IN FLIGHT" };
        else if (npc.status === "crash") tag = { cls: "tag-crash", text: "CRASH" };
        else if (npc.status === "overdrive") tag = { cls: "tag-overdrive", text: formatMult(npc.cashedAt) };
        else tag = { cls: "tag-cruise", text: formatMult(npc.cashedAt) };
        frag.appendChild(buildBetRow(npc.name, npc.amount, tag.cls, tag.text, false, npc.color));
        rowCount++;
      } catch (err) {
        console.error("[VECTOR] failed to render NPC row:", npc, err);
      }
    }

    if (rowCount === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "No bets this round yet";
      frag.appendChild(empty);
    }

    while (el.liveBetsList.firstChild) el.liveBetsList.removeChild(el.liveBetsList.firstChild);
    el.liveBetsList.appendChild(frag);
  }

  function renderHistory() {
    if (!state.history.length) {
      el.historyList.innerHTML = `<li class="empty-row">No rounds completed yet</li>`;
      return;
    }
    el.historyList.innerHTML = state.history
      .map((h) => {
        const tier = tierFor(h.crashPoint);
        const time = h.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `<li class="history-row">
          <span class="history-chip tier-${tier}">${formatMult(h.crashPoint)}</span>
          <span class="history-time">${time}</span>
        </li>`;
      })
      .join("");
  }

  function syncChipActiveState() {
    el.chips.forEach((chip) => {
      chip.classList.toggle("active", Number(chip.dataset.amount) === state.betAmount);
    });
  }

  function flashCrash() {
    el.crashFlash.classList.remove("active");
    // force reflow to restart animation
    void el.crashFlash.offsetWidth;
    el.crashFlash.classList.add("active");
  }

  function pulseOverdrive() {
    el.gameStage.classList.remove("pulse");
    void el.gameStage.offsetWidth;
    el.gameStage.classList.add("pulse");
  }

  /* ------------------------------------------------------------------ */
  /* 12b. Sound — procedural, no external assets                         */
  /* ------------------------------------------------------------------ */
  // Every cue is synthesized on the fly with the Web Audio API (oscillators
  // + gain envelopes) rather than loaded from audio files, matching the
  // "no external dependencies" brief. AudioContext is created lazily on
  // first use since browsers block audio before a user gesture; each call
  // is a no-op if sound is off or the API isn't available.
  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    return audioCtx;
  }

  function tone(ctx, { freq, start, duration, type = "sine", gain = 0.18, glideTo = null }) {
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), start + duration);
    gainNode.gain.setValueAtTime(0, start);
    gainNode.gain.linearRampToValueAtTime(gain, start + 0.012);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function noiseBurst(ctx, { start, duration, gain = 0.22 }) {
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize); // decaying noise
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(gain, start);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    src.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ctx.destination);
    src.start(start);
  }

  function playSound(name) {
    if (!state.soundOn) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;

    try {
      if (name === "bet") {
        tone(ctx, { freq: 520, start: t, duration: 0.09, type: "sine", gain: 0.14 });
      } else if (name === "cashout") {
        tone(ctx, { freq: 520, start: t, duration: 0.22, type: "triangle", gain: 0.16, glideTo: 1040 });
        tone(ctx, { freq: 780, start: t + 0.06, duration: 0.22, type: "triangle", gain: 0.12, glideTo: 1300 });
      } else if (name === "overdrive") {
        tone(ctx, { freq: 180, start: t, duration: 0.35, type: "sawtooth", gain: 0.1, glideTo: 420 });
      } else if (name === "crash") {
        noiseBurst(ctx, { start: t, duration: 0.4, gain: 0.24 });
        tone(ctx, { freq: 140, start: t, duration: 0.3, type: "square", gain: 0.1, glideTo: 40 });
      }
    } catch (err) {
      console.error("[VECTOR] sound playback failed:", err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 13. Tunnel / ship canvas animation — chase camera                   */
  /* ------------------------------------------------------------------ */
  // The camera sits behind and slightly above the ship, looking forward
  // into the tunnel. The vanishing point is pushed up-and-away from the
  // ship, which flies in the lower third. A twin-engine contrail trails
  // behind the ship toward the viewer — this is the round's progress
  // signal: it lengthens with elapsed flight time (see computeTrailLength),
  // in the same direction everything else in the scene is moving.
  const ctx = el.canvas.getContext("2d");
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  let cw = 0, ch = 0;

  function resizeCanvas() {
    const rect = el.canvas.getBoundingClientRect();
    cw = rect.width;
    ch = rect.height;
    el.canvas.width = Math.round(cw * dpr);
    el.canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildParticles();
    if (!state.env.starsBuilt) {
      buildStarfield();
      buildDebris();
      state.env.starsBuilt = true;
    }
  }

  function vanishingPoint() {
    return { x: cw / 2, y: ch * 0.32 };
  }
  function shipAnchor() {
    return { x: cw / 2, y: ch * 0.74 };
  }

  function maxRadius() {
    return Math.hypot(cw, ch) * 0.75;
  }

  // Dust particles streaming outward from the vanishing point.
  let particles = [];
  const PARTICLE_COUNT_DESKTOP = 90;
  function buildParticles() {
    const count = prefersReducedMotion ? 24 : PARTICLE_COUNT_DESKTOP;
    particles = [];
    for (let i = 0; i < count; i++) {
      particles.push(spawnParticle(true));
    }
  }
  function spawnParticle(randomizeRadius) {
    return {
      angle: Math.random() * Math.PI * 2,
      r: randomizeRadius ? Math.random() * maxRadius() : 0,
      speed: 40 + Math.random() * 70,
      size: 0.6 + Math.random() * 1.6,
    };
  }

  // ---- Background environment: starfield, nebulae, drifting debris, ------
  // ---- and rare high-multiplier energy-storm flickers. -------------------
  // Kept deliberately restrained — a barely-moving backdrop, not a light
  // show — so it reads as depth and atmosphere rather than clutter.

  function buildStarfield() {
    const count = prefersReducedMotion ? 26 : 50;
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random() * 0.68,
        r: 0.5 + Math.random() * 1.1,
        baseAlpha: 0.2 + Math.random() * 0.45,
        twinkleSpeed: 0.35 + Math.random() * 0.7,
        twinklePhase: Math.random() * Math.PI * 2,
      });
    }

    // A couple of intentional clusters read as tiny constellations rather
    // than pure scatter — same star objects, just seeded close together so
    // faint connecting lines can be drawn between them.
    const constellations = [];
    const clusterCount = prefersReducedMotion ? 1 : 2;
    for (let c = 0; c < clusterCount; c++) {
      const anchorX = 0.1 + Math.random() * 0.8;
      const anchorY = 0.05 + Math.random() * 0.3;
      const clusterStars = [];
      const starCount = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < starCount; i++) {
        const star = {
          x: anchorX + (Math.random() - 0.5) * 0.09,
          y: anchorY + (Math.random() - 0.5) * 0.07,
          r: 0.9 + Math.random() * 0.9,
          baseAlpha: 0.4 + Math.random() * 0.35,
          twinkleSpeed: 0.35 + Math.random() * 0.7,
          twinklePhase: Math.random() * Math.PI * 2,
        };
        stars.push(star);
        clusterStars.push(star);
      }
      constellations.push(clusterStars);
    }

    state.env.stars = stars;
    state.env.constellations = constellations;
  }

  function drawStars(now) {
    for (const s of state.env.stars) {
      const twinkle = prefersReducedMotion ? 1 : 0.75 + Math.sin(now / 1000 * s.twinkleSpeed + s.twinklePhase) * 0.25;
      ctx.fillStyle = `rgba(220,232,240,${(s.baseAlpha * twinkle).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x * cw, s.y * ch, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawConstellations() {
    ctx.strokeStyle = "rgba(180,200,210,0.14)";
    ctx.lineWidth = 0.6;
    for (const cluster of state.env.constellations) {
      ctx.beginPath();
      for (let i = 0; i < cluster.length; i++) {
        const x = cluster[i].x * cw;
        const y = cluster[i].y * ch;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // A single distant light breathing on its own slow cycle, fully
  // decoupled from game speed/state — a calm counterpoint to everything
  // else in the scene, which reacts to the round.
  function drawPulsar(now) {
    const p = state.env.pulsar;
    if (!p) return;
    const x = p.x * cw;
    const y = p.y * ch;
    const cyclePos = prefersReducedMotion ? 0.5 : ((now / 1000) % p.cycleSeconds) / p.cycleSeconds;
    const breathe = prefersReducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(cyclePos * Math.PI * 2 + p.cyclePhase);
    const alpha = 0.15 + breathe * 0.35;
    const r1 = 8 + breathe * 10;
    ctx.strokeStyle = `rgba(255,240,216,${(alpha * 0.5).toFixed(3)})`;
    ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.arc(x, y, r1, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r1 * 0.55, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = `rgba(255,246,232,${alpha.toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, 1.6 + breathe, 0, Math.PI * 2); ctx.fill();
  }

  function drawNebulae(now, palette) {
    for (const n of state.env.nebulae) {
      const drift = prefersReducedMotion ? 0 : now / 1000;
      const x = (n.x + n.driftVx * drift) * cw;
      const y = (n.y + n.driftVy * drift) * ch;
      const r = n.r * Math.max(cw, ch);
      const tint = n.hueTilt > 0 ? { r: 180, g: 107, b: 255 } : palette;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${tint.r},${tint.g},${tint.b},0.07)`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function buildDebris() {
    const count = prefersReducedMotion ? 1 : 3;
    const debris = [];
    for (let i = 0; i < count; i++) debris.push(spawnDebris(true));
    state.env.debris = debris;
  }
  function spawnDebris(randomizeX) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    return {
      x: randomizeX ? Math.random() * cw : dir < 0 ? cw + 30 : -30,
      y: Math.random() * ch * 0.55,
      vx: -dir * (3 + Math.random() * 5),
      size: 5 + Math.random() * 9,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.15,
    };
  }
  function drawDebris(dt) {
    for (const d of state.env.debris) {
      d.x += d.vx * dt * (prefersReducedMotion ? 0.2 : 1);
      d.rot += d.rotSpeed * dt;
      if (d.x < -40 || d.x > cw + 40) Object.assign(d, spawnDebris(false));
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      ctx.fillStyle = "rgba(18,22,28,0.8)";
      ctx.strokeStyle = "rgba(120,140,155,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-d.size, 0);
      ctx.lineTo(-d.size * 0.3, -d.size * 0.6);
      ctx.lineTo(d.size * 0.7, -d.size * 0.25);
      ctx.lineTo(d.size * 0.5, d.size * 0.5);
      ctx.lineTo(-d.size * 0.4, d.size * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Energy storms: rare jagged flickers in the tunnel walls once the
  // multiplier climbs past the threshold, growing slightly more frequent
  // and intense the higher it goes. One at a time, ~200ms each.
  function updateStorm(now) {
    const env = state.env;
    if (env.storm && now - env.storm.bornAt > 220) env.storm = null;

    if (
      state.phase === PHASE.RUNNING &&
      state.currentMultiplier >= CONFIG.STORM_THRESHOLD_MULTIPLIER &&
      !env.storm &&
      now >= env.nextStormAt &&
      !prefersReducedMotion
    ) {
      const intensity = Math.min(1, (state.currentMultiplier - CONFIG.STORM_THRESHOLD_MULTIPLIER) / 90);
      env.storm = {
        bornAt: now,
        angle: Math.random() * Math.PI * 2,
        len: 40 + Math.random() * 50 + intensity * 40,
        jags: [(Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18],
      };
      const cooldown = Math.max(1100, 3200 - intensity * 2000);
      env.nextStormAt = now + cooldown + Math.random() * 900;
    } else if (state.phase !== PHASE.RUNNING) {
      env.storm = null;
    }
  }

  function drawStorm(vp, now, palette) {
    const storm = state.env.storm;
    if (!storm) return;
    const age = now - storm.bornAt;
    const alpha = Math.max(0, 1 - age / 220);
    if (alpha <= 0) return;

    const segLen = storm.len / 3;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle =
        pass === 0
          ? `rgba(255,255,255,${(alpha * 0.5).toFixed(3)})`
          : `rgba(${palette.r},${palette.g},${palette.b},${(alpha * 0.3).toFixed(3)})`;
      ctx.lineWidth = pass === 0 ? 1.3 : 3;
      ctx.beginPath();
      let x = vp.x + Math.cos(storm.angle) * 40;
      let y = vp.y + Math.sin(storm.angle) * 40 * 0.62;
      ctx.moveTo(x, y);
      for (let j = 0; j < 3; j++) {
        x += Math.cos(storm.angle) * segLen;
        y += Math.sin(storm.angle) * segLen * 0.62 + storm.jags[j] * 0.3;
        ctx.lineTo(x + storm.jags[j] * 0.4, y);
      }
      ctx.stroke();
    }
  }

  function drawEnvironment(now, palette, vp, dt) {
    drawStars(now);
    drawConstellations();
    drawPulsar(now);
    drawNebulae(now, palette);
    drawDebris(dt);
    updateStorm(now);
    drawStorm(vp, now, palette);
  }

  let lastFrameTime = performance.now();

  function currentSpeedFactor() {
    // Baseline idle drift, rising with mode & multiplier for perceived speed.
    // Deliberately uncapped (log growth self-limits the rate of increase,
    // but there's no hard plateau) so the tunnel keeps visibly accelerating
    // all the way through high multipliers instead of feeling the same
    // from 10x to 100x.
    if (state.phase === PHASE.RUNNING) {
      // Cruise speed eases in over the first couple of seconds rather than
      // snapping straight to full speed the instant the round launches.
      // Overdrive's kick stays instant — that abruptness is the point.
      const elapsed = state.roundStartTime != null ? (performance.now() - state.roundStartTime) / 1000 : 0;
      const rampIn = Math.min(1, elapsed / CONFIG.SPEED_RAMP_SECONDS);
      const cruiseBase = 0.5 + 0.5 * rampIn;
      const base = state.overdriveActive ? 2.6 : cruiseBase;
      const growth = Math.log(Math.max(1, state.currentMultiplier)) * 0.42;
      return base + growth;
    }
    if (state.phase === PHASE.RESULT) return 0.15;
    return 0.35; // countdown idle drift
  }

  function currentPalette() {
    if (state.phase === PHASE.RESULT) {
      if (state.bet && state.bet.cashedOutAtMultiplier && !state.bet.lost) {
        return { r: 186, g: 255, b: 107 }; // success green
      }
      return { r: 255, g: 84, b: 104 }; // crash red
    }
    if (state.overdriveActive) return { r: 200, g: 90, b: 255 }; // violet/magenta
    return { r: 79, g: 216, b: 255 }; // cyan
  }

  // A single rise-and-fall pulse across the cashout warp's duration (0 at
  // both ends, peaking mid-flight) — used to drive a one-shot camera punch
  // and a temporary streak boost on the ambient dust. Unlike the old
  // repeating punch-zoom (removed for feeling too aggressive during normal
  // flight), this only ever fires once, on a rewarding moment, then is gone.
  function cashoutWarpCurve(now) {
    if (!state.cashoutWarp || prefersReducedMotion) return 0;
    const age = now - state.cashoutWarp.bornAt;
    if (age >= CONFIG.CASHOUT_WARP_MS) return 0;
    const p = age / CONFIG.CASHOUT_WARP_MS;
    return Math.sin(Math.min(1, p) * Math.PI);
  }

  // Contrail length: live while running (mirrors the multiplier's
  // piecewise cruise/overdrive growth), frozen at the value captured the
  // instant the round crashed, or a small idle length before launch.
  function trailLenFor(now) {
    if (state.phase === PHASE.RUNNING) return computeTrailLength(now);
    if (state.phase === PHASE.RESULT) {
      return state.trailFrozenLen != null ? state.trailFrozenLen : CONFIG.TRAIL_BASE_LEN;
    }
    return CONFIG.TRAIL_BASE_LEN;
  }

  function drawTunnel(now) {
    if (!cw || !ch) return;
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const speed = currentSpeedFactor();
    const palette = currentPalette();
    const vp = vanishingPoint();
    const ship = shipAnchor();

    ctx.clearRect(0, 0, cw, ch);
    drawEnvironment(now, palette, vp, dt);

    // One-shot camera punch on cashout only — zero the rest of the time.
    // This is deliberately strong: it's the main signal that the ship is
    // rocketing forward, away from camera, rather than the ship's own
    // on-screen motion (which stays minimal — see drawCashoutWarp).
    const warpCurve = cashoutWarpCurve(now);
    const cameraZoom = 1 + warpCurve * 0.34;
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(cameraZoom, cameraZoom);
    ctx.translate(-cw / 2, -ch / 2);

    // ambient colour wash, spanning from the vanishing point down toward
    // the ship so both ends of the scene pick up ambient colour
    const glowCy = vp.y + (ship.y - vp.y) * 0.45;
    const grad = ctx.createRadialGradient(vp.x, glowCy, 0, vp.x, glowCy, Math.max(cw, ch) * 0.75);
    grad.addColorStop(0, `rgba(${palette.r},${palette.g},${palette.b},0.10)`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);

    // spokes (static-ish, slow rotation for depth cue)
    const spokeCount = 28;
    const rot = (now / 1000) * 0.03;
    ctx.lineWidth = 1;
    for (let i = 0; i < spokeCount; i++) {
      const a = (i / spokeCount) * Math.PI * 2 + rot;
      const x1 = vp.x + Math.cos(a) * 26;
      const y1 = vp.y + Math.sin(a) * 26;
      const x2 = vp.x + Math.cos(a) * maxRadius();
      const y2 = vp.y + Math.sin(a) * maxRadius();
      ctx.strokeStyle = `rgba(${palette.r},${palette.g},${palette.b},0.05)`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // dust particles streaming outward from the vanishing point, rendered
    // as short direction-aligned streaks rather than dots — the streak
    // length itself grows with speed, which is the strongest "warp" cue.
    ctx.lineCap = "round";
    for (const p of particles) {
      p.r += p.speed * speed * dt * (prefersReducedMotion ? 0.3 : 1);
      if (p.r > maxRadius()) {
        Object.assign(p, spawnParticle(false));
      }
      const x = vp.x + Math.cos(p.angle) * p.r;
      const y = vp.y + Math.sin(p.angle) * p.r * 0.62;
      const alpha = Math.min(1, p.r / (maxRadius() * 0.3));
      if (prefersReducedMotion) {
        ctx.fillStyle = `rgba(${palette.r},${palette.g},${palette.b},${(alpha * 0.85).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const streakLen = Math.min(28 + warpCurve * 110, 5 + p.speed * speed * 0.05 + warpCurve * 110);
        const br = Math.max(0, p.r - streakLen);
        const bx = vp.x + Math.cos(p.angle) * br;
        const by = vp.y + Math.sin(p.angle) * br * 0.62;
        ctx.strokeStyle = `rgba(${palette.r},${palette.g},${palette.b},${(alpha * 0.9).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, p.size);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    drawFleet(now, ship);
    drawShip(ship.x, ship.y, now, palette, speed);
    drawCashoutTrailScar(now);

    // The round itself always ends in a crash (cashouts merely exit before
    // it happens), so the fracture/collapse visual always plays once the
    // result phase begins — independent of whether this player cashed out.
    if (state.phase === PHASE.RESULT) {
      drawFracture(ship.x, ship.y, now, palette);
    }

    ctx.restore(); // end camera-punch transform

    drawVignette(speed);
  }

  // Tightening vignette: edges darken and the lit centre shrinks as speed
  // rises, narrowing focus forward — independent of the ambient colour wash
  // above, which brightens rather than darkens.
  function drawVignette(speed) {
    const norm = Math.min(1, speed / 4.2);
    const outerR = Math.hypot(cw, ch) * 0.62;
    const innerR = Math.max(20, outerR * (0.62 - norm * 0.24));
    const vgrad = ctx.createRadialGradient(cw / 2, ch / 2, innerR, cw / 2, ch / 2, outerR);
    vgrad.addColorStop(0, "rgba(0,0,0,0)");
    vgrad.addColorStop(1, `rgba(0,0,0,${(0.26 + norm * 0.3).toFixed(3)})`);
    ctx.fillStyle = vgrad;
    ctx.fillRect(0, 0, cw, ch);
  }

  function drawContrail(shipX, shipY, len, palette, alpha) {
    const engineOffsets = [-19, 19];
    for (const ex of engineOffsets) {
      const startX = shipX + ex;
      const startY = shipY + 22;
      const flare = ex > 0 ? 1 : -1;
      const growth = len / CONFIG.TRAIL_MAX_LEN;
      const endX = startX + flare * 12 * growth;
      const endY = Math.min(ch - 4, startY + len);
      const midX = startX + flare * 5 * growth;
      const midY = startY + (endY - startY) * 0.5;

      const grad = ctx.createLinearGradient(startX, startY, endX, endY);
      grad.addColorStop(0, `rgba(${palette.r},${palette.g},${palette.b},${(0.85 * alpha).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${palette.r},${palette.g},${palette.b},0)`);

      // soft outer glow pass
      ctx.strokeStyle = grad;
      ctx.lineCap = "round";
      ctx.lineWidth = 6;
      ctx.globalAlpha = 0.22 * alpha;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(midX, midY, endX, endY);
      ctx.stroke();

      // crisp core pass
      ctx.lineWidth = 1.8;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(midX, midY, endX, endY);
      ctx.stroke();

      // Overdrive instability: a small spark fork breaking off the trail
      if (state.overdriveActive && len > 55) {
        const forkT = 0.76;
        const fx = startX + (endX - startX) * forkT;
        const fy = startY + (endY - startY) * forkT;
        ctx.globalAlpha = 0.55 * alpha;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx + flare * 13, fy + 9);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- Fleet: the other 3-5 ships at the table -------------------------
  // Cheap, "impressionistic" mini-ships — a flat-filled hull tinted with
  // the NPC's own identity colour, no gradient/specular/shadow work like
  // the hero gets. They sit in the same chase-camera depth band as the
  // player (nose away from camera), just smaller and offset around them,
  // so the scene reads as one fleet flying together rather than the hero
  // plus a separate background element.

  // Rotates a local-space offset (dx, dy) by `rotation` and places it at
  // world-space (baseX, baseY) — used to keep engine glows/flares locked
  // to a rotated ship's own axes instead of drifting off at a fixed
  // world-space offset while the hull banks underneath them.
  function rotatedOffset(baseX, baseY, dx, dy, rotation) {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return { x: baseX + dx * cos - dy * sin, y: baseY + dx * sin + dy * cos };
  }

  function drawFleetShip(x, y, scale, alpha, color, rotation) {
    if (alpha <= 0 || scale <= 0.02) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    ctx.scale(scale, scale);

    ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},0.32)`;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-9, 19); ctx.lineTo(-9, 33); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9, 19); ctx.lineTo(9, 33); ctx.stroke();

    ctx.shadowColor = `rgba(${color.r},${color.g},${color.b},0.75)`;
    ctx.shadowBlur = 9;
    ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},0.92)`;
    ctx.beginPath();
    ctx.moveTo(0, -34);
    ctx.lineTo(38, 24);
    ctx.lineTo(26, 32);
    ctx.lineTo(9, 19);
    ctx.lineTo(-9, 19);
    ctx.lineTo(-26, 32);
    ctx.lineTo(-38, 24);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath(); ctx.arc(-19, 25, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(19, 25, 2.6, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  // A smaller, colour-tinted echo of the player's own cashout warp —
  // same charge/jump/flare structure and the same CONFIG.CASHOUT_WARP_MS
  // duration, so every ship's departure reads as the same "move" at a
  // consistent cadence, just in that ship's own identity colour instead
  // of the universal success gold-green.
  function drawFleetWarp(x, y, scaleBase, color, warpAge, rotation) {
    const p = Math.min(1, warpAge / CONFIG.CASHOUT_WARP_MS);
    const CHARGE_END = 0.28;
    const JUMP_END = 0.72;
    const chargeP = Math.min(1, p / CHARGE_END);
    const jumpP = Math.min(1, Math.max(0, (p - CHARGE_END) / (JUMP_END - CHARGE_END)));
    const jumpEased = jumpP * jumpP * (3 - 2 * jumpP);
    const flashP = Math.min(1, Math.max(0, (p - JUMP_END) / (1 - JUMP_END)));

    // Forward nudge follows the ship's own rotated "up" axis, not
    // world-space up, so it moves in the direction it's actually facing.
    const nudge = jumpEased * 14 * scaleBase;
    const nose = rotatedOffset(x, y, 0, -nudge, rotation);
    const xx = nose.x;
    const yy = nose.y;

    const scale = scaleBase * Math.max(0, 1 - jumpEased);
    const bodyAlpha = Math.max(0, 1 - Math.pow(jumpP, 1.4));
    const exhaustGrow = p < CHARGE_END ? chargeP : Math.max(0, 1 - jumpP * 1.8);

    if (exhaustGrow > 0.02) {
      const r = (3 + exhaustGrow * 8) * scaleBase;
      const eL = rotatedOffset(x, y, -9 * scaleBase, 19 * scaleBase, rotation);
      const eR = rotatedOffset(x, y, 9 * scaleBase, 19 * scaleBase, rotation);
      ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${(exhaustGrow * 0.5).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(eL.x, eL.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(eR.x, eR.y, r, 0, Math.PI * 2); ctx.fill();
    }

    if (bodyAlpha > 0.03 && scale > 0.02) drawFleetShip(xx, yy, scale, bodyAlpha, color, rotation);

    if (flashP > 0.02) {
      const flashAlpha = Math.max(0, flashP < 0.5 ? flashP / 0.5 : 1 - (flashP - 0.5) / 0.5);
      const len = (6 + flashP * 24) * scaleBase;
      const p1 = rotatedOffset(xx, yy, 0, -len, rotation);
      const p2 = rotatedOffset(xx, yy, 0, len, rotation);
      const g = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
      g.addColorStop(0, `rgba(${color.r},${color.g},${color.b},0)`);
      g.addColorStop(0.5, `rgba(255,255,238,${(flashAlpha * 0.9).toFixed(3)})`);
      g.addColorStop(1, `rgba(${color.r},${color.g},${color.b},0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  function drawFleet(now, ship) {
    if (!FEATURE_FLEET_TABLE) return;
    const vp = vanishingPoint();
    for (const npc of state.npcs) {
      if (!npc.slot || !npc.color) continue;
      const x = ship.x + npc.slot.dxFrac * cw;
      const y = ship.y + npc.slot.dyFrac * ch;
      // Bank toward the vanishing point — the same geometry that makes the
      // spokes/rings converge applies to every ship's own facing, not just
      // the centred hero (whose angle to vp happens to be perfectly
      // vertical, so this is a no-op for it).
      const rotation = Math.atan2(vp.y - y, vp.x - x) + Math.PI / 2;
      const bob = prefersReducedMotion ? 0 : Math.sin(now / 560 + npc.slot.dxFrac * 10) * 2 * npc.slot.scale;

      if (npc.status === "waiting") {
        drawFleetShip(x, y + bob, npc.slot.scale, 1, npc.color, rotation);
      } else if ((npc.status === "cruise" || npc.status === "overdrive") && npc.warpBornAt != null) {
        const warpAge = now - npc.warpBornAt;
        if (warpAge < CONFIG.CASHOUT_WARP_MS) {
          drawFleetWarp(x, y + bob, npc.slot.scale, npc.color, warpAge, rotation);
        }
        // else: this ship has fully departed — draw nothing further
      } else if (npc.status === "crash" && state.phase === PHASE.RESULT) {
        const resultElapsed = now - (state.resultEndTime - CONFIG.RESULT_DISPLAY_SECONDS * 1000);
        const fadeP = Math.min(1, resultElapsed / 500);
        const alpha = 1 - fadeP;
        const scale = npc.slot.scale * (1 - fadeP * 0.4);
        if (alpha > 0.03) drawFleetShip(x, y + bob, scale, alpha, npc.color, rotation);
      }
    }
  }

  function drawShip(baseX, baseY, now, palette, speed) {
    // Successful cashout departs on its own short-lived animation, entirely
    // separate from the normal idle/cruise/overdrive/crash rendering below.
    if (state.cashoutWarp) {
      const warpAge = now - state.cashoutWarp.bornAt;
      if (warpAge >= CONFIG.CASHOUT_WARP_MS) {
        if (state.cashoutTrail && state.cashoutTrail.bornAt === null) {
          state.cashoutTrail.bornAt = now; // afterimage starts fading from here
        }
        return; // ship has fully departed
      }
      drawCashoutWarp(baseX, baseY, warpAge);
      return;
    }

    const resultElapsed = state.phase === PHASE.RESULT ? now - (state.resultEndTime - CONFIG.RESULT_DISPLAY_SECONDS * 1000) : 0;
    const crashing = state.phase === PHASE.RESULT;

    // fade / shrink ship out on crash
    let shipAlpha = 1;
    let shipScale = 1;
    if (crashing) {
      const p = Math.min(1, resultElapsed / 500);
      shipAlpha = 1 - p;
      shipScale = 1 - p * 0.35;
    }

    const bob = prefersReducedMotion ? 0 : Math.sin(now / 520) * 3;
    const roll = prefersReducedMotion ? 0 : Math.sin(now / 900) * 0.03;
    const jitter = state.overdriveActive && !prefersReducedMotion ? Math.sin(now / 60) * 1.2 : 0;
    const x = baseX + jitter;
    const y = baseY + bob;

    const trailLen = trailLenFor(now);
    if (shipAlpha > 0) drawContrail(x, y, trailLen, palette, shipAlpha);
    if (shipAlpha <= 0) return;

    ctx.save();
    ctx.globalAlpha = shipAlpha;
    ctx.translate(x, y);
    ctx.rotate(roll);
    ctx.scale(shipScale, shipScale);

    // engine glows, drawn beneath the hull. A slow "breathing" pulse keeps
    // them visibly alive even at idle (countdown), not just under thrust.
    const breathe = prefersReducedMotion ? 1 : 1 + Math.sin(now / 650) * 0.22;
    const glowR = (6 + speed * 1.1) * breathe;
    const glowAlpha = Math.min(1, 0.35 * (0.82 + (breathe - 1) * 0.7));
    ctx.fillStyle = `rgba(${palette.r},${palette.g},${palette.b},${glowAlpha.toFixed(3)})`;
    ctx.beginPath(); ctx.arc(-19, 25, glowR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(19, 25, glowR, 0, Math.PI * 2); ctx.fill();

    // hull — delta wing seen from behind, nose pointed toward the
    // vanishing point (up-screen, away from camera)
    const hullPath = new Path2D();
    hullPath.moveTo(0, -34);
    hullPath.lineTo(38, 24);
    hullPath.lineTo(26, 32);
    hullPath.lineTo(9, 19);
    hullPath.lineTo(-9, 19);
    hullPath.lineTo(-26, 32);
    hullPath.lineTo(-38, 24);
    hullPath.closePath();

    ctx.shadowColor = `rgba(${palette.r},${palette.g},${palette.b},0.85)`;
    ctx.shadowBlur = 18;
    const bodyGrad = ctx.createLinearGradient(0, -34, 0, 32);
    bodyGrad.addColorStop(0, `rgba(${palette.r},${palette.g},${palette.b},1)`);
    bodyGrad.addColorStop(0.55, "#e9edf3");
    bodyGrad.addColorStop(1, "#11151c");
    ctx.fillStyle = bodyGrad;
    ctx.fill(hullPath);
    ctx.shadowBlur = 0;

    // specular sweep — a soft light band glides across the hull on a loop,
    // clipped to the hull silhouette, reinforcing the glass/metal surface
    if (!prefersReducedMotion) {
      ctx.save();
      ctx.clip(hullPath);
      const sweepT = (now % 2600) / 2600;
      const sweepX = -70 + sweepT * 140;
      const sweepGrad = ctx.createLinearGradient(sweepX - 14, -34, sweepX + 14, 32);
      sweepGrad.addColorStop(0, "rgba(255,255,255,0)");
      sweepGrad.addColorStop(0.5, "rgba(255,255,255,0.32)");
      sweepGrad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sweepGrad;
      ctx.fillRect(-40, -36, 80, 72);
      ctx.restore();
    }

    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.ellipse(0, -4, 3.2, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(-19, 25, 2.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(19, 25, 2.3, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  // Cashout departure, kept deliberately simple: (1) charge — engines
  // visibly grow bigger and brighter while the ship holds, (2) jump — the
  // ship just shrinks and fades where it is, with only a small forward
  // nudge, while a strong camera zoom (see cashoutWarpCurve in drawTunnel)
  // and the ambient dust streaks (boosted by the same curve) do the work
  // of selling "rocketing forward, away from camera", (3) one clean bloom
  // as it's gone. No rotation, no stretch, no radial firework — the
  // simplicity is the point. Always the success palette, never white/red,
  // so it can't be confused with the crash.
  function drawCashoutWarp(baseX, baseY, warpAge) {
    const p = Math.min(1, warpAge / CONFIG.CASHOUT_WARP_MS);

    if (prefersReducedMotion) {
      const fade = Math.max(0, 1 - p);
      if (fade <= 0) return;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(baseX, baseY);
      ctx.shadowColor = "rgba(186,255,107,0.85)";
      ctx.shadowBlur = 16;
      ctx.fillStyle = "rgba(226,255,214,0.95)";
      ctx.beginPath();
      ctx.moveTo(0, -34);
      ctx.lineTo(38, 24); ctx.lineTo(26, 32); ctx.lineTo(9, 19);
      ctx.lineTo(-9, 19); ctx.lineTo(-26, 32); ctx.lineTo(-38, 24);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }

    const CHARGE_END = 0.28;
    const JUMP_END = 0.72;
    const chargeP = Math.min(1, p / CHARGE_END);
    const jumpP = Math.min(1, Math.max(0, (p - CHARGE_END) / (JUMP_END - CHARGE_END)));
    const jumpEased = jumpP * jumpP * (3 - 2 * jumpP); // smoothstep
    const flashP = Math.min(1, Math.max(0, (p - JUMP_END) / (1 - JUMP_END)));

    const x = baseX;
    const y = baseY - jumpEased * 26; // small forward nudge only
    const scale = Math.max(0, 1 - jumpEased);
    const bodyAlpha = Math.max(0, 1 - Math.pow(jumpP, 1.4));

    // Exhaust grows visibly bigger and brighter through the charge, then
    // cuts off quickly once the jump actually begins — engines flaring
    // is the "prepares to jump" beat, but they shouldn't still be glowing
    // once the ship is most of the way through launching.
    const exhaustGrow = p < CHARGE_END ? chargeP : Math.max(0, 1 - jumpP * 1.8);
    if (exhaustGrow > 0.02) {
      const glowR = 6 + exhaustGrow * 16;
      ctx.fillStyle = `rgba(226,255,214,${(exhaustGrow * 0.55).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(baseX - 19, baseY + 25, glowR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(baseX + 19, baseY + 25, glowR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${(exhaustGrow * 0.8).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(baseX - 19, baseY + 25, glowR * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(baseX + 19, baseY + 25, glowR * 0.4, 0, Math.PI * 2); ctx.fill();
    }

    // Ship — plain uniform shrink and fade, no rotation or stretch.
    if (bodyAlpha > 0.03 && scale > 0.04) {
      ctx.save();
      ctx.globalAlpha = bodyAlpha;
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.shadowColor = "rgba(186,255,107,0.85)";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "rgba(226,255,214,0.95)";
      ctx.beginPath();
      ctx.moveTo(0, -34);
      ctx.lineTo(38, 24);
      ctx.lineTo(26, 32);
      ctx.lineTo(9, 19);
      ctx.lineTo(-9, 19);
      ctx.lineTo(-26, 32);
      ctx.lineTo(-38, 24);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Lens-flare streak as it vanishes — an anisotropic sliver (a tall
    // thin gradient line plus a faint horizontal cross-accent) rather than
    // a circular bloom, so it never competes with the round engine glow
    // above it and doesn't read as another "circle appearing".
    if (flashP > 0.02) {
      const flashAlpha = Math.max(0, flashP < 0.5 ? flashP / 0.5 : 1 - (flashP - 0.5) / 0.5);
      const len = 10 + flashP * 70;

      const vGrad = ctx.createLinearGradient(x, y - len, x, y + len);
      vGrad.addColorStop(0, "rgba(219,255,171,0)");
      vGrad.addColorStop(0.5, `rgba(255,255,238,${(flashAlpha * 0.95).toFixed(3)})`);
      vGrad.addColorStop(1, "rgba(219,255,171,0)");
      ctx.strokeStyle = vGrad;
      ctx.lineWidth = 2 + flashP * 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, y - len);
      ctx.lineTo(x, y + len);
      ctx.stroke();

      const hLen = len * 0.5;
      const hGrad = ctx.createLinearGradient(x - hLen, y, x + hLen, y);
      hGrad.addColorStop(0, "rgba(219,255,171,0)");
      hGrad.addColorStop(0.5, `rgba(255,255,238,${(flashAlpha * 0.55).toFixed(3)})`);
      hGrad.addColorStop(1, "rgba(219,255,171,0)");
      ctx.strokeStyle = hGrad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x - hLen, y);
      ctx.lineTo(x + hLen, y);
      ctx.stroke();
    }
  }

  // The afterimage left hanging once the ship has fully departed — a
  // straight light-scar along the exact path it warped through, slowly
  // fading over CONFIG.CASHOUT_TRAIL_FADE_MS. Purely decorative; cleared
  // once fully faded (or at the next round).
  function drawCashoutTrailScar(now) {
    const trail = state.cashoutTrail;
    if (!trail || trail.bornAt === null) return;
    const age = now - trail.bornAt;
    if (age > CONFIG.CASHOUT_TRAIL_FADE_MS) {
      state.cashoutTrail = null;
      return;
    }
    const alpha = Math.max(0, 1 - age / CONFIG.CASHOUT_TRAIL_FADE_MS);
    const grad = ctx.createLinearGradient(trail.x1, trail.y1, trail.x2, trail.y2);
    grad.addColorStop(0, `rgba(186,255,107,${(alpha * 0.55).toFixed(3)})`);
    grad.addColorStop(0.5, `rgba(210,255,150,${(alpha * 0.3).toFixed(3)})`);
    grad.addColorStop(1, "rgba(255,215,94,0)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(trail.x1, trail.y1);
    ctx.lineTo(trail.x2, trail.y2);
    ctx.stroke();
  }

  function drawFracture(cx, cy, now, palette) {
    const startedAt = state.resultEndTime - CONFIG.RESULT_DISPLAY_SECONDS * 1000;
    const elapsed = now - startedAt;
    if (elapsed > 700) return;
    const alpha = Math.max(0, 1 - elapsed / 700);
    ctx.strokeStyle = `rgba(255,255,255,${(alpha * 0.5).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    const spikes = 9;
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * Math.PI * 2 + i;
      const len = 40 + Math.sin(i * 12.9) * 40 + elapsed * 0.3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      let x = cx, y = cy;
      for (let j = 0; j < 3; j++) {
        const jag = (Math.sin((i + j) * 7.3) * 14);
        x += Math.cos(a) * (len / 3) + jag;
        y += Math.sin(a) * (len / 3) * 0.62 + jag * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(255,84,104,${(alpha * 0.4).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 60 + elapsed * 0.4, 40 + elapsed * 0.25, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ */
  /* 14. Input wiring                                                    */
  /* ------------------------------------------------------------------ */
  function wireInputs() {
    window.addEventListener("resize", resizeCanvas);

    el.betAmountInput.addEventListener("input", () => {
      const raw = Number(el.betAmountInput.value);
      state.betAmount = isNaN(raw) ? state.betAmount : raw;
      syncChipActiveState();
      renderMainButton();
      renderBetHint();
    });
    el.betAmountInput.addEventListener("blur", () => setBetAmount(Number(el.betAmountInput.value)));

    el.betDecrease.addEventListener("click", () => setBetAmount(state.betAmount - 5));
    el.betIncrease.addEventListener("click", () => setBetAmount(state.betAmount + 5));

    el.chips.forEach((chip) => {
      chip.addEventListener("click", () => setBetAmount(Number(chip.dataset.amount)));
    });

    el.autoCashoutToggle.addEventListener("click", () => {
      state.autoCashoutEnabled = !state.autoCashoutEnabled;
      el.autoCashoutToggle.setAttribute("aria-checked", String(state.autoCashoutEnabled));
      el.autoCashoutValue.disabled = !state.autoCashoutEnabled;
    });
    el.autoCashoutValue.addEventListener("input", () => {
      let v = Number(el.autoCashoutValue.value);
      if (isNaN(v)) return;
      // Sanity ceiling — matches the same cap the crash curve itself uses,
      // so there's no way to set an auto-cashout target that could never
      // possibly trigger.
      v = Math.min(v, CONFIG.MAX_VISIBLE_MULTIPLIER);
      if (v >= 1.01) state.autoCashoutValue = v;
    });

    // Low-balance recovery (inline banner) and Settings panel's reset both
    // call the same function.
    el.lowBalanceReset.addEventListener("click", resetBalance);
    el.resetBalanceBtn.addEventListener("click", resetBalance);

    el.reduceMotionToggle.addEventListener("click", () => {
      prefersReducedMotion = !prefersReducedMotion;
      el.reduceMotionToggle.setAttribute("aria-checked", String(prefersReducedMotion));
      // Particle/star counts are sized once at build time based on this
      // flag, so rebuild them immediately rather than waiting for a resize.
      buildParticles();
      buildStarfield();
      buildDebris();
    });

    // Settings popover
    el.settingsBtn.addEventListener("click", () => {
      const willOpen = el.settingsPopover.hidden;
      el.settingsPopover.hidden = !willOpen;
      el.settingsBtn.setAttribute("aria-expanded", String(willOpen));
    });
    document.addEventListener("click", (e) => {
      if (!el.settingsPopover.hidden && !el.settingsBtn.contains(e.target) && !el.settingsPopover.contains(e.target)) {
        el.settingsPopover.hidden = true;
        el.settingsBtn.setAttribute("aria-expanded", "false");
      }
    });

    // How-to-play modal
    el.howToPlayBtn.addEventListener("click", showHowToPlay);
    el.howToPlayClose.addEventListener("click", hideHowToPlay);
    el.howToPlayOverlay.addEventListener("click", (e) => {
      if (e.target === el.howToPlayOverlay) hideHowToPlay();
    });

    el.mainActionBtn.addEventListener("click", () => {
      if (state.phase === PHASE.COUNTDOWN && !state.bet) placeBet();
      else if (state.phase === PHASE.RUNNING && state.bet && !state.bet.resolved) cashOut();
    });
    el.overdriveBtn.addEventListener("click", activateOverdrive);

    // Keyboard shortcuts (layered on top of native tab/enter/space support).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!el.howToPlayOverlay.hidden) hideHowToPlay();
        if (!el.settingsPopover.hidden) {
          el.settingsPopover.hidden = true;
          el.settingsBtn.setAttribute("aria-expanded", "false");
        }
        if (!el.fairPopover.hidden) {
          el.fairPopover.hidden = true;
          el.fairBadge.setAttribute("aria-expanded", "false");
        }
        return;
      }
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        el.mainActionBtn.click();
      } else if (e.key.toLowerCase() === "o") {
        el.overdriveBtn.click();
      }
    });

    // Provably fair popover
    el.fairBadge.addEventListener("click", () => {
      const willOpen = el.fairPopover.hidden;
      el.fairPopover.hidden = !willOpen;
      el.fairBadge.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        el.fairRound.textContent = `#${state.roundId}`;
        el.fairSeed.textContent = state.seedHash || "—";
        el.fairResult.textContent =
          state.phase === PHASE.RESULT ? formatMult(state.crashPoint) : "Pending — locked in";
      }
    });
    document.addEventListener("click", (e) => {
      if (!el.fairPopover.hidden && !el.fairBadge.contains(e.target) && !el.fairPopover.contains(e.target)) {
        el.fairPopover.hidden = true;
        el.fairBadge.setAttribute("aria-expanded", "false");
      }
    });

    el.soundToggle.addEventListener("click", () => {
      state.soundOn = !state.soundOn;
      el.soundToggle.setAttribute("aria-pressed", String(state.soundOn));
      el.soundToggle.style.color = state.soundOn ? "var(--cruise-1)" : "";
    });

    // Tabs
    el.tabLive.addEventListener("click", () => switchTab("live"));
    el.tabHistory.addEventListener("click", () => switchTab("history"));

    // Mobile collapsible panel
    el.panelToggle.addEventListener("click", () => {
      const expanded = el.panelToggle.getAttribute("aria-expanded") === "true";
      el.panelToggle.setAttribute("aria-expanded", String(!expanded));
      el.panelToggleLabel.textContent = expanded ? "Show panel" : "Hide panel";
      el.panelBody.dataset.collapsed = String(expanded);
    });
  }

  function switchTab(which) {
    const liveActive = which === "live";
    el.tabLive.classList.toggle("active", liveActive);
    el.tabHistory.classList.toggle("active", !liveActive);
    el.tabLive.setAttribute("aria-selected", String(liveActive));
    el.tabHistory.setAttribute("aria-selected", String(!liveActive));
    el.panelLive.hidden = !liveActive;
    el.panelHistory.hidden = liveActive;
  }

  let howToPlayReturnFocus = null;
  function showHowToPlay() {
    howToPlayReturnFocus = document.activeElement;
    el.howToPlayOverlay.hidden = false;
    el.howToPlayClose.focus();
  }
  function hideHowToPlay() {
    el.howToPlayOverlay.hidden = true;
    if (howToPlayReturnFocus && typeof howToPlayReturnFocus.focus === "function") {
      howToPlayReturnFocus.focus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 15. Boot                                                             */
  /* ------------------------------------------------------------------ */
  function boot() {
    resizeCanvas();
    wireInputs();
    syncChipActiveState();
    startCountdown();
    lastFrameTime = performance.now();
    animRafId = requestAnimationFrame(tick);

    // Independent heartbeat for the live bets list only, on a completely
    // separate browser scheduling path (setInterval, not
    // requestAnimationFrame). Redundant with the per-frame call in tick(),
    // deliberately so — if anything ever interferes with the rAF-driven
    // path specifically, this still keeps the panel populated.
    setInterval(() => {
      try {
        renderLiveBets();
      } catch (err) {
        console.error("[VECTOR] live bets heartbeat render failed:", err);
      }
    }, 500);

    // Diagnostic hook only — lets state be inspected from the browser
    // console (e.g. `__VECTOR_DEBUG__.state.npcs.length`) without changing
    // any gameplay behaviour.
    window.__VECTOR_DEBUG__ = { state, CONFIG, el };

    // First-time onboarding: Overdrive is the one genuinely novel mechanic
    // here and nothing else in the UI explains it, so show the rules once
    // per session. Not persisted across reloads — a prototype doesn't need
    // storage for this, and it's harmless to see again after a refresh.
    showHowToPlay();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
