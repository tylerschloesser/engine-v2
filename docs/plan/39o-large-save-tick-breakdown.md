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
Commits: `8774c8d` (step 1, engine split), `74310d0` (step 2, meter, readings, check metrics, test).

**Seams.**
- `packages/engine/src/sab/control.ts`: `CONTROL_BLOCK_INT32S` 69 -> 74; words `CB_SIM_SEAL_US` 69, `CB_SIM_ONETICK_US` 70, `CB_SIM_FRAME_US` 71, `CB_SIM_RESYNC_US` 72, `CB_SIM_CATCHUP` 73; `PROFILE_SEAL|TICK|FRAME|RESYNC|CATCHUP` (0-4), `PROFILE_SLOTS` 5. All integer microseconds except the catch-up count.
- `SimHost.profile: Int32Array | null` (`server.ts`, `null` by default; the sim worker sets a preallocated one only under `test.timing`). `runOneTick` times seal, `sim_tick` and the frame build and send over all connections, only for the paced tick (`catchingUp` skips the catch-up ticks, whose count lands in `PROFILE_CATCHUP`); `runPacedTick` times the whole `resync()` (catch-up and warming included, `max(1, us)` so 0 means "no resync"). Off the bench: one `null` check per site, no clock read.
- The sim worker zero-fills the profile before the timed pass and copies it into the words before `CB_SIM_TICK_US` (itself before `CB_SIM_TICKS_RUN`); `CB_SIM_TICK_US` is unchanged. `BenchProbe` (`engine/test`) gains `sealUs()`, `simTickUs()`, `frameBuildUs()`, `resyncUs()`, `catchupTicks()`.
- `games/reference/src/bench-stats.ts` (new; `Rolling` moved here, plus `p50`, `quantile`, `sum`, and `createPartStats`) so the unit test needs neither engine nor DOM. HUD: two new lines (`tick p50/p95`, then the parts). `readings()` keys: `tick_p50_ms`, `seal_p95_ms`, `sim_tick_p50_ms`, `sim_tick_p95_ms`, `frame_build_p95_ms` (not `frame_p95_ms`, which is the client worker's), `resync_p95_ms`, `catchup_ticks_per_10s`. `resync_p95_ms` is over the passes that ran a resync only.
- `checks.mjs` M39-large-save: seven metrics added (medians of p50, maxima of p95); Pass text, hash and criteria untouched (`pnpm test unit -t "bench meter|device-walk"`: 202 pass).

**Tests, seen red.** `games/reference/src/bench-stats.test.ts`, three tests. Red 1 (my arithmetic, fixed): `expected 1.096 to be 1.092`. Red 2 (mutation: whole-pass sample pushed as the `sim_tick` value, then reverted): `AssertionError: expected 0.5 to be 1` (exact p50 test) and `expected 11.372 to be 11.472` (whole-pass p95 equals a plain `Rolling`).

**Zero-GC.** No `[gc]` page sets `timing` (only `bench.ts` does), so none covers the timing-on path; I added no browser test. The timing-off path changed (null checks in `runOneTick`/`runPacedTick`), so I ran `pnpm test browser -t "sim-paced|zero_gc|neg_control_snapshot|input|sim"`: `browser pass 58 tests   31s/48s`, which includes `[gc] sim-paced clean`, `[gc] sim clean`, `[gc] input clean`, `zero_gc_singleplayer_with_snapshot`, `input: inputRing drops 0` and the negative controls. Timing on: `Math.round`, clock reads and the `Int32Array` slots allocate nothing persistent beyond the clock's number boxes; unmeasured.

**Desktop reference** (this Mac, headless Chromium `--enable-unsafe-webgpu`, `dist-bench`, `?bench=large-save&scale=N`, 60 s, 1202 ticks, 0 catch-up ticks, `engine_mem_grows` 0; driven by a scratch script outside the repo; machine load average about 4, a shared host). Values are the median over the five 10 s readings taken at 10..50 s (max in brackets), ms:

| scale | sim_tick p50 | sim_tick p95 | whole tick p50 | whole tick p95 | seal p95 | frame build p95 | resync p95 | us per 1000 furnaces (sim_tick p50) |
|---|---|---|---|---|---|---|---|---|
| 1 | 4.615 (4.885) | 5.56 (6.565) | 5.115 | 6.155 (7.165) | 0.015 | 0.65 (0.66) | 0.07 (0.095) | 17.6 |
| 4 | 1.11 (1.16) | 1.955 (2.41) | 1.435 | 2.535 (3.035) | 0.015 | 0.525 (0.655) | 0.045 (0.13) | 16.9 (x4) |
| 16 | 0.28 (0.305) | 0.555 (0.59) | 0.475 | 0.97 (1.07) | 0.02 | 0.37 (0.405) | 0.055 (0.07) | 17.1 (x16) |

Reading: `sim_tick` is about 90 % of the pass at scale 1 and per furnace flat (17-18 ns) from 1/16 to full scale, so it is compute bound, not cache bound, on this desktop; the frame build does not scale with the save (it follows the view, 0.4-0.65 ms); seal and resync are noise (under 0.1 ms). The p95 over p50 spread of `sim_tick` (5.56 vs 4.6) is the next thing to explain on a phone. One readings dump (scale 1, reading at 50 s): `tick_p95_ms 6.375, tick_p50_ms 5.03, seal_p95_ms 0.015, sim_tick_p50_ms 4.57, sim_tick_p95_ms 5.56, frame_build_p95_ms 0.655, resync_p95_ms 0.07, catchup_ticks_per_10s 0, main_p95_ms 0.335, frame_p95_ms 0.7`. HUD at scale 1: `tick p50/p95: 5.03 / 6.38 ms` then `seal p95 0.01, sim_tick p50/p95 4.57 / 5.56, frame build p95 0.66, resync p95 0.07 ms; catch-up ticks/10s 0`.

Note for the follow-up: this desktop single-player `sim_tick` (4.6 ms) is above the 3.1-4.2 ms of M36's HUD evidence, with a loaded host; compare phones against a same-day desktop run.
