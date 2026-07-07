/* ==========================================================================
   VECTOR — Round Provider (provably fair engine), calculation VECTOR-PF-v1
   ==========================================================================
   This file is the ONLY place that knows how a crash result is generated
   and verified. script.js never touches crypto or randomness directly — it
   asks a RoundProvider to commit a round, reads the crash multiplier it
   needs to run the game loop, and later asks the same provider to reveal
   the round so the player can verify it. That boundary is deliberate:

     RoundProvider (interface, in spirit — plain duck typing here)
       commitRound(roundId, publicRandomnessOverride) -> Promise<{
         roundId, serverSeedHash, publicRandomness, entropyHash, crashMultiplier
       }>
       revealRound(roundId) -> Promise<{ roundId, serverSeed } | null>

     LocalDemoAdapter   — implemented below. Runs entirely in the browser.
                          Real crypto (Web Crypto SHA-256 / HMAC-SHA256),
                          real math, but the "server seed" lives in this
                          tab's memory, not on an actual server nobody else
                          can see. That is a meaningful difference from real
                          provably-fair infrastructure — see the DEMO_MODE_
                          DISCLAIMER string below, which script.js surfaces
                          to the player rather than overclaiming.

     ServerAdapter      — stub. Throws on every call. This is where real
                          production endpoints get wired in: commitRound()
                          would POST to a backend that generates and stores
                          the server seed server-side and returns only the
                          hash + public randomness + entropy hash + crash
                          multiplier (never the seed itself); revealRound()
                          would GET the seed once the backend has actually
                          settled the round. No code in script.js needs to
                          change to swap LocalDemoAdapter for ServerAdapter —
                          that is the entire point of this boundary.

   Nothing in this file uses Math.random() for the crash multiplier. Every
   real-money-adjacent number here comes from Web Crypto (crypto.getRandom
   Values / crypto.subtle) and the documented VECTOR-PF-v1 formula below.
   ========================================================================== */

