# M39ab: a remote that starts walking after rest is drawn up to a tile behind

Status: not started · After: 39aa · Tyler-dependent: no

## Goal
A read-only diagnosis (2026-10-07, `test-results/m39aa-lurch-diagnosis.md`, not committed) found an engine defect in remote interpolation, `InterpBuffer::sample` (`packages/engine/crates/engine/src/interp/buffer.rs`, about line 187):
- A remote at rest holds one stored sample `a`, which can be seconds old: re-relays at rest are `Duplicate` and only refresh the fade timer.
- When it starts walking, the first new sample `b` arrives with position about at rest and velocity V.
- `render_t` (host time minus the 200-400 ms delay of ADR 0012 "Remote motion") then falls at u ≈ 0.95-0.99 of the very long segment [a, b]. There, the cubic Hermite follows b's tangent, so the circle is drawn at about `b.pos − V·delay`: up to a tile **behind**, in one frame, and it then glides forward.

Every other client sees this for about 250 ms whenever a player who idled for more than about a second starts walking. Driven rounds show it at the first leg after rest: −1.094 tiles (`m39aa-pixel`), −0.454 (`m39u-iphone`), −0.344 (`m39n-pixel-2`). It hid under the snap proxy's floor. When this is done, the drawn position never steps backwards at a rest-to-walk transition, and the M34 instrument judges backward steps instead of missing them.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0012-prediction-and-reconciliation.md` ("Remote motion": the delay, interpolation, extrapolate-then-hold)
3. `docs/plan/39l-remote-motion-staircase.md` Deviations (the remote-motion pipeline, `host_clock_primed`, the per-frame test precedent)
Rules: `.claude/rules/hot-paths.md` (sampling runs per frame: no allocation).

