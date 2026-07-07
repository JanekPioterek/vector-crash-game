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
     9.  Fake live bets (NPCs)
     10. History
     11. UI rendering
     12. Tunnel / pod canvas animation
     13. Input wiring
     14. Boot
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
    // RTP/house edge live in roundProvider.js (VECTOR-PF-v1) — this app
    // never redefines them locally, so there is exactly one source of truth
    // for the number that actually determines payouts.
    // Pacing polish pass: widened from 3.0s so players have real time to
    // read the odds, edit stake/auto-cashout and place a bet before launch.
    // See renderCountdown() for the BETS OPEN / LAST CHANCE / LAUNCHING
    // tiering this window is split into.
    COUNTDOWN_SECONDS: 6.0,
    RESULT_DISPLAY_SECONDS: 2.6,
    // A crash at/below this multiplier gets extra hold time on the result
    // screen (see LOW_CRASH_EXTRA_HOLD_SECONDS) — purely a display-duration
    // choice, made after the real crash multiplier is already settled, so it
    // cannot affect the outcome, RTP, or when the NEXT round's odds apply.
    LOW_CRASH_THRESHOLD: 1.2,
    LOW_CRASH_EXTRA_HOLD_SECONDS: 1.1,
    GROWTH_RATE: 0.1, // exponential growth constant for the multiplier (per second)
    // Flight-pacing warp (pure display/animation timing — see warpedElapsed()
    // below): the visual multiplier climbs noticeably slower for the first
    // few seconds of a round, then eases back up to the exact same long-run
    // rate GROWTH_RATE always had, so momentum at high multipliers is
    // unchanged. This never touches state.crashPoint, the settlement value,
    // or the odds — it only changes how many real seconds it visually takes
    // to get anywhere, which is what makes early flight (and especially very
    // low crashes like 1.03x-1.09x) readable instead of instantaneous.
    FLIGHT_WARP_DELAY: 2.72, // seconds; the asymptotic "extra time" borrowed from later in the flight
    FLIGHT_WARP_DECAY: 3.0, // seconds; how quickly the warp eases back out to full speed
    SPEED_RAMP_SECONDS: 2.4, // visual tunnel speed eases in over this many seconds after launch
    // Pure cosmetic multiplier on currentSpeedFactor()'s output (tunnel
    // drift, nebula/debris motion, engine glow pulse, vignette) — scales
    // how fast the flight FEELS across every phase uniformly. Does not
    // touch GROWTH_RATE, the flight-pacing warp, state.currentMultiplier,
    // state.crashPoint, or any timing the round loop/settlement relies on.
    VISUAL_SPEED_MULTIPLIER: 1.5,
    MAX_VISIBLE_MULTIPLIER: 1000,
    TRAIL_BASE_LEN: 22, // px, contrail length at round start
    TRAIL_RATE: 30, // px/sec, contrail growth rate
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
    // the player's own functional colours (cyan cruise, gold-green success,
    // red crash) so an opponent's identity colour is never mistaken for a
    // state change on the player's own ship.
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

  /* ------------------------------------------------------------------ */
  /* 2. DOM references                                                   */
  /* ------------------------------------------------------------------ */
  const el = {
    balanceValue: document.getElementById("balanceValue"),
    fairBadge: document.getElementById("fairBadge"),
    fairPopover: document.getElementById("fairPopover"),
    fairRound: document.getElementById("fairRound"),
    fairSeedHash: document.getElementById("fairSeedHash"),
    fairRandomnessInput: document.getElementById("fairRandomnessInput"),
    fairRandomnessRegen: document.getElementById("fairRandomnessRegen"),
    fairRandomnessHint: document.getElementById("fairRandomnessHint"),
    fairResult: document.getElementById("fairResult"),
    fairSeedRevealed: document.getElementById("fairSeedRevealed"),
    fairEntropyHash: document.getElementById("fairEntropyHash"),
    fairVerifyBtn: document.getElementById("fairVerifyBtn"),
    fairVerifyStatus: document.getElementById("fairVerifyStatus"),
    soundToggle: document.getElementById("soundToggle"),

    howToPlayBtn: document.getElementById("howToPlayBtn"),
    howToPlayOverlay: document.getElementById("howToPlayOverlay"),
    howToPlayClose: document.getElementById("howToPlayClose"),

    settingsBtn: document.getElementById("settingsBtn"),
    settingsPopover: document.getElementById("settingsPopover"),
    reduceMotionToggle: document.getElementById("reduceMotionToggle"),
    resetBalanceBtn: document.getElementById("resetBalanceBtn"),
    guardrailToggle: document.getElementById("guardrailToggle"),
    guardrailThresholdRow: document.getElementById("guardrailThresholdRow"),
    guardrailThresholdInput: document.getElementById("guardrailThresholdInput"),
    guardrailOverlay: document.getElementById("guardrailOverlay"),
    guardrailMessage: document.getElementById("guardrailMessage"),
    guardrailDismiss: document.getElementById("guardrailDismiss"),

    srAnnounce: document.getElementById("srAnnounce"),
    betHint: document.getElementById("betHint"),

    gameStage: document.getElementById("gameStage"),
    canvas: document.getElementById("tunnelCanvas"),
    modeLabel: document.getElementById("modeLabel"),
    multiplierValue: document.getElementById("multiplierValue"),
    resultBanner: document.getElementById("resultBanner"),
    autoPill: document.getElementById("autoPill"),
    countdownWrap: document.getElementById("countdownWrap"),
    countdownText: document.getElementById("countdownText"),
    countdownBarFill: document.getElementById("countdownBarFill"),
    crashFlash: document.getElementById("crashFlash"),
    recentRounds: document.getElementById("recentRounds"),

    betAmountInput: document.getElementById("betAmountInput"),
    betDecrease: document.getElementById("betDecrease"),
    betIncrease: document.getElementById("betIncrease"),
    chips: Array.from(document.querySelectorAll(".chip")),

    autoCashoutToggle: document.getElementById("autoCashoutToggle"),
    autoCashoutValue: document.getElementById("autoCashoutValue"),

    actionRow: document.getElementById("actionRow"),
    partialCashoutBtn: document.getElementById("partialCashoutBtn"),
    mainActionBtn: document.getElementById("mainActionBtn"),
    mainActionLabel: document.getElementById("mainActionLabel"),
    spaceHint: document.getElementById("spaceHint"),

    panelToggle: document.getElementById("panelToggle"),
    panelToggleLabel: document.getElementById("panelToggleLabel"),
    panelBody: document.getElementById("panelBody"),
    tabLive: document.getElementById("tabLive"),
    tabHistory: document.getElementById("tabHistory"),
    panelLive: document.getElementById("panelLive"),
    panelHistory: document.getElementById("panelHistory"),
    liveBetsList: document.getElementById("liveBetsList"),
    historyList: document.getElementById("historyList"),
    sessionStats: document.getElementById("sessionStats"),
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

    crashPoint: null, // the number the game loop actually plays against; set the instant commit resolves
    roundCommitReady: false, // gates COUNTDOWN -> RUNNING; see tick() and generateRound()
    publicRandomnessOverride: null, // player-set value from the fairness popover input, applies to the round currently committing
    cosmeticRng: null, // seeded PRNG for NPCs/backdrop only — never the crash point; see generateRound()

    // The full VECTOR-PF-v1 record for the round currently in progress.
    // Snapshotted by reference into each history entry (see pushHistory), so
    // once a round settles its fairness object is shared between state.
    // fairness and that history row — revealing the seed later updates both
    // at once. See roundProvider.js for what each field means and how it's
    // produced/verified.
    fairness: null,

    roundStartTime: null, // ms, performance.now() at moment round begins

    currentMultiplier: 1.0,
    countdownEndTime: null,
    resultEndTime: null,

    // { amount, remainingAmount, partials, cashedOutAtMultiplier, resolved, lost, finalNet }
    // `amount` is the original stake and never changes after commitBet;
    // `remainingAmount` is what's still actually at risk, and is what every
    // payout/crash/auto-cashout calculation operates on — it only differs
    // from `amount` once a partial cash-out has been taken.
    bet: null,
    queuedBet: null, // dollar amount queued mid-round, auto-placed when the next round's betting opens
    betAmount: 10,
    autoCashoutEnabled: false,
    autoCashoutValue: 2.0,
    milestoneIdx: 0, // next entry of MILESTONES to pip at while a live bet is flying

    // Session ledger — a responsible-gambling trust feature: the player can
    // always see exactly what they've staked and where they stand, win or
    // lose, without digging through history rows.
    session: { rounds: 0, wagered: 0, net: 0 },

    // Opt-in, front-end-only responsible-gambling reminder. `pending` is set
    // the instant the threshold is crossed but the modal itself is deferred
    // to the next startCountdown() — a calm moment between rounds — so it
    // never interrupts an in-flight round or steps on a win/loss beat.
    // `triggered` fires the reminder at most once per session.
    guardrail: { enabled: false, threshold: 100, triggered: false, pending: false },

    // One-time keyboard teach: shown only while Space would actually do
    // something, gone for good the instant the player presses it once.
    spaceHintUsed: false,

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
  /* 4. Round generation — provably fair (VECTOR-PF-v1) + cosmetic RNG   */
  /* ------------------------------------------------------------------ */
  // The crash multiplier itself is generated, committed, revealed and
  // independently verifiable entirely via roundProvider.js — this file
  // never touches crypto or randomness for that number. See that file's
  // header for the full RoundProvider contract (commitRound/revealRound)
  // and why LocalDemoAdapter is explicitly NOT the same thing as a real
  // backend, even though the maths it runs is identical to VECTOR-PF-v1.
  const RTP = window.VectorRoundProvider.RTP;
  const HOUSE_EDGE = window.VectorRoundProvider.HOUSE_EDGE;
  const CALCULATION_VERSION = window.VectorRoundProvider.CALCULATION_VERSION;
  // Swap this one line for `new window.VectorRoundProvider.ServerAdapter()`
  // once real backend endpoints exist — nothing else in this file changes.
  const roundProvider = new window.VectorRoundProvider.LocalDemoAdapter();

  // Mulberry32 — small, fast PRNG, reseeded every round from Math.random().
  // This is COSMETIC ONLY: NPC bot names/amounts/behaviour and the drifting
  // background nebulae. It has no bearing whatsoever on the crash
  // multiplier and is never used for anything a payout depends on — that
  // is the entire reason it's kept separate from roundProvider.js rather
  // than reusing the server seed for "free" determinism.
  function createCosmeticRng() {
    let t = (Math.random() * 0xffffffff) >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let x = t;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Kicks off the real provably-fair commit for this round: a fresh server
  // seed is generated, its SHA-256 hash and this round's public randomness
  // are made available immediately (see state.fairness), and the crash
  // multiplier is derived via HMAC-SHA256(serverSeed, "VECTOR:roundId:
  // publicRandomness") per VECTOR-PF-v1 — fixed now, before betting closes,
  // never touched again. This is async (real Web Crypto calls); state.
  // roundCommitReady flips true once it resolves, and tick() will not let
  // the round leave COUNTDOWN until it does (in practice this resolves in
  // low single-digit milliseconds — invisible against a 3 second countdown).
  // NPCs and the backdrop are regenerated synchronously below, independent
  // of this promise, since they have no reason to wait on real crypto.
  function generateRound() {
    state.roundId += 1;
    const roundId = state.roundId;

    state.roundCommitReady = false;
    state.fairness = {
      roundId,
      serverSeedHash: null,
      serverSeed: null,
      publicRandomness: null,
      entropyHash: null,
      crashMultiplier: null,
      rtp: RTP,
      houseEdge: HOUSE_EDGE,
      calculationVersion: CALCULATION_VERSION,
      revealed: false,
    };

    roundProvider
      .commitRound(roundId, state.publicRandomnessOverride)
      .then((committed) => {
        if (state.roundId !== roundId || state.fairness.roundId !== roundId) return; // stale
        state.fairness.serverSeedHash = committed.serverSeedHash;
        state.fairness.publicRandomness = committed.publicRandomness;
        state.fairness.entropyHash = committed.entropyHash;
        state.fairness.crashMultiplier = committed.crashMultiplier;
        state.crashPoint = committed.crashMultiplier;
        state.roundCommitReady = true;
        renderFairPopover();
      })
      .catch((err) => {
        // Fail safe, not fail silent: without Web Crypto there is no honest
        // way to generate a real-outcome number, so the round simply never
        // becomes ready rather than quietly falling back to Math.random().
        console.error("[VECTOR] round commit failed — betting cannot proceed safely:", err);
      });

    state.cosmeticRng = createCosmeticRng();
    regenerateEnvironmentForRound(state.cosmeticRng);
  }

  // Background nebulae and the pulsar re-seed each round from the cosmetic
  // RNG above — purely decorative, keeps the backdrop from looking
  // identical round after round, no connection to the crash multiplier.
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
        driftAccum: 0, // speed-weighted elapsed time, integrated each frame in drawNebulae
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
  // Reparametrizes real elapsed seconds into "curve time" for the visual
  // flight only. w(t) = t - A*(1 - e^(-t/B)):
  //   - w(0) = 0 exactly, so an instant 1.00x crash still displays as
  //     instant — no artificial minimum flight duration is introduced.
  //   - Early on, w(t) grows much slower than t (deliberately slow, readable
  //     opening seconds — this is the entire fix for low crashes like
  //     1.03x-1.09x feeling like a glitch: reaching them now visibly takes
  //     ~4x longer in real seconds than before).
  //   - dw/dt -> 1 as t grows, so for high multipliers the curve's rate of
  //     change converges back to exactly CONFIG.GROWTH_RATE's original
  //     pace — same momentum/urgency/acceleration feel at altitude, just
  //     phase-shifted a couple of seconds later than before.
  //   - Smooth (infinitely differentiable) and strictly increasing for
  //     every t >= 0 given A/B < 1, so there is never a visual stall,
  //     freeze, or backward jump.
  // A=2.72, B=3.0 were picked so the multiplier reads around ~1.25-1.30x at
  // t=4.5s (the "first 4.5 seconds should be slow and readable" target).
  function warpedElapsed(tSeconds) {
    const A = CONFIG.FLIGHT_WARP_DELAY;
    const B = CONFIG.FLIGHT_WARP_DECAY;
    return tSeconds - A * (1 - Math.exp(-tSeconds / B));
  }

  // multiplier(t) is a continuous curve over warped time — it never touches
  // state.crashPoint, which is generated and locked in before the round
  // starts and cannot be influenced by anything the player does in-round,
  // or by this animation-pacing change. A cash-out click still pays out
  // exactly state.currentMultiplier (this same function's value at that
  // instant), so there is no mismatch between what's displayed and what
  // settles — only the pacing of getting there changed.
  function computeMultiplier(nowMs) {
    const t = (nowMs - state.roundStartTime) / 1000;
    return Math.exp(CONFIG.GROWTH_RATE * warpedElapsed(t));
  }

  // Contrail length grows with warped elapsed flight time too, so it stays
  // visually in step with the (now re-paced) multiplier's own growth
  // instead of racing ahead of a multiplier that's climbing slower.
  function computeTrailLength(nowMs) {
    const t = warpedElapsed((nowMs - state.roundStartTime) / 1000);
    const len = CONFIG.TRAIL_BASE_LEN + CONFIG.TRAIL_RATE * t;
    return Math.min(CONFIG.TRAIL_MAX_LEN, len);
  }

  /* ------------------------------------------------------------------ */
  /* 6. Round loop (state machine)                                       */
  /* ------------------------------------------------------------------ */
  function startCountdown() {
    // The one safe, idle moment to surface the opt-in loss reminder — never
    // mid-flight, never stepping on a fresh win/loss result. See checkGuardrail.
    if (state.guardrail.pending) {
      state.guardrail.pending = false;
      showGuardrailReminder();
    }

    state.phase = PHASE.COUNTDOWN;
    state.currentMultiplier = 1.0;
    state.bet = null;
    state.cashoutWarp = null;
    state.cashoutTrail = null;
    state.countdownEndTime = performance.now() + CONFIG.COUNTDOWN_SECONDS * 1000;

    generateRound();
    generateNpcs();

    // A bet queued during the previous round converts into a real bet the
    // moment betting opens — re-validated against the live balance, since
    // it may have changed since the bet was queued.
    if (state.queuedBet != null) {
      const amount = clampBetAmount(state.queuedBet);
      state.queuedBet = null;
      if (amount <= state.balance) {
        commitBet(amount);
        announce(`Queued bet placed: ${formatMoney(amount)}`);
      } else {
        announce("Queued bet cancelled — insufficient balance");
      }
    }

    el.gameStage.dataset.mode = "cruise";
    renderAll();
  }

  function beginRound() {
    state.phase = PHASE.RUNNING;
    state.roundStartTime = performance.now();
    state.milestoneIdx = 0;
    renderAll();
  }

  function triggerCrash(now) {
    state.trailFrozenLen = computeTrailLength(now);
    state.phase = PHASE.RESULT;
    state.currentMultiplier = state.crashPoint;
    // Low crashes (<= LOW_CRASH_THRESHOLD) get a bit more hold time on the
    // result screen — the actual crash multiplier above is already fully
    // settled by this point; this only changes how long the READOUT stays
    // up before the next countdown starts, so a very fast round still gets
    // a moment to register as a real, deliberate outcome rather than a
    // blink-and-you-missed-it flicker.
    const holdSeconds =
      state.crashPoint <= CONFIG.LOW_CRASH_THRESHOLD
        ? CONFIG.RESULT_DISPLAY_SECONDS + CONFIG.LOW_CRASH_EXTRA_HOLD_SECONDS
        : CONFIG.RESULT_DISPLAY_SECONDS;
    state.resultEndTime = performance.now() + holdSeconds * 1000;
    el.gameStage.dataset.mode = "crashed";

    resolveNpcsOnCrash();

    if (state.bet && !state.bet.resolved) {
      state.bet.resolved = true;
      state.bet.lost = true;
      // Only the portion still at risk is lost — any partial cash-out taken
      // earlier already left the building and stays banked in the balance.
      const lostAmount = state.bet.remainingAmount;
      state.session.net -= lostAmount;
      const partialsPayout = state.bet.partials.reduce((sum, p) => sum + p.payout, 0);
      state.bet.finalNet = partialsPayout - state.bet.amount;
      announce(`Collapsed at ${formatMult(state.crashPoint)} — lost ${formatMoney(lostAmount)}`);
      checkGuardrail();
    } else {
      announce(`Collapsed at ${formatMult(state.crashPoint)}`);
    }

    // Pushed after the bet is fully resolved so history/finalNet reflects
    // the complete outcome, including any partial cash-out already banked.
    pushHistory(state.crashPoint);
    flashCrash();
    playSound("crash");

    // Reveal the server seed now that the round has actually settled — the
    // crash multiplier itself was already fixed at commit time (start of
    // countdown); this only unlocks the data needed to verify it after the
    // fact. `fairness` is the same object referenced by the history row
    // pushHistory just recorded, so both update the instant this resolves.
    const fairness = state.fairness;
    roundProvider.revealRound(fairness.roundId).then((revealed) => {
      if (!revealed || fairness.roundId !== revealed.roundId) return;
      fairness.serverSeed = revealed.serverSeed;
      fairness.revealed = true;
      renderFairPopover();
    });

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
        // Never leaves COUNTDOWN before the round's crash multiplier is
        // actually committed (see generateRound/roundCommitReady) — in
        // practice the real Web Crypto calls resolve in low single-digit
        // milliseconds, so this never visibly extends the countdown.
        if (remaining <= 0 && state.roundCommitReady) beginRound();
      } else if (state.phase === PHASE.RUNNING) {
        const m = computeMultiplier(now);
        // Auto-cashout settles at EXACTLY its target multiplier, and is
        // checked before the crash check on purpose: if the target sits
        // below the crash point it must pay, even when a single frame's
        // multiplier jump crosses both values at once (very possible at
        // high multipliers, where one 16ms frame can jump 0.1x+). The old
        // frame-based check both overpaid (whatever the frame happened to
        // land on) and could unfairly lose that race entirely.
        if (
          state.autoCashoutEnabled &&
          state.bet && !state.bet.resolved &&
          state.autoCashoutValue <= m &&
          state.autoCashoutValue < state.crashPoint
        ) {
          state.currentMultiplier = state.autoCashoutValue;
          cashOut(true);
        }
        if (m >= state.crashPoint) {
          triggerCrash(now);
        } else {
          state.currentMultiplier = m;
          checkMilestones(m);
          updateNpcs(m); // calls renderLiveBets() itself, but only when an NPC's status actually changes
          renderMultiplier();
        }
      } else if (state.phase === PHASE.RESULT) {
        if (now >= state.resultEndTime) endResultPhase();
      }

      drawTunnel(now);
    } catch (err) {
      console.error("[VECTOR] frame error (loop continues):", err);
    }

    // Deliberately NOT calling renderLiveBets() unconditionally here. It
    // used to be called every single frame (both originally, inside the
    // RUNNING branch above, and again here as an extra "safety" measure) —
    // but .bet-row plays a 250ms entrance animation, and rebuilding the
    // list every ~16ms means every row is a brand-new DOM node before its
    // previous instance ever finished fading in. CSS animations restart
    // from zero on a new node, so the rows were perpetually destroyed and
    // recreated mid-fade, stuck near-invisible — with no thrown error,
    // since nothing was actually broken from JS's point of view. This is
    // the real cause of the "Live Bets panel is empty" reports: it only
    // needs to re-render on actual state changes (see updateNpcs, and the
    // renderAll() calls around bets/cashouts/rounds), not every frame.
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

  // Shared bet commitment — used both by a direct PLACE BET during the
  // countdown and by queued-bet conversion at the top of a new round.
  function commitBet(amount) {
    state.balance -= amount;
    state.bet = {
      amount,
      remainingAmount: amount, // what's still actually at risk; shrinks on a partial cash-out
      partials: [], // { atMultiplier, amount, payout } — at most one entry in this MVP
      cashedOutAtMultiplier: null,
      resolved: false,
      lost: false,
      finalNet: null, // set once resolved (cashOut or triggerCrash); banner/history read this directly
    };
    state.session.rounds += 1;
    state.session.wagered += amount;
    playSound("bet");
  }

  function placeBet() {
    if (state.phase !== PHASE.COUNTDOWN) return;
    if (state.bet) return;
    const amount = clampBetAmount(Number(el.betAmountInput.value));
    if (amount > state.balance) return;

    commitBet(amount);
    announce(`Bet placed: ${formatMoney(amount)}`);
    renderAll();
  }

  // Queue-a-bet: while a round is already in flight (or just resolved), a
  // player without an active bet can commit to entering the next round
  // instead of sitting through dead time with a disabled button. The amount
  // is locked at queue time; tapping again cancels — nothing is deducted
  // until the bet actually converts at the next countdown.
  function toggleQueuedBet() {
    if (state.queuedBet != null) {
      state.queuedBet = null;
      announce("Queued bet cancelled");
    } else {
      const amount = clampBetAmount(Number(el.betAmountInput.value));
      if (amount > state.balance) return;
      state.queuedBet = amount;
      playSound("bet");
      announce(`Bet queued for next round: ${formatMoney(amount)}`);
    }
    renderMainButton();
    renderBetHint();
  }

  // Manual recovery path once balance runs out (or any time, via Settings)
  // — a prototype has no deposit flow, so without this a player who loses
  // everything has no way to keep testing the game.
  function resetBalance() {
    state.balance = CONFIG.STARTING_BALANCE;
    // A fresh bankroll gets a fresh ledger — session P/L against a balance
    // that just teleported back to the start would be meaningless.
    state.session = { rounds: 0, wagered: 0, net: 0 };
    // A new session gets a fresh shot at the reminder too, if it's enabled.
    state.guardrail.triggered = false;
    state.guardrail.pending = false;
    announce(`Balance reset to ${formatMoney(CONFIG.STARTING_BALANCE)}`);
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* 8. Cashout logic                                                    */
  /* ------------------------------------------------------------------ */
  function cashOut(isAuto) {
    if (state.phase !== PHASE.RUNNING) return;
    if (!state.bet || state.bet.resolved) return;

    const multiplier = state.currentMultiplier;
    state.bet.cashedOutAtMultiplier = multiplier;
    state.bet.resolved = true;

    // Only the portion still at risk settles here — any partial cash-out
    // already banked its own payout earlier and isn't touched again.
    const stake = state.bet.remainingAmount;
    const payout = stake * multiplier;
    const legNet = payout - stake;
    state.balance += payout;
    state.session.net += legNet;

    const partialsPayout = state.bet.partials.reduce((sum, p) => sum + p.payout, 0);
    state.bet.finalNet = partialsPayout + payout - state.bet.amount;

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
    announce(`${isAuto ? "Auto cashed" : "Cashed"} out at ${formatMult(multiplier)} — net win +${formatMoney(state.bet.finalNet)}`);
    checkGuardrail();
    renderAll();
  }

  // Partial cash-out ("Bank Half"): one decision, no new mode. Banks half of
  // whatever is still at risk at the current multiplier straight into the
  // balance; the other half keeps flying under the exact same rules as
  // before (can still hit auto-cashout, manual cash-out, or the crash).
  // Capped at one partial per bet — deliberately not a repeatable ladder —
  // so it stays a single moment of tension release, not a new sub-system.
  function partialCashOut() {
    if (state.phase !== PHASE.RUNNING) return;
    if (!state.bet || state.bet.resolved) return;
    if (state.bet.partials.length > 0) return;

    const multiplier = state.currentMultiplier;
    const stake = state.bet.remainingAmount;
    const portion = Math.round((stake / 2) * 100) / 100;
    const payout = portion * multiplier;

    state.bet.remainingAmount = Math.round((stake - portion) * 100) / 100;
    state.bet.partials.push({ atMultiplier: multiplier, amount: portion, payout });
    state.balance += payout;
    state.session.net += payout - portion;

    playSound("cashout");
    announce(`Banked ${formatMoney(payout)} at ${formatMult(multiplier)} — ${formatMoney(state.bet.remainingAmount)} still flying`);
    checkGuardrail();
    renderBalance();
    renderMainButton();
    renderPartialButton();
    renderLiveBets();
  }

  /* ------------------------------------------------------------------ */
  /* 8b. Session loss-reminder guardrail (opt-in, front-end only)         */
  /* ------------------------------------------------------------------ */
  // Deliberately minimal: one threshold, one reminder, shown at most once
  // per session, always deferred to the next countdown (see startCountdown)
  // so it never interrupts a round in progress. Off by default; the player
  // opts in and sets their own number in Settings.
  function checkGuardrail() {
    const g = state.guardrail;
    if (!g.enabled || g.triggered || g.pending) return;
    if (state.session.net <= -Math.abs(g.threshold)) {
      g.triggered = true;
      g.pending = true;
    }
  }

  let guardrailReturnFocus = null;
  function showGuardrailReminder() {
    if (!el.guardrailOverlay) return;
    el.guardrailMessage.textContent = `You're down ${formatMoney(Math.abs(state.session.net))} this session.`;
    guardrailReturnFocus = document.activeElement;
    el.guardrailOverlay.hidden = false;
    if (el.guardrailDismiss) el.guardrailDismiss.focus();
  }
  function hideGuardrailReminder() {
    if (!el.guardrailOverlay) return;
    el.guardrailOverlay.hidden = true;
    if (guardrailReturnFocus && typeof guardrailReturnFocus.focus === "function") {
      guardrailReturnFocus.focus();
    }
  }

  // Rising-pitch pips as a live, unresolved bet climbs past round-number
  // multipliers — a tension cue tied strictly to the player's own money in
  // flight (never plays for spectators or after cashing out).
  const MILESTONES = [2, 5, 10, 25, 50, 100];
  function checkMilestones(m) {
    if (!state.bet || state.bet.resolved) return;
    let crossed = false;
    while (state.milestoneIdx < MILESTONES.length && m >= MILESTONES[state.milestoneIdx]) {
      state.milestoneIdx += 1;
      crossed = true;
    }
    if (crossed) playSound("milestone", state.milestoneIdx);
  }

  /* ------------------------------------------------------------------ */
  /* 9. Fake live bets (NPCs)                                            */
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
    const rng = state.cosmeticRng;
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

      npcs.push({
        id: `${state.roundId}-${i}`,
        name,
        amount,
        planned,
        status: "waiting", // waiting | cashed | crash
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
        npc.status = "cashed";
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
    // Record the player's own net result for this round (null if they sat
    // it out). Prefers bet.finalNet — set at resolution in cashOut/
    // triggerCrash — since that's the only figure that correctly accounts
    // for a partial cash-out; falls back to the simple calc for safety if
    // a bet somehow reached here unresolved.
    const bet = state.bet;
    let playerNet = null;
    if (bet) {
      playerNet = bet.finalNet != null
        ? bet.finalNet
        : bet.cashedOutAtMultiplier
          ? bet.amount * (bet.cashedOutAtMultiplier - 1)
          : -bet.amount;
    }
    state.history.unshift({
      id: state.roundId,
      crashPoint,
      playerNet,
      time: new Date(),
      // Same object state.fairness points at — triggerCrash's revealRound()
      // mutates it in place once the seed comes back, so this history row's
      // Verify button sees the reveal too without any extra bookkeeping.
      fairness: state.fairness,
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
    renderPartialButton();
    renderSpaceHint();
    renderResultBanner();
    renderAutoPill();
    renderCountdownVisibility();
    renderRecentRounds();
    renderLiveBets();
    renderHistory();
    renderSessionStats();
    renderBetHint();
  }

  // Balance pulses white->green whenever it goes UP (payout landing is the
  // real reward moment). Deliberately no pulse on decrease: the deduction
  // at bet placement is expected, and flashing red at every stake would be
  // pure noise.
  let lastBalanceShown = null;
  function renderBalance() {
    el.balanceValue.textContent = formatMoney(state.balance);
    if (lastBalanceShown != null && state.balance > lastBalanceShown) {
      el.balanceValue.classList.remove("flash-up");
      void el.balanceValue.offsetWidth; // restart the CSS animation
      el.balanceValue.classList.add("flash-up");
    }
    lastBalanceShown = state.balance;
  }

  // Inline "Insufficient balance" hint — only while the player is actually
  // choosing a bet amount, not once one is already placed. The broader
  // "genuinely can't afford the minimum bet" state is communicated by the
  // main action button itself (see renderMainButton) rather than a
  // separate banner.
  function renderBetHint() {
    if (!el.betHint) return;
    const amount = clampBetAmount(Number(el.betAmountInput.value));
    // Relevant whenever the player is choosing an amount for a future bet —
    // either the countdown's PLACE BET or a mid-round BET NEXT ROUND.
    const insufficient = !state.bet && state.queuedBet == null && amount > state.balance;
    el.betHint.hidden = !insufficient;
  }

  function renderModeLabel() {
    let label = "CRUISE";
    if (state.phase === PHASE.RESULT) {
      label = state.bet && state.bet.cashedOutAtMultiplier ? "CASHED OUT" : "COLLAPSED";
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

  // Tiers the 6-second betting window into three readable states rather
  // than a bare decimal timer — "how much time is left" matters less than
  // "what can I still do right now". Boundaries: >=4s BETS OPEN, 2-3s LAST
  // CHANCE (betting stays enabled the whole time — nothing actually locks
  // early), 1s LAUNCHING. Purely a display tier; the real bet-lock moment
  // is unchanged (COUNTDOWN -> RUNNING in beginRound()).
  function countdownTier(displaySeconds) {
    if (displaySeconds >= 4) return { label: "BETS OPEN", cls: "is-bets-open" };
    if (displaySeconds >= 2) return { label: "LAST CHANCE", cls: "is-last-chance" };
    return { label: "LAUNCHING", cls: "is-launching" };
  }

  function renderCountdown(remainingMs) {
    const displaySeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const tier = countdownTier(displaySeconds);
    el.countdownText.textContent = `${tier.label} · ${displaySeconds}`;

    if (el.countdownWrap) {
      el.countdownWrap.classList.remove("is-bets-open", "is-last-chance", "is-launching");
      el.countdownWrap.classList.add(tier.cls);
      // Subtle anticipation tension in the final 2 seconds only (LAST
      // CHANCE·2 and LAUNCHING·1) — a gentle pulse, not a flash; see
      // .countdown-wrap.is-anticipating in styles.css.
      el.countdownWrap.classList.toggle("is-anticipating", displaySeconds <= 2);
    }

    // Depleting bar along the bottom of the pill — same information as the
    // text, but readable at a glance from peripheral vision while the
    // player's eyes are on the bet controls.
    if (el.countdownBarFill) {
      const p = Math.max(0, Math.min(1, remainingMs / (CONFIG.COUNTDOWN_SECONDS * 1000)));
      el.countdownBarFill.style.transform = `scaleX(${p.toFixed(4)})`;
    }
  }

  function renderCountdownVisibility() {
    el.countdownWrap.style.opacity = state.phase === PHASE.COUNTDOWN ? "1" : "0";
  }

  // Missed-bet recovery copy (spec: don't make a player re-enter settings
  // just because they missed this round's window) — surfaces the stake AND
  // the auto cash-out target together so it's clear both carried forward
  // untouched, not just the dollar amount.
  function queuedBetLabel() {
    // Kept deliberately short (one line, no wrap) — see #mainActionLabel's
    // white-space/ellipsis rule in styles.css, which backstops this against
    // ever wrapping to a second line and shifting the panel's height.
    const auto = state.autoCashoutEnabled ? ` @ ${formatMult(state.autoCashoutValue)} AUTO` : "";
    return `READY · ${formatMoney(state.queuedBet)}${auto} — CANCEL`;
  }

  function renderMainButton() {
    const btn = el.mainActionBtn;
    const label = el.mainActionLabel;
    btn.classList.remove("state-cashout", "state-success", "state-crashed", "state-queued");
    btn.disabled = false;

    // Genuinely out of funds is folded into the button itself rather than
    // a separate banner — one less element competing for attention, and
    // one less thing that can go out of sync with the real balance.
    const outOfFunds = !state.bet && state.balance < CONFIG.MIN_BET;

    if (state.phase === PHASE.COUNTDOWN) {
      if (state.bet) {
        label.textContent = "BET PLACED — WAITING";
        btn.disabled = true;
      } else if (outOfFunds) {
        label.textContent = "OUT OF FUNDS";
        btn.disabled = true;
      } else {
        label.textContent = "PLACE BET";
        const amount = clampBetAmount(Number(el.betAmountInput.value));
        btn.disabled = amount > state.balance;
      }
    } else if (state.phase === PHASE.RUNNING) {
      if (!state.bet) {
        // No stake in this round: instead of dead time behind a disabled
        // button, offer entry into the NEXT round (or cancel if queued).
        if (state.queuedBet != null) {
          label.textContent = queuedBetLabel();
          btn.classList.add("state-queued");
        } else if (outOfFunds) {
          label.textContent = "OUT OF FUNDS";
          btn.disabled = true;
        } else {
          label.textContent = "BET NEXT ROUND";
          const amount = clampBetAmount(Number(el.betAmountInput.value));
          btn.disabled = amount > state.balance;
        }
      } else if (state.bet.resolved) {
        label.textContent = `CASHED OUT AT ${formatMult(state.bet.cashedOutAtMultiplier)}`;
        btn.classList.add("state-success");
        btn.disabled = true;
      } else {
        // Only the portion still at risk is what cashing out now would pay —
        // that's remainingAmount, not the original stake, once a partial has
        // already been banked.
        const payout = state.bet.remainingAmount * state.currentMultiplier;
        label.textContent = `CASH OUT ${formatMoney(payout)}`;
        btn.classList.add("state-cashout");
      }
    } else if (state.phase === PHASE.RESULT) {
      // Players who had money in the round get their outcome held on the
      // button for the full result phase — a deliberate reflection beat,
      // especially after a loss (no instant "go again" prompt). Spectators
      // have nothing to reflect on, so they can queue for the next round
      // immediately.
      if (state.bet && state.bet.cashedOutAtMultiplier) {
        label.textContent = `CASHED OUT AT ${formatMult(state.bet.cashedOutAtMultiplier)}`;
        btn.classList.add("state-success");
        btn.disabled = true;
      } else if (state.bet && state.bet.lost) {
        // A partial cash-out taken earlier can outweigh the loss on the
        // portion that crashed — finalNet (set in triggerCrash) is the
        // honest number, not just "the stake is gone".
        const net = state.bet.finalNet != null ? state.bet.finalNet : -state.bet.remainingAmount;
        if (net >= 0) {
          label.textContent = `COLLAPSED — NET +${formatMoney(net)}`;
          btn.classList.add("state-success");
        } else {
          label.textContent = `LOST ${formatMoney(Math.abs(net))}`;
          btn.classList.add("state-crashed");
        }
        btn.disabled = true;
      } else if (state.queuedBet != null) {
        label.textContent = queuedBetLabel();
        btn.classList.add("state-queued");
      } else if (outOfFunds) {
        label.textContent = "OUT OF FUNDS";
        btn.classList.add("state-crashed");
        btn.disabled = true;
      } else {
        label.textContent = "BET NEXT ROUND";
        const amount = clampBetAmount(Number(el.betAmountInput.value));
        btn.disabled = amount > state.balance;
      }
    }
  }

  // Shows the secondary "BANK HALF" button only in the one window where
  // it's a valid, still-fresh decision: a live, unresolved bet, mid-flight,
  // with no partial taken yet. Toggles a layout class on the action row so
  // it only ever grows to two buttons when there's genuinely a second
  // action to take — every other state stays the plain single full-width
  // button.
  function renderPartialButton() {
    if (!el.partialCashoutBtn || !el.actionRow) return;
    const eligible =
      state.phase === PHASE.RUNNING &&
      state.bet && !state.bet.resolved &&
      state.bet.partials.length === 0;
    el.partialCashoutBtn.hidden = !eligible;
    el.actionRow.classList.toggle("has-partial", eligible);
    if (eligible) {
      const portion = Math.round((state.bet.remainingAmount / 2) * 100) / 100;
      el.partialCashoutBtn.textContent = `BANK ${formatMoney(portion)}`;
    }
  }

  // One-time keyboard teach, rendered as a quiet "SPACE" tag in the main
  // button's own corner (see .space-tag) rather than a separate hint row.
  // Mirrors the exact branching in the mainActionBtn click handler (see
  // wireInputs) so it's only ever visible when Space would genuinely do
  // something — never shown against a disabled/readout state where
  // pressing it is a no-op. Permanently dismissed (state.spaceHintUsed)
  // the instant the player presses Space for the first time; see the
  // keydown handler.
  function renderSpaceHint() {
    if (!el.spaceHint) return;
    if (state.spaceHintUsed) {
      el.spaceHint.classList.remove("is-visible");
      return;
    }

    const amount = clampBetAmount(Number(el.betAmountInput.value));
    const canAffordAmount = amount <= state.balance;
    let active = false;

    if (state.phase === PHASE.COUNTDOWN && !state.bet) {
      active = canAffordAmount;
    } else if (state.phase === PHASE.RUNNING && state.bet && !state.bet.resolved) {
      active = true;
    } else if ((state.phase === PHASE.RUNNING || state.phase === PHASE.RESULT) && !state.bet) {
      active = state.queuedBet != null || canAffordAmount;
    }

    el.spaceHint.classList.toggle("is-visible", active);
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
      // Net win, not total return — "+$13.50" must equal what the balance
      // actually gained versus before the round, or the number reads as a
      // bigger win than it was. finalNet already folds in any partial
      // cash-out taken earlier in the same round.
      const net = state.bet.finalNet != null
        ? state.bet.finalNet
        : state.bet.amount * (state.bet.cashedOutAtMultiplier - 1);
      banner.className = "result-banner success fade-in";
      banner.innerHTML = `CASHED OUT AT ${formatMult(state.bet.cashedOutAtMultiplier)}<span class="payout-line">+${formatMoney(net)} net win</span>`;
    } else if (state.bet && state.bet.lost) {
      // A partial banked before the crash can outweigh the loss on the
      // portion that didn't make it — show the honest overall result
      // rather than implying the whole stake was lost.
      const net = state.bet.finalNet != null ? state.bet.finalNet : -state.bet.remainingAmount;
      if (net >= 0) {
        banner.className = "result-banner success fade-in";
        banner.innerHTML = `COLLAPSED AT ${formatMult(state.crashPoint)}<span class="payout-line">+${formatMoney(net)} net win</span>`;
      } else {
        banner.className = "result-banner crash fade-in";
        banner.innerHTML = `COLLAPSED AT ${formatMult(state.crashPoint)}<span class="loss-line">LOST ${formatMoney(Math.abs(net))}</span>`;
      }
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
    if ((state.phase === PHASE.COUNTDOWN || state.phase === PHASE.RUNNING) && state.npcs.length === 0 && state.cosmeticRng) {
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
            : { cls: "tag-cashed", text: "CASHED OUT" }
          : { cls: "tag-waiting", text: state.phase === PHASE.COUNTDOWN ? "PENDING" : "IN FLIGHT" };
        // Once a partial has been banked, the row shows what's actually
        // still at risk rather than the original stake — that's the number
        // that matters for the rest of the round.
        const hasPartial = state.bet.partials.length > 0;
        const displayAmount = hasPartial ? state.bet.remainingAmount : state.bet.amount;
        frag.appendChild(buildBetRow(hasPartial ? "You (partial)" : "You", displayAmount, tag.cls, tag.text, true, SELF_SHIP_COLOR));
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
        else tag = { cls: "tag-cashed", text: formatMult(npc.cashedAt) };
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
        const net = h.playerNet;
        const netHtml =
          net == null
            ? ""
            : `<span class="history-net ${net >= 0 ? "pos" : "neg"}">${net >= 0 ? "+" : "−"}${formatMoney(Math.abs(net))}</span>`;
        return `<li class="history-row" data-round-id="${h.id}">
          <span class="history-chip tier-${tier}">${formatMult(h.crashPoint)}</span>
          ${netHtml}
          <span class="history-time">${time}</span>
          <button type="button" class="history-verify-btn" data-round-id="${h.id}">Verify</button>
        </li>`;
      })
      .join("");
  }

  // Renders the Fairness popover from state.fairness / state.phase. Called
  // whenever a round commits or reveals (even while the popover is closed —
  // cheap DOM writes to hidden elements) and again the moment the badge is
  // opened, so it's never stale. The actual crash multiplier is withheld
  // from #fairResult until the round has genuinely settled (fairness.
  // revealed), even though it was already fixed at commit time — showing it
  // early would spoil the round, not just prove fairness.
  function renderFairPopover() {
    if (!el.fairPopover) return;
    const f = state.fairness;

    if (el.fairRound) el.fairRound.textContent = f ? `#${f.roundId}` : "—";
    if (el.fairSeedHash) el.fairSeedHash.textContent = f && f.serverSeedHash ? f.serverSeedHash : "Pending…";

    // Never stomp on what the player is actively typing.
    if (el.fairRandomnessInput && document.activeElement !== el.fairRandomnessInput) {
      el.fairRandomnessInput.value = f && f.publicRandomness ? f.publicRandomness : "";
    }
    if (el.fairRandomnessHint) {
      el.fairRandomnessHint.textContent = state.publicRandomnessOverride
        ? "Custom randomness set — applies starting next round"
        : "";
    }

    if (el.fairResult) {
      el.fairResult.textContent =
        f && f.revealed && f.crashMultiplier != null ? formatMult(f.crashMultiplier) : "Pending — locked in";
    }
    if (el.fairSeedRevealed) {
      el.fairSeedRevealed.textContent = f && f.revealed ? f.serverSeed : "Revealed after round settles";
    }
    if (el.fairEntropyHash) {
      el.fairEntropyHash.textContent = f && f.revealed ? f.entropyHash : "—";
    }
    if (el.fairVerifyBtn) el.fairVerifyBtn.disabled = !(f && f.revealed);
    if (el.fairVerifyStatus && !(f && f.revealed)) {
      el.fairVerifyStatus.hidden = true;
      el.fairVerifyStatus.className = "fair-verify-status";
    }
  }

  // Shared by the live Verify Round button and each history row's Verify
  // link — runs window.VectorRoundProvider.verifyRound() against whatever
  // fairness snapshot it's handed and paints the result into a status node.
  // `baseClass` lets callers use their own compact styling (history rows)
  // instead of the popover's full-width status bar.
  async function runFairnessVerification(fairness, statusEl, baseClass) {
    if (!statusEl) return;
    const cls = baseClass || "fair-verify-status";
    statusEl.hidden = false;
    statusEl.className = `${cls} is-checking`;
    statusEl.textContent = "Checking…";
    const result = await window.VectorRoundProvider.verifyRound(fairness);
    const labels = {
      verified: "Verified",
      missing: "Missing fairness data",
      seed_hash_mismatch: "Seed hash mismatch",
      entropy_mismatch: "Entropy mismatch",
      crash_mismatch: "Crash result mismatch",
    };
    statusEl.textContent = labels[result.reason] || "Verification failed";
    statusEl.className = `${cls} ${result.ok ? "is-verified" : result.reason === "missing" ? "is-missing" : "is-mismatch"}`;
    return result;
  }

  // Compact strip of recent crash points above the betting panel — the
  // scan-the-recent-rounds ritual shouldn't require opening a side tab
  // (which on mobile sits below the fold). Rebuilt only from renderAll's
  // event-driven calls, never per-frame, so the newest chip's one-shot
  // entrance animation always gets to finish.
  function renderRecentRounds() {
    if (!el.recentRounds) return;
    el.recentRounds.hidden = state.history.length === 0;
    while (el.recentRounds.firstChild) el.recentRounds.removeChild(el.recentRounds.firstChild);
    const recent = state.history.slice(0, 10);
    for (let i = 0; i < recent.length; i++) {
      const chip = document.createElement("span");
      chip.className = `history-chip recent-chip tier-${tierFor(recent[i].crashPoint)}${i === 0 ? " newest" : ""}`;
      chip.setAttribute("role", "listitem");
      chip.textContent = formatMult(recent[i].crashPoint);
      el.recentRounds.appendChild(chip);
    }
  }

  // "AUTO CASHOUT @ 2.00x" pill under the multiplier while a live bet has
  // auto-cashout armed — otherwise the armed state is invisible exactly
  // when it matters.
  function renderAutoPill() {
    if (!el.autoPill) return;
    // "Armed" here means: there is a stake committed to a round (either a
    // live unresolved bet this round, or a queued bet lined up for the
    // next one) AND auto cash-out is switched on — the player should be
    // able to see this confirmation before every launch, not just while
    // a bet happens to already be running.
    const hasCommittedStake = (state.bet && !state.bet.resolved) || (!state.bet && state.queuedBet != null);
    const show =
      state.autoCashoutEnabled &&
      hasCommittedStake &&
      (state.phase === PHASE.COUNTDOWN || state.phase === PHASE.RUNNING || state.phase === PHASE.RESULT);
    el.autoPill.hidden = !show;
    if (show) el.autoPill.textContent = `AUTO CASHOUT ARMED · ${formatMult(state.autoCashoutValue)}`;
  }

  // Session ledger line atop the History tab: bets, total wagered, net
  // position — colour-coded both ways, red included. Honest accounting is
  // the point.
  function renderSessionStats() {
    if (!el.sessionStats) return;
    const s = state.session;
    if (s.rounds === 0) {
      el.sessionStats.hidden = true;
      return;
    }
    el.sessionStats.hidden = false;
    const sign = s.net >= 0 ? "+" : "−";
    el.sessionStats.innerHTML = "";
    el.sessionStats.textContent = `This session: ${s.rounds} bet${s.rounds === 1 ? "" : "s"} · ${formatMoney(s.wagered)} wagered · `;
    const netEl = document.createElement("span");
    netEl.className = s.net >= 0 ? "session-net pos" : "session-net neg";
    netEl.textContent = `${sign}${formatMoney(Math.abs(s.net))} net`;
    el.sessionStats.appendChild(netEl);
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

  function playSound(name, tier) {
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
      } else if (name === "crash") {
        noiseBurst(ctx, { start: t, duration: 0.4, gain: 0.24 });
        tone(ctx, { freq: 140, start: t, duration: 0.3, type: "square", gain: 0.1, glideTo: 40 });
      } else if (name === "milestone") {
        // Short pip, rising in pitch with each milestone crossed — quiet
        // enough to read as a tick of tension, not a celebration.
        const idx = Math.max(1, tier | 0);
        tone(ctx, { freq: 540 + idx * 80, start: t, duration: 0.06, type: "sine", gain: 0.07 });
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

  // Drift is integrated per-frame (driftAccum += dt * speed) rather than
  // derived straight from absolute time, so the same `speed` signal that
  // drives the dust particles and vignette — base idle rate plus
  // log(multiplier) growth, see currentSpeedFactor — also governs how fast
  // the backdrop itself slides past. Bigger multiplier reads as faster
  // everywhere in the scene, not just in the foreground streaks.
  function drawNebulae(dt, speed, palette) {
    for (const n of state.env.nebulae) {
      if (!prefersReducedMotion) n.driftAccum += dt * speed;
      const x = (n.x + n.driftVx * n.driftAccum) * cw;
      const y = (n.y + n.driftVy * n.driftAccum) * ch;
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
  // Same speed-coupling as drawNebulae: debris drifts noticeably faster as
  // the multiplier climbs (speed > 1 once log(multiplier) growth kicks in)
  // and slows back to a lazy idle drift during countdown/result, matching
  // whatever the dust particles and vignette are doing at that instant.
  function drawDebris(dt, speed) {
    for (const d of state.env.debris) {
      d.x += d.vx * dt * speed * (prefersReducedMotion ? 0.2 : 1);
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

  function drawEnvironment(now, palette, vp, dt, speed) {
    drawStars(now);
    drawConstellations();
    // Pulsar deliberately does NOT take `speed` — it's a calm, independent
    // counterpoint that never reacts to the round, unlike everything else
    // in this function (see drawPulsar's own comment).
    drawPulsar(now);
    drawNebulae(dt, speed, palette);
    drawDebris(dt, speed);
    updateStorm(now);
    drawStorm(vp, now, palette);
  }

  let lastFrameTime = performance.now();

  function currentSpeedFactor() {
    // Baseline idle drift, rising with the multiplier for perceived speed.
    // Deliberately uncapped (log growth self-limits the rate of increase,
    // but there's no hard plateau) so the tunnel keeps visibly accelerating
    // all the way through high multipliers instead of feeling the same
    // from 10x to 100x.
    let raw;
    if (state.phase === PHASE.RUNNING) {
      // Speed eases in over the first couple of seconds rather than
      // snapping straight to full speed the instant the round launches.
      const elapsed = state.roundStartTime != null ? (performance.now() - state.roundStartTime) / 1000 : 0;
      const rampIn = Math.min(1, elapsed / CONFIG.SPEED_RAMP_SECONDS);
      const base = 0.5 + 0.5 * rampIn;
      const growth = Math.log(Math.max(1, state.currentMultiplier)) * 0.42;
      raw = base + growth;
    } else if (state.phase === PHASE.RESULT) {
      raw = 0.15;
    } else {
      raw = 0.35; // countdown idle drift
    }
    // Single, uniform "feel faster" knob (CONFIG.VISUAL_SPEED_MULTIPLIER) —
    // scales every phase's speed proportionally. Purely cosmetic: this
    // value only ever feeds dt-based visual motion (tunnel drift, nebula/
    // debris drift, engine glow, vignette) — never the multiplier curve,
    // the crash point, or anything the round loop/settlement reads.
    return raw * CONFIG.VISUAL_SPEED_MULTIPLIER;
  }

  function currentPalette() {
    if (state.phase === PHASE.RESULT) {
      if (state.bet && state.bet.cashedOutAtMultiplier && !state.bet.lost) {
        return { r: 186, g: 255, b: 107 }; // success green
      }
      return { r: 255, g: 84, b: 104 }; // crash red
    }
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

  // Contrail length: live while running, frozen at the value captured the
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
    drawEnvironment(now, palette, vp, dt, speed);

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
      } else if (npc.status === "cashed" && npc.warpBornAt != null) {
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
    // separate from the normal idle/cruise/crash rendering below.
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
    const x = baseX;
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
      // While off, the field shows nothing at all — no value, no example
      // number placeholder either. A dimmed "2.00" still reads as a live
      // number at a glance (same digits, same position as the real value);
      // a genuinely empty box is the only version that unambiguously reads
      // as "off". The real target stays in state.autoCashoutValue
      // regardless, so nothing is lost by clearing the visible field here.
      if (state.autoCashoutEnabled) {
        el.autoCashoutValue.value = state.autoCashoutValue.toFixed(2);
        el.autoCashoutValue.placeholder = "2.00";
      } else {
        el.autoCashoutValue.value = "";
        el.autoCashoutValue.placeholder = "";
      }
      renderAutoPill();
    });
    el.autoCashoutValue.addEventListener("input", () => {
      let v = Number(el.autoCashoutValue.value);
      if (isNaN(v)) return;
      // Sanity ceiling — matches the same cap the crash curve itself uses,
      // so there's no way to set an auto-cashout target that could never
      // possibly trigger.
      v = Math.min(v, CONFIG.MAX_VISIBLE_MULTIPLIER);
      if (v >= 1.01) state.autoCashoutValue = v;
      renderAutoPill();
    });

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

    // Session loss-reminder guardrail — opt-in, off by default.
    if (el.guardrailToggle) {
      el.guardrailToggle.addEventListener("click", () => {
        state.guardrail.enabled = !state.guardrail.enabled;
        el.guardrailToggle.setAttribute("aria-checked", String(state.guardrail.enabled));
        if (el.guardrailThresholdRow) el.guardrailThresholdRow.hidden = !state.guardrail.enabled;
        // Turning it on (or back on) gives it a fresh shot at firing again
        // this session; turning it off cancels any reminder already queued.
        if (state.guardrail.enabled) {
          state.guardrail.triggered = false;
        } else {
          state.guardrail.pending = false;
        }
      });
    }
    if (el.guardrailThresholdInput) {
      el.guardrailThresholdInput.addEventListener("input", () => {
        const v = Number(el.guardrailThresholdInput.value);
        if (!isNaN(v) && v > 0) state.guardrail.threshold = Math.min(5000, v);
      });
    }
    if (el.guardrailDismiss) el.guardrailDismiss.addEventListener("click", hideGuardrailReminder);
    if (el.guardrailOverlay) {
      el.guardrailOverlay.addEventListener("click", (e) => {
        if (e.target === el.guardrailOverlay) hideGuardrailReminder();
      });
    }

    if (el.partialCashoutBtn) el.partialCashoutBtn.addEventListener("click", partialCashOut);

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
      if (state.phase === PHASE.COUNTDOWN && !state.bet) {
        placeBet();
      } else if (state.phase === PHASE.RUNNING && state.bet && !state.bet.resolved) {
        cashOut();
      } else if (
        // Queue / cancel entry into the next round while this one is still
        // in flight or resolving — only for players with no bet outcome
        // being displayed (their button is a disabled outcome readout).
        (state.phase === PHASE.RUNNING || state.phase === PHASE.RESULT) &&
        !state.bet
      ) {
        toggleQueuedBet();
      }
    });

    // Keyboard shortcuts (layered on top of native tab/enter/space support).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!el.howToPlayOverlay.hidden) hideHowToPlay();
        if (el.guardrailOverlay && !el.guardrailOverlay.hidden) hideGuardrailReminder();
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
        // The hint has done its job the instant Space is pressed once —
        // dismiss it here (fades via CSS) rather than waiting on whatever
        // renderAll() the resulting action happens to trigger.
        if (!state.spaceHintUsed) {
          state.spaceHintUsed = true;
          renderSpaceHint();
        }
        el.mainActionBtn.click();
      }
    });

    // Provably fair popover
    el.fairBadge.addEventListener("click", () => {
      const willOpen = el.fairPopover.hidden;
      el.fairPopover.hidden = !willOpen;
      el.fairBadge.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) renderFairPopover();
    });
    document.addEventListener("click", (e) => {
      if (!el.fairPopover.hidden && !el.fairBadge.contains(e.target) && !el.fairPopover.contains(e.target)) {
        el.fairPopover.hidden = true;
        el.fairBadge.setAttribute("aria-expanded", "false");
      }
    });

    // Player-editable public randomness ("client seed"). The round in
    // progress already committed the instant its countdown started (see
    // generateRound), so a value typed here can't touch that round's
    // already-published commitment — it's queued as the override for
    // whichever round commits next. Empty input clears the override, back
    // to an auto-generated value each round.
    if (el.fairRandomnessInput) {
      el.fairRandomnessInput.addEventListener("change", () => {
        const v = el.fairRandomnessInput.value.trim();
        state.publicRandomnessOverride = v.length > 0 ? v : null;
        renderFairPopover();
      });
    }
    if (el.fairRandomnessRegen) {
      el.fairRandomnessRegen.addEventListener("click", () => {
        const fresh = window.VectorRoundProvider.randomHex(16);
        state.publicRandomnessOverride = fresh;
        if (el.fairRandomnessInput) el.fairRandomnessInput.value = fresh;
        renderFairPopover();
      });
    }
    if (el.fairVerifyBtn) {
      el.fairVerifyBtn.addEventListener("click", () => {
        if (state.fairness && state.fairness.revealed) {
          runFairnessVerification(state.fairness, el.fairVerifyStatus);
        }
      });
    }

    // Delegated so it keeps working across renderHistory()'s innerHTML
    // rebuilds — each button carries the round id it verifies against.
    if (el.historyList) {
      el.historyList.addEventListener("click", (e) => {
        const btn = e.target.closest(".history-verify-btn");
        if (!btn) return;
        const roundId = Number(btn.dataset.roundId);
        const entry = state.history.find((h) => h.id === roundId);
        if (!entry || !entry.fairness) return;
        btn.hidden = true;
        const status = document.createElement("span");
        status.className = "history-verify-status is-checking";
        status.textContent = "Checking…";
        btn.insertAdjacentElement("afterend", status);
        runFairnessVerification(entry.fairness, status, "history-verify-status");
      });
    }

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
    // Sync the auto-cashout field's visible state to state.autoCashoutEnabled
    // right away, rather than waiting for the first toggle click — the
    // static HTML ships with no placeholder/value at all (matches the
    // default: disabled), but this keeps boot() as the single source of
    // truth if that default ever changes.
    if (el.autoCashoutValue) {
      el.autoCashoutValue.placeholder = state.autoCashoutEnabled ? "2.00" : "";
      el.autoCashoutValue.value = state.autoCashoutEnabled ? state.autoCashoutValue.toFixed(2) : "";
    }
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

    // First-time onboarding: show the rules once per session so a new
    // player knows how cashing out and the collapse point work before
    // placing a bet. Not persisted across reloads — a prototype doesn't
    // need storage for this, and it's harmless to see again after a
    // refresh.
    showHowToPlay();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
