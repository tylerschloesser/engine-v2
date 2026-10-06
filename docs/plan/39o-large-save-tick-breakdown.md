# M39o: The large-save tick says where its time goes

Status: not started · After: 39n · Tyler-dependent: Q18 (default: the iPhone 12 is the baseline phone; the Pixel 5 is informational)

## Goal
Finding 2 of the driven rounds: M39-large-save `tick_p95_ms` is 26.1 ms on the Pixel 5 and 12.2 ms on the iPhone 12, against the 10 ms ceiling (PRE-PLAN §7, ADR 0010: "derived, not measured"). A read-only diagnosis (2026-10-06) found it is real compute, not a measurement fault:
- the phones run at full scale (262,144 lit furnaces, about 2,621 timer completions per tick);
- the series is flat for 600 s, with no drift, no thermal ramp and no periodic spike;
- the bench world is not persisted, so snapshots and OPFS play no part;
- the Pixel/iPhone ratio is the same for tick, main and frame (2.1-2.8x).

Natively, `build_frame` is about 57 % of self time, then `BTreeMap` insert/remove, `furnace::advance`, `Store::apply` and `TimerWheel`. But no per-call breakdown exists for wasm or for any phone. Today the meter times one whole pass (`packages/engine/src/worker/sim.ts`, the `timing` branch writing `CB_SIM_TICK_US`): seal, tick, the frame build and send, and every 8th wake a resync with up to 5 catch-up ticks or a 2 ms warmer. Nothing to optimise is named until that pass is split.

When this is done the bench build reports per-call p50/p95 for each part of the pass, the reading reaches the device-walk evidence, and a headless desktop run at full scale gives the desktop reference numbers. The orchestrator then measures the phones and writes the optimisation brief from the numbers.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0010-*.md` (the tick budget and its derivation)
3. `docs/plan/36-*.md` Deviations (bench meter, `?bench=large-save`, `&scale=`, the HUD)
Rules: `.claude/rules/hot-paths.md` (the timing is per tick: no allocation), `.claude/rules/determinism.md` (timing must never feed the sim).

## Scope
1. **Split the timed pass**, bench builds only (the `timing` flag), into: `seal` (`sim_seal_frame`), `tick` (`sim_tick`, per tick, with catch-up ticks counted separately), `frame` (build plus send per connection), and `resync` (the every-8th-wake pass, with its catch-up count). Use fixed control-block words or a preallocated ring, as `CB_SIM_TICK_US` does today. The existing whole-pass value stays, unchanged, so `tick_p95_ms` and its criterion mean what they meant.
2. **Meter and readings**: `createBenchMeter` (`games/reference/src/bench.ts`) keeps a 10 s p50 and p95 per part (`seal_p95_ms`, `sim_tick_p50_ms`/`_p95_ms`, `frame_p95_ms`, `resync_p95_ms`, `catchup_ticks_per_10s`, plus `tick_p50_ms` for the whole pass), shown on the HUD and in `__check.readings()`. `checks.mjs` M39-large-save lists them as metrics, not criteria; its Pass text and hash are unchanged.
3. **Desktop reference, one run in this session**: the bench page at `&scale=1` in headless Chromium on this Mac for 60 s (an existing walk or bench spec with a scale override, or `playwright-cli`). Paste every reading into Deviations. Then the same at `&scale=4` and `&scale=16`, to show whether time per furnace is flat (compute bound) or falls with scale (cache bound).

## Non-scope
Any optimisation: the follow-up brief owns it. Phone runs: the orchestrator's. `wasm-opt`/`simd128` (ADR 0048 keeps them off; the follow-up may reopen them with numbers).

## Files touched
`packages/engine/src/worker/sim.ts` (and the control-block word list it uses), `games/reference/src/bench.ts`, `games/reference/src/check.ts` if readings are assembled there, `scripts/lib/device-walk/checks.mjs` and its tests.

## Tests added (each seen red, red line pasted in Deviations)
- A bench-meter unit test: fed synthetic per-part samples, the p50/p95 per part are exact, and the whole-pass p95 is unchanged by the split.
- The `[gc]` bench or large-save page (whichever exists in the slow tier) stays within its budget with the breakdown on. If no zero-GC test covers the bench timing path, say so in Deviations, and don't add a fast-tier browser test (the `browser` suite is at 44-45 s of 48).

## Exit criteria
- [ ] The breakdown readings appear on the HUD and in `__check.readings()` of the bench build. Show one readings dump from the desktop run.
- [ ] The desktop reference table at scale 1, 4 and 16 is in Deviations.
- [ ] The tests exist, pass, and were seen red. No golden, budget or baseline changed, and the release build is byte-identical in behaviour (the `timing` flag is off there; `check-reporter` absence stays green).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t bench` · `pnpm test:slow browser -t "large-save|bench"` (targeted, foreground).

## Manual device checks
After landing, the orchestrator runs M39-large-save driven on the Pixel (and on the iPhone when its passcode is off) and writes the optimisation brief from the per-part numbers.

## Deviations
(filled in during Phase 3)
