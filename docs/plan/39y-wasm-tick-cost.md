# M39y: where the large-save tick spends 3x native in wasm

Status: not started · After: 39s · Tyler-dependent: Q18 (default: the iPhone 12 is the baseline phone)

## Goal
M39s (`docs/plan/39s-sim-tick-tail.md` Deviations) measured the large-save `sim_tick` three ways:
- **Native:** p50 1.26 / p95 1.41 ms, flat.
- **Headless Chromium, desktop:** about 3.9-4.0 / 5.8-6.6 ms, a wide body with a slow wander of about 2 s.
- **Phones:** iPhone 12 p50 8.64 / p95 10.2 ms (`m39u-iphone`); Pixel 5 p50 7.9 / p95 23.2 ms.

There are no periodic engine spikes, and the timer is a `BTreeMap`, so nothing cascades. The ceiling is 10 ms (ADR 0010). Wasm is commonly 1.2-2x native, so a 3x gap is the lead. When this is done, the gap is attributed to phases of `sim_tick` and to a mechanism, measured on the same save natively, in a non-browser wasm runtime and in the browser worker. Then either a fix lands that moves the browser median with goldens unchanged, or the report stops with the mechanism measured.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0045-build-profiles-measured.md` (the wasm and native release profiles) and `docs/decisions/0048-fast-tier-budgets-dev-loop-and-wire-measurements.md` §5 (`wasm-opt` and `+simd128` stay off, with the measured median tick)
3. `docs/plan/39s-sim-tick-tail.md` Deviations (the per-tick ring, `tick_hist`/`tick_top`/`tick_period`, the native and desktop numbers, the scratch method in `/tmp/m39s` if it still exists)
Also `docs/plan/39o-large-save-tick-breakdown.md` Deviations (`CB_SIM_ONETICK_US`, `SimHost.profile`, `BenchProbe`). Rules: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Order of work
1. **Build flags first (cheap).** Read the wasm release profile and the build script that produces the `.wasm` used by the bench build (`opt-level`, `lto`, `codegen-units`, `panic`, debug assertions, overflow checks, any `wasm-bindgen` debug mode, allocator). Compare them with the native profile M39s timed. A mismatch, for example debug assertions on, `opt-level` "s" against 3, or a different allocator, is a candidate: measure it, don't assume it. Paste the profiles.
2. **Phase counters, bench builds only.** Behind the existing bench feature (or a new `bench-phases` cargo feature, compiled out of release), time the phases inside one `sim_tick`: due-timer drain, the game's `advance`, store writes and apply, the wake list, anything else over 10 % natively. The counters must never feed state: no branch on them, no hashing them, goldens and determinism hashes unchanged. Expose per-phase sums through the same path `CB_SIM_ONETICK_US` uses, and add them to the bench meter's readings as a compact per-phase p50/p95.
3. **Three runs, same save, scale 1, one table:** native (cargo bench or test harness), a non-browser wasm runtime (Node or Bun, whichever the `wasm` suite's legs already use), and the headless Chromium worker (the bench page). Per phase: p50 and p95, and the ratio to native. Name the phase or phases that carry the gap.
4. **Stop and report** with the table and a mechanism if either holds: the fix changes sim results or needs an ADR change (for example 0048's `simd128` or `wasm-opt` decision); or the gap is the browser's, not the code's (the Node or Bun wasm is near native but the worker is not). Otherwise:
5. **Fix** the phase. For example, change a data structure's access pattern so it suits wasm (fewer bounds checks, no per-tick allocation, a cheaper map), or correct a build flag. Prove it on the browser per-phase table, before and after, same machine and day. Goldens unchanged; `pnpm test rust -t tick` and `pnpm test wasm` green.

## Non-scope
The 10 ms ceiling and the save's size (Q18); frame build; phone runs (the orchestrator re-measures both phones with this build afterwards).

## Files touched
The engine crate's sim tick path and its bench feature (name the modules in Deviations), `packages/engine/src/worker/sim.ts` for the readout, `games/reference/src/{bench.ts,bench-stats.ts,check.ts}` and their tests, build config (`Cargo.toml` profiles, the wasm build script) only if step 1 finds a mismatch.

## Exit criteria
- [ ] The build-profile comparison is pasted in Deviations.
- [ ] Per-phase counters exist in bench builds only (a test shows a release build has none, or a compile-out check), goldens and determinism hashes unchanged.
- [ ] The three-runtime per-phase table is in Deviations, with the phase or phases that carry the gap named.
- [ ] Either the fix lands with the before/after browser table, or the report stops at step 4 with the mechanism measured.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test rust -t tick` · `pnpm test wasm` · `pnpm test unit -t bench` · `pnpm test:slow browser -t "large-save|bench"` (targeted, foreground). Loops run in the foreground, bounded, with a per-run kill timeout, and no background load generators.

## Manual device checks
After landing, the orchestrator runs M39-large-save driven on the Pixel and the iPhone with this build and reads the per-phase readings.

## Deviations
(filled in during Phase 3)
- **Context from the orchestrator (before this milestone):** **Pixel round `m39s-pixel` (orchestrator, 2026-10-07, the M39s build):** M39-large-save fail, `tick_p95_ms` 26.3; `sim_tick` p50 7.64 / p95 22.8; 36,001 ticks; `tick_missed` 7. The ring (`tick_series`, 4,096 ticks) is **bimodal**: a fast body at median 7.49 ms (3,406 ticks) and a slow mode at median 20.95 ms (690 ticks, 17 %), a ratio of 2.80. The slow fraction is even across the window (0.14-0.20 per 10 s). Slow ticks are almost all isolated (run lengths: 1 tick 493 times, 2 ticks 69, 3 ticks 10, 4 ticks 6, 5 ticks 1), and `tick_period` is null. Reading: the sim worker sleeps between ticks, and about 1 wake in 6 is placed on a little Cortex-A55 core of the Pixel 5's big.LITTLE CPU (2.8x slower for this work). That is core placement on wake, which a page cannot pin, and a busy-wait would be a mask. The lever is per-tick cost: a tick at 3.7 ms on a big core would fit 10 ms on a little one. **M39y** (the 3x wasm gap) is therefore the fix path for both phones.