## Order of work
1. **Red test first.** A Rust unit test beside `interp_extrapolates_then_holds`: push a rest sample (t 0, x 0.52, v 0) and, 60 ticks later, a walking sample (x 0.62, v 4 tiles/s). Sweep `render_t` across the segment and assert x is never below the rest x, and monotone. Paste the red line (about −1 tile today). Add a second case: a normal 10 Hz walk with segments of about 100 ms is unchanged, so the fix doesn't flatten ordinary motion. Assert its drawn positions equal the old ones within 1e-6 on a recorded segment.
2. **Fix.** Choose and justify one, then record the choice in Deviations (an ADR only if it changes 0012's stated method):
   - (a) A monotone Hermite: clamp the tangents per Fritsch–Carlson, |h·v| ≤ 3|Δ|.
   - (b) Cap the segment duration that scales the tangents. Treat a segment much longer than the relay interval as starting from a synthetic rest sample at `b.t − interval`.
   - (c) Something better you can show on the tests.
   Determinism: interpolation is client-side drawing, not sim, but keep it deterministic and allocation-free.
3. **A loopback check.** The M34 remote-motion path in a browser test, rest then walk: assert the drawn x never decreases on the first leg. Slow tier (`@slow`): `browser` is at 45-47 of 48 s.
4. **Instrument** (`scripts/lib/device-walk/checks.mjs`):
   - add `max_backstep_tiles` to `analyseMotion`, the largest step against the walk's direction, as a judged criterion: limit 0.05 tiles;
   - in `stepsWhileMoving`, count a pair as moving only when the endpoint displacement over its trailing window is at least 1 tile, so the pre-walk standing frames drop out (the diagnosis replays this: `max_still_ms` 234 → 17).
   Tests in `tools`, red first.

## Non-scope
The delay value and the fade (0012); the bot; other checks.

## Files touched
`packages/engine/crates/engine/src/interp/buffer.rs` and its tests, a browser spec for the loopback check (slow tier), `scripts/lib/device-walk/checks.mjs` and its tests, `docs/plan/device-checks.md` M34-remote-motion **Pass** text only if a new criterion needs it (keep the `pass:` hash in step).

## Exit criteria
- [ ] The rest-to-walk unit test was seen red (line pasted) and passes; the ordinary-walk case is unchanged within 1e-6.
- [ ] The slow loopback check exists and passes.
- [ ] `max_backstep_tiles` and the new moving-window rule exist, with tools tests seen red.
- [ ] `pnpm test rust -t interp`, `pnpm test tools`, `pnpm test:slow browser -t "remote"` green (pasted lines); no golden changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test rust -t interp` · `pnpm test tools` · `pnpm test:slow browser -t "remote"` (targeted, foreground). Loops run in the foreground, bounded, with no background load generators.

## Manual device checks
After landing, the orchestrator re-runs M34-remote-motion driven on the Pixel and, as a frame-pacing item, on the iPhone driverless with Tyler.

## Deviations
- **Fix chosen: (a), monotone Hermite, for stale segments only (fix round 1, see the last bullet).** Originally applied to every segment: `InterpBuffer::sample` (`interp/buffer.rs`) clamps each end's tangent per axis to `|h*v| <= 3*|delta|` (Fritsch-Carlson sufficient condition), so the segment cannot leave its endpoints' span. Chosen over (b) because it needs no relay-interval constant and leaves normal motion bit-identical: a 10 Hz walk at 4 tiles/s has `|h*v|` 0.4 tile against `3*delta` 1.2, no clamp. 0012's method (Hermite, delay, extrapolation) is unchanged, so no ADR. Side effect: the velocity returned across a clamped knot is not C1 (only `pos` drawn); `Interp::vel` of a clamped segment is the clamped derivative.
- **Red lines.** Rust `interp_rest_then_walk_never_draws_behind`: `t 0.7999999999999999: x 132 behind rest 133` (the unclamped curve undershoots early in the segment as well as near `b`). Green with the clamp; `interp_ordinary_walk_matches_unclamped_hermite` compares against an independent unclamped Hermite, equal after rounding. Slow spec `tests/browser/remote-rest-walk.spec.ts` (new; `MovingRemote.stepAt(x, velX)` added to `support/moving-remote.ts`): red with the clamp disabled: `Expected: <= 2, Received: 127` (0.5 tile back, series `133 133 6 45 88 ...`), green with it (7.3 s).
- **`max_backstep_tiles`** (`checks.mjs` `maxBackstep`): per pair, the step projected against the endpoint displacement of the next `BACKSTEP_LOOKAHEAD_FRAMES` = 30 frames (15 is too short: m39u's glide nets under a tile), only when that is >= 1 tile and does not oppose the displacement of the 45 frames before (a turn is not a backstep; without this a 12 tiles/s sine sweep scored 0.066). Replay of the device series: m39aa-pixel 1.094, m39u-iphone 0.454, m39n-pixel-2 0.344 (equal to the diagnosis). Criterion `max_backstep_tiles` <= 0.05 (ref `pass`); M34-remote-motion Pass text extended, hash `04ed618a` -> `50397e61`; added to metrics.
- **`stepsWhileMoving`**: a pair is moving when the net displacement (steps over 3 tiles dropped, as in M39aa, so a 64.000 jump is still a snap and does not count as travel) over the trailing `MOVING_TRAILING_FRAMES` = 45 frames up to the pair's second frame is >= 1 tile. 45, not the brief's implied 15: with 15 or 30 a smooth sine sweep loses frames at each turn and the existing `repeatedFrames > 80` assertion (device-walk-ref.test.mjs) fails (68, 78); with 45 it holds. It must also go on: >= 0.05 tiles of path over the next 15 frames when a full window follows (path, not net, since a turn nets zero). Replay: `max_still_ms` 17 / 17 / 17 on m39aa-pixel / m39u-iphone / m39n-pixel-2 (was 234 on the first), ratios 0.993 / 0.989 / 0.993.
- **Existing-test edit (orchestrator to confirm):** `device-walk-ref.test.mjs` "asks the person for a snap...": the expected criterion list gains `['max_backstep_tiles', true]` after `max_still_ms`. Nothing weakened; every other existing assertion passes unchanged.
- Rust edit rebuild: about 26-34 s of fixture build per run, no recurrence of M30b's minutes.

- **Pre-existing flake, not this milestone:** `walk-ref: M34-own-timer-bar ... M34-remote-motion` (slow, loopback) fails about 1 run in 4 with `Expected: 1, Received: 0` on 'one confirm tap': remote-motion failed `max_still_ms` = 100 (a 100 ms in-walk stall; `max_backstep_tiles` 0). Reproduced with the base `checks.mjs` (6c1d2fb) the same way (`max_still_ms` 100), so it is frame pacing on the loaded Mac, not the new window. Orchestrator's call whether to charge it.
- **Fix round 1 (orchestrator ruling on the `walk-ref: M34` flake).**
  - (a) Evidence, failure kept (`/tmp/m39ab/fail-a-1`, `max_still_ms` 83 with the all-segments clamp). The still is at the bot's turnaround: drawn x holds 0.578 for 5 frames (5773-5873 ms, one 10 Hz segment) with `frame_seq` still advancing, then 0.582, then 0.656, 0.766. So it is the start of a leg after a stop: a ~100 ms segment from a rest sample into a walking sample (small delta, large `b.vel`), where the clamp set both tangents to about 0 and delayed the onset by one segment. Not a duplicate relay (same `t` is not stored) and not a mid-walk delta = 0. The raw `push` inputs were not logged; this is inferred from the drawn series.
  - (b) The clamp now applies only when `h * 1000 > EXTRAPOLATION_CAP_MS` (250 ms). Justification: the relay interval while moving is 100 ms; one lost relay gives 200 ms and two 300 ms, around the 250 ms horizon past which 0012 already treats a key as held, so a segment longer than the cap is a gap with no motion information; the rest-to-walk case is seconds. Segments at or under the cap, duplicates and delta = 0 included, use the plain Hermite exactly as before (test `interp_zero_delta_mid_walk_is_unchanged`: a 10 Hz walk with one delta = 0 sample, equal to an independent unclamped Hermite on the flat and the following segment; it would fail under the all-segments clamp, which zeroes the flat segment's tangents). `interp_rest_then_walk_never_draws_behind` (3 s segment) and the slow `remote-rest-walk` spec stay green; their earlier red lines stand.
  - (c) A/B, `walk-ref: M34`, both with the new `checks.mjs`, blocks of 5 interleaved (new, base `dc18c9e` engine, new, base): new 5 pass / 1 FAIL of 5, then 5 / 0; base 5 / 0 and 5 / 0. Total new 1 FAIL of 10, base 0 of 10 (not significant at n = 10). The one new failure (`/tmp/m39ab/fail-new1-3`) is NOT `max_still_ms` (17) but `max_backstep_tiles` 0.059 > 0.05: a +0.059 step (3.082 -> 3.141) in the middle of a return-leg deceleration, frames 107-108 of the series, in segments the new code leaves identical to the base. So the 0.05 limit sits close to the ordinary Hermite wobble under jitter on a loaded Mac, and the loopback test can trip on it; **decision for the orchestrator**: raise the limit (the lurches are 0.34-1.09, so 0.1 or 0.15 would still judge them) or leave it.