(function (global) {
  "use strict";

  const RTP = 0.98;
  const HOUSE_EDGE = 0.02;
  const CALCULATION_VERSION = "VECTOR-PF-v1";
  const MAX_VISIBLE_MULTIPLIER = 1000; // safety cap, matches the app's own CONFIG.MAX_VISIBLE_MULTIPLIER

  const DEMO_MODE_DISCLAIMER =
    "This tab generates and holds its own \"server\" seed locally — there is " +
    "no real backend, so there is nothing genuinely secret from a determined " +
    "user of this same browser. It is a faithful implementation of the " +
    "VECTOR-PF-v1 commit-reveal maths, not production-grade provably fair " +
    "infrastructure. See CALCULATION_VERSION for the exact formula this " +
    "build runs, byte for byte the same one a real backend would run.";

  function assertCrypto() {
    if (!global.crypto || !global.crypto.subtle || !global.crypto.getRandomValues) {
      throw new Error(
        "[VECTOR] Web Crypto API is unavailable in this environment. " +
          "VECTOR-PF-v1 requires crypto.subtle + crypto.getRandomValues for " +
          "real outcomes and deliberately has no Math.random() fallback for them."
      );
    }
  }

  function bytesToHex(bytes) {
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
  }

  // Cryptographically secure random hex string, `byteLen` bytes long (so
  // the resulting hex string is byteLen*2 characters).
  function randomHex(byteLen) {
    assertCrypto();
    const bytes = new Uint8Array(byteLen);
    global.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  async function sha256Hex(message) {
    assertCrypto();
    const data = new TextEncoder().encode(String(message));
    const digest = await global.crypto.subtle.digest("SHA-256", data);
    return bytesToHex(new Uint8Array(digest));
  }

  // HMAC-SHA256(key, message) -> hex digest. `key` is used as a UTF-8 string
  // (the server seed itself), matching the spec's HMAC-SHA256(serverSeed, ...).
  async function hmacSha256Hex(key, message) {
    assertCrypto();
    const keyBytes = new TextEncoder().encode(String(key));
    const msgBytes = new TextEncoder().encode(String(message));
    const cryptoKey = await global.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await global.crypto.subtle.sign("HMAC", cryptoKey, msgBytes);
    return bytesToHex(new Uint8Array(signature));
  }

  // ------------------------------------------------------------------
  // The crash formula itself. Given the final entropy hash (hex), derive
  // the crash multiplier:
  //
  //   1. Take the first 13 hex characters of the entropy hash (52 bits).
  //   2. u = that integer / 2^52   -> uniform on [0, 1)
  //   3. rawMultiplier = RTP / (1 - u)
  //   4. Floor to 2 decimals (never round up — the house edge must never
  //      be given away by rounding in the player's favour).
  //   5. Clamp to at least 1.00 (an instant crash) and at most the safety cap.
  //
  // This single expression reproduces exactly the RTP/X survival curve the
  // spec calls for: P(crash >= X) = RTP / X for every X >= 1. At X = 1.00,
  // rawMultiplier can fall below 1.00 whenever u < 1 - RTP (a 2.00% chance,
  // exactly HOUSE_EDGE) — that's what an "instant crash" is: not a special
  // case bolted on, just this same formula's own left tail.
  // ------------------------------------------------------------------
  function crashFromEntropyHex(entropyHex) {
    const hex13 = entropyHex.slice(0, 13);
    const intVal = parseInt(hex13, 16); // safe: max value is 2^52-1, well under Number.MAX_SAFE_INTEGER
    const u = intVal / Math.pow(2, 52);
    const raw = RTP / (1 - u);
    const floored = Math.floor(raw * 100) / 100;
    return Math.min(MAX_VISIBLE_MULTIPLIER, Math.max(1.0, floored));
  }

  // ------------------------------------------------------------------
  // LocalDemoAdapter — see file header. Keeps each round's server seed in
  // a private Map, only handing it out via revealRound(), so the UI layer
  // can still enforce a real commit-reveal *shape* even though this adapter
  // has no real secrecy boundary to back it.
  // ------------------------------------------------------------------
  class LocalDemoAdapter {
    constructor() {
      this._secrets = new Map(); // roundId -> serverSeed
    }

    async commitRound(roundId, publicRandomnessOverride) {
      assertCrypto();
      const serverSeed = randomHex(32); // 256 bits
      const serverSeedHash = await sha256Hex(serverSeed);
      const publicRandomness =
        publicRandomnessOverride && String(publicRandomnessOverride).trim().length > 0
          ? String(publicRandomnessOverride).trim()
          : randomHex(16); // 128 bits, auto-generated "development randomness" if the player hasn't set their own

      const message = `VECTOR:${roundId}:${publicRandomness}`;
      const entropyHash = await hmacSha256Hex(serverSeed, message);
      const crashMultiplier = crashFromEntropyHex(entropyHash);

      this._secrets.set(roundId, serverSeed);

      return { roundId, serverSeedHash, publicRandomness, entropyHash, crashMultiplier };
    }

    async revealRound(roundId) {
      const serverSeed = this._secrets.get(roundId);
      if (serverSeed == null) return null;
      return { roundId, serverSeed };
    }
  }

  // ------------------------------------------------------------------
  // ServerAdapter — production seam. Every method throws until real
  // endpoints are wired in. Intentionally left unimplemented rather than
  // silently falling back to the demo adapter, so a real deployment can't
  // accidentally ship on client-generated "server" seeds.
  // ------------------------------------------------------------------
  class ServerAdapter {
    async commitRound() {
      throw new Error(
        "[VECTOR] ServerAdapter.commitRound() is not implemented. Wire this " +
          "to a real backend endpoint that generates and stores the server " +
          "seed server-side, and returns { roundId, serverSeedHash, " +
          "publicRandomness, entropyHash, crashMultiplier } — never the raw seed."
      );
    }
    async revealRound() {
      throw new Error(
        "[VECTOR] ServerAdapter.revealRound() is not implemented. Wire this " +
          "to a real backend endpoint that returns { roundId, serverSeed } " +
          "only once that round has actually settled server-side."
      );
    }
  }

  // ------------------------------------------------------------------
  // Independent verification. Recomputes every step from the revealed data
  // and compares against what was published/used, so a caller can find out
  // exactly which layer failed rather than a single opaque pass/fail.
  // ------------------------------------------------------------------
  async function verifyRound(fairness) {
    if (!fairness || !fairness.serverSeed || !fairness.serverSeedHash || !fairness.entropyHash || fairness.crashMultiplier == null) {
      return { ok: false, reason: "missing" };
    }
    const recomputedHash = await sha256Hex(fairness.serverSeed);
    if (recomputedHash !== fairness.serverSeedHash) {
      return { ok: false, reason: "seed_hash_mismatch" };
    }
    const message = `VECTOR:${fairness.roundId}:${fairness.publicRandomness}`;
    const recomputedEntropy = await hmacSha256Hex(fairness.serverSeed, message);
    if (recomputedEntropy !== fairness.entropyHash) {
      return { ok: false, reason: "entropy_mismatch" };
    }
    const recomputedCrash = crashFromEntropyHex(recomputedEntropy);
    if (Math.abs(recomputedCrash - fairness.crashMultiplier) > 1e-9) {
      return { ok: false, reason: "crash_mismatch" };
    }
    return { ok: true, reason: "verified" };
  }

  global.VectorRoundProvider = {
    RTP,
    HOUSE_EDGE,
    CALCULATION_VERSION,
    MAX_VISIBLE_MULTIPLIER,
    DEMO_MODE_DISCLAIMER,
    sha256Hex,
    hmacSha256Hex,
    randomHex,
    crashFromEntropyHex,
    verifyRound,
    LocalDemoAdapter,
    ServerAdapter,
  };
})(typeof window !== "undefined" ? window : globalThis);
