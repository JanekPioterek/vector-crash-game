# VECTOR-PF-v1 — Provably Fair Rework: Final Deliverables

This is the mathematical/technical rework of VECTOR's crash engine to a real, verifiable
provably-fair implementation (calculation version `VECTOR-PF-v1`). Visual design, gameplay
loop, Bank Half mechanic UI, motion, and layout are unchanged — this was a maths/engine
rework, not a redesign.

## 1. Modified / added files

- **`roundProvider.js`** (new) — the entire provably-fair engine: SHA-256/HMAC-SHA256 via
  Web Crypto, the crash formula, `LocalDemoAdapter` (real crypto, runs in-browser),
  `ServerAdapter` (production stub), and `verifyRound()`.
- **`script.js`** — round generation rewired to an async commit (`generateRound()`) /
  reveal (`triggerCrash()`'s `revealRound()` call) flow against `roundProvider.js`;
  `state.roundCommitReady` gates the COUNTDOWN→RUNNING transition; cosmetic randomness
  (NPCs, background nebulae/pulsar) split out into its own `state.cosmeticRng`
  (Math.random()-seeded, never touches the crash multiplier); `renderFairPopover()`,
  fairness/history verification wiring, and `pushHistory()` now attaches each round's
  `fairness` snapshot to its history entry.
- **`index.html`** — old fake fairness badge/popover replaced with the real one: RTP/House
  Edge/Calculation summary, "This round" (Round ID, Server Seed Hash, editable Public
  Randomness, Crash Result withheld until reveal), "After round settlement" (Server Seed,
  Entropy Hash), a Verify Round button, and the demo-mode disclosure. Badge text is exactly
  **"98% RTP · Provably Fair"**, placed in a metadata row below the game canvas, not inside
  the betting controls.
- **`styles.css`** — styling for the rebuilt fairness popover, the editable randomness
  field, verify-status states, and a compact per-history-row verify affordance.
- **`_domtest.js`** — updated to inject Node's Web Crypto (`require("crypto").webcrypto`)
  and to yield to the event loop between simulated frames (`await setTimeout(...,0)`), since
  `commitRound()`/`revealRound()` are now genuine async Promises that need real ticks to
  resolve. Added two assertions confirming a round actually commits real fairness data.
- **`fairness_test.js`** (new) — standalone provably-fair test suite (below).

## 2. RTP and crash formula

```
RTP = 0.98            // 98.00% return to player
HOUSE_EDGE = 0.02      // 2.00%
CALCULATION_VERSION = "VECTOR-PF-v1"
```

Crash multiplier derivation, given the round's final entropy hash (hex):

1. Take the first 13 hex characters (52 bits) of the entropy hash.
2. `u = intVal / 2^52` → uniform on `[0, 1)`.
3. `rawMultiplier = RTP / (1 - u)`.
4. Floor to 2 decimals (never rounds up — the house edge is never given away by rounding).
5. Clamp to `[1.00, MAX_VISIBLE_MULTIPLIER]` (1000).

This single expression reproduces the required survival curve `P(crash ≥ X) = RTP / X`
for every `X ≥ 1`, with no separate branch for the "instant crash" case — it's just this
same formula's own left tail (`raw < 1` whenever `u < 1 − RTP = 0.02`).

Round flow (commit-reveal): generate a 256-bit server seed → publish `SHA-256(serverSeed)`
before betting opens → lock bets at round start → compute
`HMAC-SHA256(serverSeed, "VECTOR:" + roundId + ":" + publicRandomness)` as the entropy →
derive the crash multiplier from that entropy → reveal `serverSeed` (and therefore the
entropy hash, and the multiplier) only after the round settles → anyone can recompute every
step and confirm the result matches what was committed before their bet was locked in.

## 3. Probability table (verified via 200,000-round Monte Carlo in `fairness_test.js`)

| Threshold | Required (RTP/X) | Observed (repeated runs) |
|---|---|---|
| ≥ 1.25x | 78.40% | ~78.2–78.5% |
| ≥ 2.00x | 49.00% | ~48.8–49.0% |
| ≥ 5.00x | 19.60% | ~19.5–19.7% |
| ≥ 10.00x | 9.80% | ~9.7–9.9% |

One nuance worth flagging: the *displayed* 1.00x bucket occurs slightly more often
(~2.97%) than the bare house edge (2.00%), because flooring to 2 decimals folds every raw
value in `[1.00, 1.01)` into the same "1.00x" display value, not just genuine sub-1.00
draws — and since the in-game multiplier curve itself starts at exactly 1.00x, both cases
are an identical instant crash to the player either way. This doesn't affect the ≥X survival
probabilities above, which match the spec exactly.

## 4. Bank Half settlement

```
lockedPayout   = (originalStake / 2) × M       (M = multiplier at time of use)
remainingStake = originalStake / 2
```

Worked example ($10 stake, Bank Half at 2.00x, remainder cashed at 4.00x):

- Locked: $10 stake / 2 = $5 at risk banked → payout `$5 × 2.00 = $10`.
- Remaining $5 rides on; cashed later at 4.00x → payout `$5 × 4.00 = $20`.
- Total returned: `$10 + $20 = $30` on a $10 stake (net +$20).
- If the remainder crashes before a second cash-out instead: final payout stays at the
  $10 already banked (net $0 on the $10 stake).

Enforced: one use per bet (`state.bet.partials.length > 0` blocks a second call, and the
button hides itself immediately after use); recorded as a single bet with two settlement
legs (`partials[]` + the final `cashOut`/crash leg), both folding into one `finalNet`; no
new randomness or RTP is introduced — Bank Half only re-slices the *existing* committed
crash multiplier, it never calls `commitRound()` again (verified directly in
`fairness_test.js`: `state.fairness.crashMultiplier`/`entropyHash` are bit-identical before
and after a Bank Half use).

## 5. Test coverage (`fairness_test.js`, 23/23 passing, stable across repeated runs)

**Part A — pure crypto/maths against `roundProvider.js`:** determinism, seed-hash
verification, tamper detection at the server-seed layer / public-randomness layer / crash-
result layer, missing-data handling, the 1.00x instant-crash tail, and the full ≥1.25x/2x/
5x/10x probability table.

**Part B — game integration against the real `script.js`** in a headless DOM stub (forced,
deterministic crash points and clock jumps to hit exact multipliers): exact 2.00x cashout
payout math, auto cash-out firing at the armed target, no cash-out possible after a crash,
Bank Half payout correctness, Bank Half one-use enforcement, Bank Half creating no new
randomness, a full Bank Half + second-cashout total, Bank-Half-then-crash keeping only the
banked amount, one shared crash result read by every NPC and the player alike, and result
immutability (the committed crash multiplier is bit-identical from commit through
settlement/history).

Run with `node fairness_test.js` (or `node _domtest.js` for the general game-loop smoke
test, 10/10 passing).

## 6. Production backend requirements (not built here — adapter boundary only)

`roundProvider.js` exposes `LocalDemoAdapter` (used today) and a stubbed `ServerAdapter`
behind the same interface, so swapping to production requires **no changes in `script.js`**.
A real backend needs:

- `POST /rounds/commit` — generates and stores a 256-bit server seed **server-side only**,
  returns `{ roundId, serverSeedHash, publicRandomness, entropyHash, crashMultiplier }`
  (never the raw seed). Runs before betting opens.
- `POST /rounds/:id/lock` (or implicit on round start) — bets become immutable.
- `GET /rounds/:id/reveal` — returns `{ roundId, serverSeed }` only once that round has
  genuinely settled server-side.
- Server-side storage of every round's seed/hash/randomness/entropy/crash result for
  audit/dispute resolution.
- Rate limiting / auth on the commit endpoint so client-submitted `publicRandomness`
  can't be used to grief round timing.
- Ideally: a published, append-only log of settled rounds (seed + hash + result) so players
  can verify historical rounds without trusting the operator's live API.

## 7. Manual QA checklist

- Badge reads exactly "98% RTP · Provably Fair", sits in the metadata row below the canvas
  (not inside betting controls), and opens/closes the popover on click and outside-click.
- Popover's "This round" section populates Round ID and Server Seed Hash immediately at
  countdown start; Crash Result stays "Pending — locked in" until the round actually
  settles, even though the value was fixed at commit time.
- Editing the Public Randomness field and clicking regenerate takes effect starting the
  *next* round (current round's commitment can't retroactively change) — hint text confirms
  this.
- After a crash, "After round settlement" reveals Server Seed and Entropy Hash, and Verify
  Round becomes clickable and reports "Verified".
- Each history row's Verify link independently re-checks that row's own snapshot and
  reports Verified / Seed hash mismatch / Entropy mismatch / Crash result mismatch /
  Missing fairness data as appropriate.
- Bank Half button disappears immediately after one use per bet; banked amount and
  remaining live stake both display correctly; final settlement (win, loss, or Bank-
  Half-then-crash) matches the worked formula above.
- Auto cash-out still fires exactly at the armed target; manual cash-out disabled/no-op
  once a bet is resolved (win or crash).
- No regressions in animation, sound, history list, responsive layout, or the background
  speed-multiplier coupling from the prior session.

## 8. Demo-mode limitations (must not be oversold)

`LocalDemoAdapter` runs entirely in the player's own browser tab — real Web Crypto, real
SHA-256/HMAC-SHA256 maths, byte-for-byte the same formula a production backend would run —
but the "server" seed is generated and held client-side, not on an actual server nobody else
can see. There is nothing genuinely secret from a determined user of that same browser
session. This is disclosed directly in the UI (`fair-demo-note` under the popover) and in
`roundProvider.js`'s own `DEMO_MODE_DISCLAIMER` string. It is **not** described anywhere as
audited, licensed, certified, or regulator-approved — only as a faithful implementation of
the commit-reveal maths, pending a real backend swap via the `ServerAdapter` seam.
