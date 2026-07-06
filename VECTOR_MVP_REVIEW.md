# VECTOR — MVP Launch Readiness Review

Scope: `FEATURE_FLEET_TABLE = false` (plain NPC-list MVP). Originally a full read-through of `index.html`, `styles.css`, `script.js`; updated after a fix pass addressing everything that was actually fixable in front-end code.

Status key: ✅ **Fixed**, 🟡 **Partially addressed / needs verification**, ⬜ **Still open — needs infra, hardware, or a decision I can't make alone**.

---

## 1. Dead / non-functional controls

- ✅ **Settings icon** now opens a real popover: a Reduce Motion toggle (independent of the OS setting) and a Reset Balance action.
- ✅ **Sound toggle** is wired to a real procedural sound layer (Web Audio oscillators/noise, no external audio files) — bet placed, cash out, Overdrive activation, and crash all have distinct cues.

## 2. Betting & economy edge cases

- ✅ **Balance floor recovery** — Reset Balance is available both in Settings (anytime) and as an inline banner that appears automatically once balance drops below the minimum bet.
- ✅ **Insufficient balance messaging** — inline "Insufficient balance" hint now appears under the bet field instead of just a silently disabled button.
- ✅ **Bet input clamping** — `max="500"` added; existing blur-clamp behavior kept.
- ✅ **Auto-cashout ceiling** — clamped to the same cap the crash curve itself uses (1000x), plus a `max` attribute.
- 🟡 **No persistence across reloads** — confirmed intentional for a demo; flagging again only so it's a conscious choice, not a surprise.

## 3. Onboarding & discoverability

- ✅ **How-to-Play modal** — explains Cruise, Overdrive (the one genuinely novel mechanic), cashout, and keyboard shortcuts. Shows automatically once per session and is reachable anytime via the new "?" button next to the logo.
- ✅ **Keyboard shortcuts** are now documented in that modal (Space, O).
- ✅ **Demo disclaimer** — added as a persistent footer line, plus repeated in the modal.

## 4. Fairness & trust

- ✅ **Provably Fair popover copy updated** to explicitly state this is a client-side simulation, not yet backed by a real server commit-reveal — so the claim can't be misread as real.
- ⬜ **A real commit-reveal flow** (server generates + hashes the seed before betting closes, reveals after) is still a backend project, not something fixable in this front-end pass.

## 5. Accessibility

- ✅ **Multiplier `aria-live` tightened** — the ticking number is now `aria-live="off"`; a separate sparse, visually-hidden region announces only discrete milestones (bet placed, cashed out at X, collapsed at X).
- ✅ **Contrast audit run** — computed real WCAG contrast ratios for every text/background pairing in use. Found and fixed one real failure: `--text-tertiary` only cleared 3.2-3.7:1 (needs 4.5:1) at the small sizes it's actually used at (9-12.5px). Brightened it to `#7a8490`, which clears 4.5:1+ against every background it appears on. Everything else already passed.
- ✅ **Touch target sizing** — bumped stepper buttons, chips, and icon buttons to a 44px minimum in the mobile breakpoint.
- ✅ **Modal/popover focus handling** — How-to-Play modal moves focus in on open and restores it on close; Escape closes any open modal/popover.

## 6. Mobile / responsive

- ✅ **Safe-area insets added** — `env(safe-area-inset-*)` padding on the header, betting panel, and footer for notched devices, matching the `viewport-fit=cover` meta tag that was already set but previously had no corresponding padding.
- ⬜ **Real device testing** — I can verify CSS logic and computed contrast/sizing programmatically, but actual behavior on iOS Safari / Android Chrome (rendering quirks, real touch response, real notch geometry) still needs a physical device pass. Nothing further to fix without one.

## 7. Performance

- ⬜ **Frame-rate profiling on lower-end hardware** — unchanged from the original review. This needs real or throttled hardware to measure, not more front-end code. Flagging that it's still open rather than silently dropping it.

## 8. Technical / production readiness

- ✅ **Committed regression test** — `_domtest.js` is now a real pass/fail smoke test (`node _domtest.js`), not a throwaway script: boots the real `script.js` headlessly, drives a full bet → cash-out → running cycle, and asserts on frame stability, live-bets population, balance sanity, and NPC pool size. Exits non-zero on failure. Re-run this after any future change.
- ✅ **Favicon added** (inline SVG, no extra file).
- ⬜ **No backend** — balance/RNG/history remain 100% client-state by design for this prototype. This is the correct state for a demo; it's the dividing line between "MVP ready to launch as a demo" and "ready to launch as a real-money product," and no amount of front-end polish closes that gap.
- ⬜ **Error monitoring / analytics** — still not present; needs a decision on which provider before wiring anything.
- ⬜ **Browser compatibility matrix** (Safari/Firefox) — still only reasoned about, not explicitly verified on those engines.

## 9. Previously open item — now addressed defensively

- ✅ The Live Bets "sometimes empty" issue: the regression test above directly asserts the live bets list is non-empty after a full simulated round, and the defensive hardening from the previous pass (DOM-rebuild rendering, per-row error isolation, self-healing regeneration, redundant `setInterval` render path) remains in place. I still never got a confirmed real-browser root cause — if it recurs, the browser console will now show exactly what's failing, and the regression test gives a fast way to confirm whether it's a real logic bug versus something environment-specific.

---

## What's left, honestly

Everything marked ⬜ above requires something I don't have in this session: a real device, real browser telemetry, a hosting/backend decision, or a monitoring-provider choice. Everything that was fixable by writing better front-end code has been fixed and verified (`node --check` + the full regression suite, both green).
