# M39l: A remote player's circle moves every frame, and the fade check tests what ADR 0013 allows

Status: not started · After: 39k · Tyler-dependent: no

## Goal
Finding 4a of the driven rounds (`m39j-full-ios`, iPhone 12, evidence `test-results/device-walk/m39j-full-ios/M34-remote-motion-1.json`): `snaps` 46, `fade_missing` 1. A read-only diagnosis (2026-10-06, full text copied under Deviations › Diagnosis) found two separate things:

1. **The drawn remote circle is a staircase, not a tunnel artefact.** Of 695 frames at a steady ~17 ms, the position changes on 78. It holds for 5-7 frames (about 100 ms, the presence sample interval) and then jumps 0.7-1.3 tiles. M39f already saw the same on loopback in desktop Chromium and WebKit (`docs/plan/39f-device-auto-runner.md`, "Measured": "drawn at each presence sample about every 6 frames"), and nobody charged it. By design (ADR 0012 "Remote motion", ADR 0040) the position is a Hermite sample at `host_time - delay` (`interp/buffer.rs` `sample()`), advancing every frame (`client/core.rs` `step_interp`). The root cause is **not identified**. Guesses, in order: (i) `render_t` runs more than 250 ms past the newest sample, so the buffer sits in Hold with velocity zeroed; (ii) the check's `drawListSlot.acquire()` in `games/reference/src/check.ts` (shared with the frame loop's `pick.acquire()`) reads a stale slot (a check artefact); (iii) the worker's `frame()` doesn't run every rAF. `tests/netcode/interpolation.test.ts` samples once per host tick at 2.8 tiles/s, so nothing tests between ticks (the bot moves at about 13 tiles/s).
2. **The fade criterion tests something the product never does on a clean close.** ADR 0013 says presence vanishes at once on disconnect (the host sends `Gone`). The 2 s fade of ADR 0012 only happens when the *viewer's* link stalls. The circle vanished 17 ms after the bot closed its page: correct.

When this is done the cause is measured and named, the remote circle changes position on at least 90 % of frames while it moves, a slow-tier test fails on the staircase, and the M34-remote-motion item checks vanish-on-leave plus a viewer-stall fade.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0012-*.md` ("Remote motion") and `docs/decisions/0040-*.md` (adaptive delay)
3. `docs/plan/39f-device-auto-runner.md` Deviations (walk-ref specs, `analyseMotion` / `analyseFade`, `check.ts` records)
Rules: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md` (if `interp/` changes).

## Order of work
1. **Measure first (no fix yet).** Run one loopback M34 motion collect (`walk-ref` M34 motion test, Chromium). Record, per rAF: the DrawList header `frame_seq` and `frame_time_ms`, the remote's Interp mode, `render_t` minus the newest sample's `t`, the interp delay, and the own circle's position. Use a temporary debug recording or a permanent check-only field; the `dist-bench` absence rules still hold. Put a table in Deviations, one plateau and its jump frame by frame. Name the cause from it: Hold, a stale slot, a skipped `frame()`, or a bug in `sample()` units. Commit `M39l step 1: measurement`.
2. **Failable test before the fix.** Extend the walk-ref M34 motion spec (slow tier, both engines) to assert `moving_frames_changed_ratio >= 0.9` and `max_still_ms <= 50` while the remote moves. If the cause is in `interp/` or `client/core.rs`, also add a `netcode` (or Rust unit) test that samples the remote between ticks at frame steps of 16.7 ms and speed about 12 tiles/s, and asserts that the position changes every frame within `2 x speed x dt`. Paste each red line.
3. **Fix** at the cause found in step 1. If the cause is in the check (a stale slot), the fix is in `check.ts`, and step 2's spec still has to fail without it. A fix that changes ADR 0012/0040 behaviour (delay, extrapolation limit) is a decision: stop and report.
4. **Metrics** (`scripts/lib/device-walk/checks.mjs` `analyseMotion`): add `moving_frames_changed_ratio` and `max_still_ms` as criteria (limits as in step 2). Keep `snaps` as a metric. Test with a synthetic smooth 60 Hz series at 12 tiles/s (passes) and the real m39j series as a fixture (fails: ratio about 0.11).
5. **Fade item.** `analyseFade` reports `vanish_ms` (last drawn frame to the first absent one after the bot leaves); criterion `vanished_at_once` <= 1000 ms; `fade_missing` becomes a metric. In `device-checks.md` M34-remote-motion's Pass says "it disappears within 1 s when the other player leaves". The viewer-stall fade gets its own slow-tier browser test: the viewer goes offline for 2.7 s by CDP `Network.emulateNetworkConditions` or by killing the ws proxy; per-frame alpha has min < 255, and the circle returns at full alpha after reconnect. Red with `SILENCE_LIMIT_MS` made huge. Update the Pass hash.

## Non-scope
The two-devices join (M39n), interp delay constants, the bot's speed, any fast-tier browser test (the `browser` budget has no headroom: ADR 0036).

## Files touched
`packages/engine/crates/engine/src/{interp,client}/` if the cause is there; `packages/engine/src/` worker or frame-loop if it is there; `games/reference/src/check.ts`; `packages/engine/tests/browser/walk-ref.spec.ts` (+ a fade spec); `packages/engine/tests/netcode/interpolation.test.ts`; `scripts/lib/device-walk/{checks.mjs,agent/collect-ref.js}` and tests; `docs/plan/device-checks.md` (M34-remote-motion line only).

## Exit criteria
- [ ] The cause is named with the step 1 table in Deviations.
- [ ] The walk-ref motion spec asserts ratio >= 0.9 and max still <= 50 ms in Chromium and WebKit, was seen red before the fix, and is green after it (pasted `pnpm test:slow browser -t walk-ref` line).
- [ ] The viewer-stall fade test and the `analyseMotion` / `analyseFade` unit tests exist, pass, and were seen red.
- [ ] No golden, budget or baseline changed. `[gc]` multiplayer pages stay within budget.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test:slow browser -t walk-ref` · `pnpm test netcode -t interp` · `node --test scripts/lib/device-walk-checks.test.mjs` (targeted, foreground).

## Manual device checks
After landing, the orchestrator re-runs M34-remote-motion driven on both phones.

## Deviations
**Diagnosis** (orchestrator, from the read-only agent, 2026-10-06): the series has plateaus of exactly 5-7 frames (83-118 ms), then a jump; the 2.0 and 2.11 jumps are one late or lost sample. The first jump is at +1.1 s, 0.73 tiles: not a join teleport. `analyseMotion` (checks.mjs ~1741): snap = jump > 0.25 tiles and > 4x the median of the 5 jumps either side. Smooth motion scores 0, so all 46 are staircase steps. Fade: `fadeFrames` alpha 255 until t=12595 ms and absent from 12612. The host sends `PresenceRelayOp::Gone` (host/mod.rs ~2243); the client calls `apply_presence_gone`, which calls `buffer.remove`. `refresh_presence` re-relays held samples at >= 1 Hz, so a connected silent remote never fades.
