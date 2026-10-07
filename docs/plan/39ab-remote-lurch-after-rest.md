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
(filled in during Phase 3)
