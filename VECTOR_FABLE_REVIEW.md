# VECTOR — Fable Design Pass (Audit + Final Summary)

Scope: focused refinement pass on the existing MVP (`FEATURE_FLEET_TABLE = false`), per brief. Core concept, probability model, crash-curve distribution, and provably-fair simulation untouched. Verified with `node --check script.js`, the committed regression suite (`node _domtest.js` — 8/8), and a targeted throwaway harness for the new paths (17/17, not committed).

---

## Part 1 — Audit: 10 highest-impact issues, ranked

### 1. Missing a round means dead time with no re-entry path
- **Problem:** If you don't bet inside the 3s countdown, the button reads "NO ACTIVE BET" (disabled) and you spectate the whole round — which at growth 0.1/s can easily run 30-60s+.
- **Why it matters:** This is the biggest pacing killer in any crash game; every commercial title solves it with a next-round bet queue.
- **Recommended improvement:** "Bet Next Round" queue during flight, auto-placed at the next countdown, cancellable any time, nothing deducted until conversion.
- **Expected player impact:** Large — more rounds per session, no punished spectating, core loop feels responsive.
- **Effort:** Small-medium. **→ Implemented.**

### 2. Auto-cashout payout imprecision + a real frame-race loss bug
- **Problem:** Auto-cashout fired at whatever multiplier the frame happened to compute (overpaying vs the label), and the crash check ran *before* the auto check — so a single frame jumping past both the target and the crash point lost a bet that mathematically should have paid. At high multipliers one 16ms frame can jump 0.1x+, so this was not theoretical.
- **Why it matters:** "Auto cashout 2.00x" must pay exactly 2.00x whenever crash > 2.00x. Payout-logic correctness is non-negotiable in a casino product.
- **Recommended improvement:** Settle auto-cashout at exactly the target, whenever `target < crashPoint`, independent of frame stepping.
- **Expected player impact:** Payouts match the label to the cent; no unfair losses.
- **Effort:** Small. **→ Implemented** (verified by a dedicated test that leaps 30s in one frame).

### 3. House edge / RTP surfaced nowhere (the brief's explicit trust question)
- **Problem:** The game has a fixed, honest edge (4% instant-bust share × the 0.99 curve factor → RTP ≈ 95.0%) but the UI never says so.
- **Why it matters:** A crash game's honest pitch *is* its flat, identical-every-round RTP. My position: yes, it should be surfaced — in the Provably Fair popover as the precise figure (that's where players who care about the maths already look), and in How-to-Play as one plain-language sentence (which, unlike the fair badge, is reachable on mobile where the badge is hidden). Not on the main HUD — a permanent "-5%" label on the stage is noise, not trust.
- **Recommended improvement:** "House Edge: 5.0% (RTP 95.0%)" row computed live from CONFIG so the display can never drift from the actual maths; RTP sentence in the modal; reveal the raw seed in the popover after each round to complete the commit-reveal shape the copy already honestly describes.
- **Expected player impact:** Differentiating trust signal; zero manipulation surface.
- **Effort:** Small. **→ Implemented.**

