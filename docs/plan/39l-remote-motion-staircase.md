# M39l: A remote player's circle moves every frame, and the fade check tests what ADR 0013 allows

Status: done (2026-10-06) · After: 39k · Tyler-dependent: no

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
- [x] The cause is named with the step 1 table in Deviations.
- [x] The walk-ref motion spec asserts ratio >= 0.9 and max still <= 50 ms in Chromium and WebKit, was seen red before the fix, and is green after it (pasted `pnpm test:slow browser -t walk-ref` line).
- [x] The viewer-stall fade test and the `analyseMotion` / `analyseFade` unit tests exist, pass, and were seen red.
- [x] No golden, budget or baseline changed. `[gc]` multiplayer pages stay within budget.
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test:slow browser -t walk-ref` · `pnpm test netcode -t interp` · `node --test scripts/lib/device-walk-checks.test.mjs` (targeted, foreground).

## Manual device checks
After landing, the orchestrator re-runs M34-remote-motion driven on both phones.

## Deviations
**Diagnosis** (orchestrator, from the read-only agent, 2026-10-06): the series has plateaus of exactly 5-7 frames (83-118 ms), then a jump; the 2.0 and 2.11 jumps are one late or lost sample. The first jump is at +1.1 s, 0.73 tiles: not a join teleport. `analyseMotion` (checks.mjs ~1741): snap = jump > 0.25 tiles and > 4x the median of the 5 jumps either side. Smooth motion scores 0, so all 46 are staircase steps. Fade: `fadeFrames` alpha 255 until t=12595 ms and absent from 12612. The host sends `PresenceRelayOp::Gone` (host/mod.rs ~2243); the client calls `apply_presence_gone`, which calls `buffer.remove`. `refresh_presence` re-relays held samples at >= 1 Hz, so a connected silent remote never fades.

**Step 1 measurement (loopback Chromium, `walk-ref` M34 motion collect, temporary instrumentation reverted).** Per rAF: DrawList `frame_seq` (header offset 0) and `frame_time_ms` (offset 96), the own circle, and, through a temporary change of `FrameView::presences` and the reference `extract` that encoded them into a second circle, the interp `render_t` and the newest sample's tick. Result over 567 frames: `frame_seq` changed on 490 of them (about 15 % repeat: a worker wake without a new publish, not a stale slot), the remote position on 56, the own circle on 22 (settled). The remote's `vel` was constant across a plateau and nonzero, so not Hold (which zeroes it) and not extrapolation (which would move `pos`).

**Cause: `render_t` is about 345 host ticks (17 s) behind the newest sample, so `InterpBuffer::sample` takes the `render_t <= oldest.t` branch and returns the oldest of the 8 held samples, which changes whenever a new sample pushes the ring.** `ClientCore::tick_fraction` feeds `HostClock::on_frame(replica.tick(), local_ms)` on the first rAFs, when the replica tick is still 0, and `on_frame` seeds `effective_offset` from that first sample ("initialization, not a step"). When the host's real tick (378, a world already 19 s old) arrives, the target offset jumps by `tick * tick_ms`, and `advance` slews toward it at the 10 % dilation limit: the lag closes by 10 % of elapsed time only (measured: lag 347.3 ticks at the first frame, 333.0 at +6.7 s, `render_t` advancing 0.367 tick per 16.7 ms frame instead of 0.333). `rebase()` is called only on resync or tab return (`rebase_interp`), never on the first frame. A client that joins a world that has run for a day would lag by a tenth of that for ten times as long. The netcode suite never saw it: its observers join at tick 0.

| t (ms) | frame_seq | remote x (tiles) | render_t (ticks) | newest sample tick | lag (ticks) |
|---|---|---|---|---|---|
| 1823 | 107 | 1.098 | 33.76 | 378 | 344.2 |
| 1839 | 109 | 2.445 (jump) | 34.50 | 380 | 345.5 |
| 1856 | 109 | 2.445 | 34.50 | 380 | 345.5 |
| 1874 | 110 | 2.445 | 34.86 | 380 | 345.1 |
| 1890 | 111 | 2.445 | 35.23 | 380 | 344.8 |
| 1906 | 112 | 2.445 | 35.60 | 380 | 344.4 |
| 1923 | 113 | 2.445 | 35.96 | 380 | 344.0 |
| 1940 | 115 | 2.445 | 36.70 | 380 | 343.3 |
| 1957 | 115 | 2.445 | 36.70 | 380 | 343.3 |
| 1973 | 117 | 3.68 (jump) | 37.43 | 383 | 345.6 |

Guesses (i) Hold, (ii) stale slot, (iii) skipped frames: none; `sample()` units are right. A harness scenario that adds the observer after the host has run 400 ticks reproduces it (step 2).

**Fix (step 3).** `ClientCore` got `host_clock_primed` (`client/core.rs`): in `tick_fraction`, after `HostClock::on_frame`, the first time `replica.tick() > 0` it sets `rebase_pending`, so the clock snaps once to its target (the existing `rebase()` path of a resync) instead of slewing `tick x tick_ms` at 10 %. No change to the delay, the extrapolation cap or `HostClock`/`InterpBuffer` themselves, so no ADR 0012/0040 behaviour changes. Before/after, same walk-ref motion collect: `moving_frames_changed_ratio` 0.152 (Chromium) and 0.152 (WebKit) red, then 1 / 0.996, `max_still_ms` 0 / 16, `snaps` 46 (iPhone m39j) and 32 (M39f loopback) down to 2 / 4. Netcode `interpolation/late_joiner_remote_moves_every_frame`: red `expected 0.167 to be greater than or equal to 0.9`, green after.

**Seams and shapes added.**
- `engine/test` `drawListSeq(client): number` (`src/test/client.ts`, exported from `src/test.ts`): the `frame_seq` of the slot the last `drawListRecords` acquired, no new acquire.
- `NetHarness.onFrame: (() => void) | null` (`src/test/net-harness.ts`): called after every client frame inside `advanceTicks`.
- Check reporter frame record is now `{ t, circles, seq }`; `collect-ref.js` `motionFrames` rows are `[t, x, y, seq]`; `analyseMotion` also reads three-column rows (the m39j fixture).
- `analyseMotion` returns `movingFramesChangedRatio`, `maxStillMs`, `repeatedFrames`; `analyseFade` returns `vanishMs`. Metrics `moving_frames_changed_ratio`, `max_still_ms`, `repeated_frames`, `vanish_ms`, `fade_missing`; criteria `moving_frames_changed_ratio >= 0.9`, `max_still_ms <= 50`, `vanished_at_once <= 1000`. A pair is "while moving" when the circle covered at least 1 tile over the 15 frames either side. `fade_missing` is no longer a criterion.
- Fixture `scripts/lib/fixtures/m39j-remote-motion-frames.json` (the real iPhone series; ratio 0.153, max still 167 ms, snaps 46).
- New spec `packages/engine/tests/browser/remote-fade.spec.ts` (`@slow`, Chromium; page `gc-multiplayer-topology.html` behind a TCP proxy whose server-to-client direction is held for 2.6 s while host and remote tick in lockstep with the page's injected clock; 2.6 s is under `DEAD_MS` 3000). Red with `SILENCE_LIMIT_MS = 2.0e9`: `alpha per frame over the stall: 1 1 1 ... Expected: < 1, Received: 1`. Not the CDP `emulateNetworkConditions` of the brief: a proxy keeps the link up and the stall exact.

**Differences from the brief.**
1. **The ratio is over frames with a new DrawList.** After the fix the Chromium series still had about 14 % of rAFs that read the same `frame_seq` as the frame before (`repeated_frames` 44 of 568 Chromium, 54 of 562 WebKit: a rAF that came before the client worker's next publish, 15 % in the first measurement too), and on those the position cannot change; counting them gave 0.76 / 0.82 in both engines even though the interpolation was right. So `analyseMotion` leaves a pair out of the ratio when both frames carry the same `seq` and reports it as `repeated_frames`; rows without a `seq` still count every frame. `max_still_ms` is not filtered. This is a frame-pipeline jitter (worker publish vs rAF) that nobody has charged; on the phone it shows as `repeated_frames`, judge from there.
2. `vanish_ms` is the first absent frame's time minus the first frame of the fade series (the collector starts the series when it tells the bot to leave), not "last drawn to first absent" (that is always one frame). Measured 183 / 116 ms.
3. `device-checks.md` M34-remote-motion: Pass rewritten (limits 0.9, 50 ms, 1000 ms; "close the Mac's page" in Steps since the bot closes its page, "fades per 0012" out), hash `f469a332` -> `04ed618a`; judge row text `'no snap, it disappears'`. The criterion refs are `pass` because `device-walk-checks.test.mjs` requires a numeric limit with ref `pass` to appear in the Pass text.
4. **Existing test assertions changed** (`scripts/lib/device-walk-ref.test.mjs`, the M34 `evaluate` test): the expected criteria list gained the three new names and lost `fade_missing`, and the block that asserted a never-fading circle gives `ok: null` / verdict `judge` is replaced by the vanish cases (`vanished_at_once` ok at 1000 ms, fails at 1017 ms and when the circle never goes). Nothing weakened or skipped; the orchestrator should look at those lines.
5. Unit tests are vitest in `scripts/lib/device-walk-ref.test.mjs` (`pnpm test unit -t "device-walk"`, 189 pass), not `node --test device-walk-checks.test.mjs` (the brief's verification line names a runner these files do not use).

**Not verified / notes.** A late-joining client previously lagged by (host tick x 50 ms) / 10 for the whole session (about 17 s lag at a 19 s world; a day-old world would not have converged in the first hour): this also touched `tick_fraction` consumers other than interpolation, whose own tests pass. Phones not run. `pnpm test` / `pnpm lint` in full left to the orchestrator.
- **Gate (orchestrator):** `pnpm test && pnpm lint` green (rust 801, unit 586, wasm 172, netcode 147, browser 256 in 44 s of 48). Inject-fail-revert re-run by the orchestrator: the `host_clock_primed` branch disabled -> `interpolation/late_joiner_remote_moves_every_frame` red (`expected 0.167 to be >= 0.9`), reverted. Existing-test edits in `device-walk-ref.test.mjs` (the never-fading judge case replaced by vanish cases) accepted: they follow ADR 0013. Untracked: about 14 % of rAFs re-read the previous `frame_seq` (worker publish jitter), excluded from the ratio as `repeated_frames`; not charged here.