### 4. Round history invisible at the decision moment
- **Problem:** Past crash points live in a side-panel tab; on mobile it's below the fold.
- **Why it matters:** Scanning recent outcomes is the core anticipation ritual of the genre and feeds the bet/no-bet decision.
- **Recommended improvement:** Slim ribbon of the last 10 crash chips between stage and betting panel, tier-coloured, newest first with a one-shot pop. (Paired with the RTP disclosure above so it reads as information, not gambler's-fallacy bait.)
- **Expected player impact:** Faster decisions, more anticipation, mobile parity.
- **Effort:** Small. **→ Implemented** (event-driven rebuild only — explicitly avoiding the per-frame-rebuild pattern that caused the old Live Bets bug).

### 5. Win feedback overstates the win; balance never visibly reacts
- **Problem:** The success banner showed "+$23.50" — total return, not the +$13.50 the balance actually moved. And the payout landing in the wallet (the actual reward moment) was silent.
- **Why it matters:** "+total" framing is a soft dark pattern; a mute wallet wastes the best reinforcement beat in the loop.
- **Recommended improvement:** Banner shows "+$13.50 net win"; balance pulses white→green whenever it increases (never on decrease — flashing red at every stake is noise).
- **Expected player impact:** Honest numbers that still land harder than before.
- **Effort:** Small. **→ Implemented.**

### 6. Auto-cashout is invisible in flight
- **Problem:** Once flying, nothing shows auto-cashout is armed or at what value; when it fires, nothing attributes it.
- **Recommended improvement:** "AUTO CASHOUT @ 2.00x" pill under the multiplier while a live bet has auto armed; screen-reader announce says "Auto cashed out…".
- **Expected player impact:** No "why did it cash out?" confusion; the armed state becomes part of the tension.
- **Effort:** Small. **→ Implemented.**

### 7. No session-level accounting (responsible-gambling gap)
- **Problem:** No record of what the player personally wagered or won this session; history rows didn't show whether *you* were even in that round.
- **Why it matters:** The most meaningful RG feature a front-end-only build can ship: honest, always-visible accounting makes loss-chasing visible without nagging.
- **Recommended improvement:** Session line atop the History tab (bets · wagered · net, colour-coded both directions, red included); per-round personal net on history rows; ledger resets with balance reset.
- **Expected player impact:** Trust + self-awareness; also just useful.
- **Effort:** Small. **→ Implemented.**

### 8. Anticipation is flat between the big beats
- **Problem:** Countdown is text-only; a climbing multiplier with money in flight has zero escalating cues between 1.00x and the crash.
- **Recommended improvement:** Depleting progress bar inside the countdown pill (glanceable while eyes are on the bet controls); short rising-pitch pips at 2x/5x/10x/25x/50x/100x, playing *only* while the player's own unresolved bet is flying. Deliberately did **not** add urgency styling to PLACE BET during countdown — that's a nudge, not information.
- **Expected player impact:** Better tension curve with no manipulation.
- **Effort:** Small. **→ Implemented.**

### 9. Small state-clarity polish
- **Problem:** Sound toggle communicated on/off by tint only; loss/reflection moments fine, but the fair popover promised a commit-reveal story it never completed visually.
- **Recommended improvement:** Wave/slash icon states on the sound toggle; "Server Seed — revealed after round" row (covered in #3).
- **Effort:** Small. **→ Implemented.**

### 10. (Discussion only — owner decisions, not implemented)
Replayability depth post-Overdrive: with Overdrive intentionally removed, VECTOR is mechanically a straight crash game — solid, but the only in-round decision is "when". Two flagged opinions, per the ground rules:
- **Fleet table:** it's the cheapest personality win available (fully built and tested), and I'd ultimately ship it on. But I recommend keeping `FEATURE_FLEET_TABLE = false` for *this* pass specifically: this environment has no browser, and enabling a purely visual feature without one visual QA pass is how regressions ship. Flip it on in a session with a real browser and eyes on the canvas.
- **If replayability metrics sag** after launch, the least-complex depth add would be a partial cashout (bank half, ride half) — one decision, no new mode, no timer mechanics. Needs explicit sign-off before anyone builds it; the queue feature shipped in this pass covers the more urgent pacing problem either way.

---

## Part 2 — Final summary

### What changed (and why it improves the game)

1. **"Bet Next Round" queue** (`script.js`: `toggleQueuedBet`, `commitBet`, conversion in `startCountdown`; `state-queued` button style). Kills the genre's worst dead time; queue is cancellable, deducts nothing until the round opens, and re-validates against the live balance at conversion. Players who just lost still get the full result phase as a reflection beat before they can re-enter — an intentional anti-loss-chasing choice.
2. **Exact auto-cashout settlement** (tick loop). Pays precisely the labelled target and can no longer lose a should-have-won bet to frame granularity. This is a payout-consistency bug fix, not a model change — `generateCrashPoint` and the RNG are untouched.
3. **RTP / house edge disclosure + seed reveal** (fair popover, How-to-Play modal). "House Edge: 5.0% (RTP 95.0%)" computed from CONFIG at display time; raw seed revealed post-round; plain-language RTP sentence in the modal so mobile users see it too.
4. **Recent-rounds ribbon** (between stage and betting panel). Last 10 crash points, tier-coloured, newest pops in. Event-driven rebuilds only.
5. **Honest, louder win feedback.** Result banner now shows net win (matches the actual balance delta); balance pulses white→green when a payout lands.
6. **Auto-cashout visibility.** Armed-state pill under the multiplier; "(auto)" attribution in announcements.
7. **Session ledger + personal history.** "This session: N bets · $X wagered · ±$Y net" atop the History tab; your net result on every history row you played; resets with balance reset.
8. **Anticipation micro-beats.** Countdown pill progress bar; rising milestone pips gated on your own live bet and the sound toggle.
9. **Polish:** sound icon on/off states; `role="listitem"` chips; new announces for queue/convert/cancel events.

### What I intentionally did not change
- The probability model, crash-curve distribution, house-edge constant, seeded-RNG round generation, and the disclosed client-side provably-fair simulation — all untouched.
- `FEATURE_FLEET_TABLE` stays `false` (reasoning in audit #10); the code remains intact.
- No Overdrive reintroduction or any equivalent second-mode mechanic (owner decision respected; discussion point flagged in audit #10).
- No urgency styling on the bet button, no near-miss effects, no streak messaging, no re-bet prompt during a loss's result phase — all deliberate anti-dark-pattern choices.
- No persistence/backend/analytics — consciously deferred in the previous review; still the right call for this prototype.
- The visual direction, canvas scene, layout, and colour system — refined around, never redesigned.

### Verification
- `node --check script.js` — clean.
- `node _domtest.js` — **8/8 checks passed** (same count as baseline; no regressions).
- Targeted throwaway harness (same DOM shim) — **17/17**: exact auto-cashout payout and session math; the one-giant-frame race (30s frame crossing 2.00x target and 2.01x crash → still pays exactly 2.00x); queue set/cancel/convert with correct balance and ledger; history `playerNet`; populated ribbon.
- No per-frame list rebuilds introduced anywhere (the pattern behind the old Live Bets bug).

### Three optional future ideas (later version — NOT part of this MVP work)
1. **Partial cashout** — bank a chosen fraction mid-flight and let the rest ride. One extra decision, big depth gain, no new mode; needs owner sign-off per the Overdrive precedent.
2. **Real commit-reveal fairness** — the popover now displays the full hash→reveal shape; backing it with an actual server commit (hash published before betting closes, seed + verification recipe after) is the single biggest trust upgrade available, and it's a backend project by definition.
3. **Optional session guardrails** — building on the new session ledger: a player-set soft stop-loss / time reminder in Settings ("you're -$200 this session — take a break?"). Front-end-only, opt-in, and the natural next responsible-gambling step for a real-money build.

---

## Addendum — all three future ideas implemented (owner-requested follow-up)

Owner asked for all three above to be built. Shipped, within the constraints each idea's own writeup already flagged:

1. **Bank Half (partial cash-out)** — one-time-per-bet button that banks 50% of whatever is still at risk at the current multiplier; the rest keeps flying under identical rules (can still auto-cashout, manual cash-out, or crash). `remainingAmount` is now the field every payout/crash/auto-cashout calculation reads (`amount` stays the untouched original stake for record-keeping). A resolved bet's `finalNet` is computed once at resolution from all partials + the final leg, and every display (main button, result banner, history) reads that single number — including the honest edge case where a partial win outweighs a later crash on the remainder ("COLLAPSED — NET +$X" instead of a misleading "LOST").
2. **Real SHA-256 commit** — `computeSeedHash()` uses `crypto.subtle.digest("SHA-256", ...)` on the real per-round seed, computed before the round starts; the popover shows that digest pre-round and the raw seed post-round, so a player can independently re-hash and verify. Still honestly scoped as client-side only (no server publishing the hash independently) — see the fair-popover note and future idea #2's own caveat, which still applies to what remains.
3. **Session loss-reminder guardrail** — opt-in toggle + dollar threshold in Settings, off by default. Fires at most once per session, and only surfaces at the next countdown — never mid-flight, never on top of a win or loss beat — so it can't feel like a jump-scare or a nag.

**Verification:** `node --check script.js` clean; `node _domtest.js` — 8/8 (unchanged, no regressions); a second targeted throwaway harness against the same DOM shim — 14/14, covering: partial banking math and balance effect, the one-partial cap, full resolution `finalNet` after a partial + manual cash-out, `finalNet` after a partial + crash on the remainder, and the guardrail's deferred-to-countdown timing, one-shot latch, and dismiss behavior.

**Still true from the original writeups, unchanged:** no backend, so the SHA-256 commit is a real digest but not a real third-party-published one; partial cash-out is capped at once per bet by design, not a ladder; the guardrail is a single threshold, not a full RG suite (time-based reminders, deposit limits, etc. remain future work).
