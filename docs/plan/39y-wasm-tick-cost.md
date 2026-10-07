# M39y: where the large-save tick spends 3x native in wasm

Status: done (2026-10-07; stopped at step 4, drain fix kept) · After: 39s · Tyler-dependent: Q18 (default: the iPhone 12 is the baseline phone)

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
- [x] The build-profile comparison is pasted in Deviations.
- [x] Per-phase counters exist in bench builds only (a test shows a release build has none, or a compile-out check), goldens and determinism hashes unchanged.
- [x] The three-runtime per-phase table is in Deviations, with the phase or phases that carry the gap named.
- [x] Either the fix lands with the before/after browser table, or the report stops at step 4 with the mechanism measured.
- [x] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test rust -t tick` · `pnpm test wasm` · `pnpm test unit -t bench` · `pnpm test:slow browser -t "large-save|bench"` (targeted, foreground). Loops run in the foreground, bounded, with a per-run kill timeout, and no background load generators.

## Manual device checks
After landing, the orchestrator runs M39-large-save driven on the Pixel and the iPhone with this build and reads the per-phase readings.

## Deviations
(filled in during Phase 3)
- **Context from the orchestrator (before this milestone):** **Pixel round `m39s-pixel` (orchestrator, 2026-10-07, the M39s build):** M39-large-save fail, `tick_p95_ms` 26.3; `sim_tick` p50 7.64 / p95 22.8; 36,001 ticks; `tick_missed` 7. The ring (`tick_series`, 4,096 ticks) is **bimodal**: a fast body at median 7.49 ms (3,406 ticks) and a slow mode at median 20.95 ms (690 ticks, 17 %), a ratio of 2.80. The slow fraction is even across the window (0.14-0.20 per 10 s). Slow ticks are almost all isolated (run lengths: 1 tick 493 times, 2 ticks 69, 3 ticks 10, 4 ticks 6, 5 ticks 1), and `tick_period` is null. Reading: the sim worker sleeps between ticks, and about 1 wake in 6 is placed on a little Cortex-A55 core of the Pixel 5's big.LITTLE CPU (2.8x slower for this work). That is core placement on wake, which a page cannot pin, and a busy-wait would be a mask. The lever is per-tick cost: a tick at 3.7 ms on a big core would fit 10 ms on a little one. **M39y** (the 3x wasm gap) is therefore the fix path for both phones.

**M39y, steps 1-5.** Commits: `39afc03` (steps 1-3, counters and table), then the fix commit (`M39y step 5`).

**Step 1, build profiles (no mismatch found).** Native (`cargo test --release`, what M39s timed) and wasm (`buildGame`: `cargo build --target wasm32-unknown-unknown --release`, `--features bench`) use the same root `[profile.release]`: `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`; `debug-assertions` and `overflow-checks` off in both (release default); no `RUSTFLAGS`, no `wasm-opt`, no `simd128` (0045 §1, 0048 §5). rustc 1.93.0. The one difference is the allocator: native uses the system malloc, the `.wasm` the engine's arena (`abi/arena.rs`, installed by `export_instance!`). It did not matter: the same `.wasm` under Node, ticking back to back, is 1.3x native (below).

**Step 2, counters (seams).**
- `packages/engine/crates/engine/src/bench_phase.rs` (new, `pub mod bench_phase`): `Phase` (`Start` 0, `Records` 1, `BeginTick` 2, `GameTick` 3, `EndTick` 4, `Changes` 5, `Results` 6, `Subs` 7, then the sampled sub-phases of `GameTick`: `Skip` 8, `Drain` 9, `Advance` 10, `WakeAt` 11, `Put` 12, and `Overhead` 13), `PHASES = 14`, `SAMPLE_EVERY = 16`, `mark(Phase)`, `drain_enter()`, `sampled(Phase)`, and natively `take() -> [u64; PHASES]` (ns, zeroed on read). `mark(p)` attributes the time since the previous mark to `p`. Cargo feature `bench-phases` (engine); reference-sim's `bench` feature forwards it (`bench = ["engine/bench-phases"]`), so `buildGame({ features: ['bench'] })` and the native test builds have it and nothing shipped does. Without the feature every function is an empty `#[inline(always)]` and nothing is linked.
- Marks: `Host::tick` (`host/mod.rs`: `Start`, `Changes`, `Results`, `Subs`), `Sim::step_with_progress` (`sim/mod.rs`: `Records`, `BeginTick`, `GameTick`, `EndTick`), and the sampled sub-phases in `TickCx::next_due` / `wake_at` / `put_entity` (`authority.rs`). One furnace in 16 is timed in full (`Skip` is the unsampled time between; `Overhead` is two marks back to back, the cost of one mark, taken out of each sampled phase; sampled sums are scaled by 16). Nothing reads a counter back: no branch, no hash.
- **A new wasm import, `engine.bench_mark(phase: u32)`, in bench builds only** (a `.wasm` has no clock; the import is output-only and the host reads its own). Determinism rule: "a new WASM import is an amendment to 0014 §3": I did not write an ADR; the import exists only under `bench-phases` and `tick-phases @slow` asserts a shipped (release) module does not have it. **Decision for the orchestrator:** whether 0014 §3 needs a one-line amendment for it.
- Loader: `setBenchMarkHook(hook | null)` in `src/loader.ts` (the import calls it; null by default). Sim worker (`worker/sim.ts`, only under `test.timing`) installs a hook that adds to a preallocated `Float64Array`, and stores the per-pass phase microseconds in control words `CB_SIM_PHASE0 + id` (`CB_SIM_PHASE0 = 74`, `SIM_PHASES = 14`; `CONTROL_BLOCK_INT32S` 74 -> 88, so the shipped control block is 56 bytes larger). `BenchProbe.phaseUs(id)` (`engine/test`).
- Meter: `createPhaseStats()`, `PHASE_NAMES`, `PHASE_SAMPLE_EVERY` in `games/reference/src/bench-stats.ts` (10 s `Rolling` window per phase; scaling and overhead subtraction in `readings()`); `BenchHud.phases`; `window.__check.readings()` adds `sim_phases_ms: { name: [p50, p95] }`. Unit test `bench meter: per-phase statistics` (`pnpm test unit -t per-phase`, passes).
- Native twin: `games/reference/sim/tests/bench_phases.rs` (`slow_phases_large_save`, re-runs itself in release like `slow_tick_large_save`; recorded, never gated). Node twin: `packages/engine/tests/wasm/tick-phases.test.ts` (`tick-phases @slow`; writes `test-results/wasm/tick-phases.json`; two legs, back to back and paced at 20 Hz with `Atomics.wait` between ticks, as the sim worker sleeps; also asserts the bench module has `engine.bench_mark` and the shipped one does not).
- Release has none: `tick-phases @slow` (import check above); goldens and determinism hashes unchanged (`pnpm test wasm` 172 pass, `pnpm test rust` 801 pass, no golden file in `git status`).

**Step 3, the table.** Same save, scale 1, `sim_tick` ms as `p50 / p95`, before any fix, one host (this Mac, load average 5-10 from other sessions: absolute numbers are noisy, ratios within a row are the evidence). Native: 1,200 ticks after 200 warm-up, back to back. Node: the release bench `.wasm`, 8 connections, 1,200 back to back, then 300 paced at 50 ms. Browser: headless Chromium, the bench page, `&scale=1`, 60 s, 1 connection (so `subs` is small).

| phase | native | Node back to back | Node paced 20 Hz | Chromium worker | worker / native |
|---|---|---|---|---|---|
| `sim_tick` | 1.31 / 1.44 | 1.71 / 2.14 | 3.65 / 5.55 | 4.19 / 6.24 | 3.2x |
| drain (`next_due`) | 0.33 / 0.38 | 0.47 / 0.68 | 1.17 / 2.11 | 1.52 / 2.16 | 4.6x |
| advance (game logic and reads) | 0.26 / 0.31 | 0.32 / 0.49 | 0.88 / 1.68 | 1.44 / 2.08 | 5.5x |
| `wake_at` | 0.20 / 0.23 | 0.30 / 0.32 | 0.53 / 0.71 | 0.48 / 0.64 | 2.4x |
| `put_entity` | 0.37 / 0.39 | 0.56 / 0.59 | 0.97 / 1.30 | 0.88 / 1.28 | 2.4x |
| changes (`chunk_versions`) | 0.098 / 0.104 | 0.118 / 0.127 | 0.207 / 0.268 | 0.215 / 0.265 | 2.2x |
| subs (8 connections; 1 in Chromium) | 0.045 / 0.049 | 0.051 / 0.057 | 0.093 / 0.116 | 0.015 / 0.020 | n/a |
| records, begin/end tick, results | 0 | 0 | 0 | 0 | |

**What carries the gap, and the mechanism.** The module is not the gap: the same `.wasm` in Node, ticking back to back, is 1.3x native (1.71 against 1.31 ms). **The same module in Node with a 50 ms sleep between ticks is 3.65 ms, the browser's number** (3.65 / 5.55 against Chromium's 4.19 / 6.24, and the p95/p50 ratio is the browser's too). Every phase slows by 2-3x together. So the 3x is the wake after the sleep (a core and caches that went cold in 45 ms of idle: clock, L1/L2 and the TLB), not wasm, not Chromium's wasm tiering, not the allocator, and it is the same mechanism the Pixel's little-core wakes would show at a larger factor. The phases that lose most (drain, advance) are the ones that touch the most memory per furnace; the lever is therefore bytes and cache lines touched per tick. Native back to back is the hot-cache best case, so it understates what any phone can reach.
This is the brief's step-4 "the gap is not the code's" in the sense that no wasm-specific code fix exists; I still made one change in the code because the drain phase showed a plain quadratic cost.

**Step 5, the fix (kept, state-neutral).** `sim/timers.rs`: each timer bucket is a `VecDeque<EntityId>` instead of a `Vec`, and `next_due` pops with `pop_front` instead of `Vec::remove(0)`. `remove(0)` on the 2,621-id bucket moved the rest of the bucket on every pop (about 13 MB of id moves per tick). Order is unchanged (ascending id within a tick; same canonical encoding), so no golden or hash moved. `pnpm test rust` 801 pass, `pnpm test wasm` 172 pass, `pnpm test:slow browser -t "large-save|bench"` 3 pass (78 s), clippy clean with `bench-phases` on.
Before / after, `sim_tick` p50 / p95 ms (the "after" runs at load average 7-10, the "before" at 5-7, so the browser and Node paced rows are if anything pessimistic):

| | before | after | change of p50 |
|---|---|---|---|
| native, back to back | 1.31 / 1.44 | 1.15 / 1.29 | -12 % |
| Node, back to back | 1.71 / 2.14 | 1.57 / 2.01 | -8 % |
| Node, paced 20 Hz | 3.65 / 5.55 | 3.19 / 6.47 | -13 % |
| Chromium worker | 4.19 / 6.24 | 3.80 / 6.69 | -9 % |

Drain phase alone: native 0.33 -> 0.16 ms (-52 %), Node 0.47 -> 0.33, Node paced 1.17 -> 0.78, Chromium 1.52 -> 1.12. p95 rose in the two noisy rows (load, not the change: the p95 of the tick is the wake). **The fix is a modest win (about 10 % of the median), not the 3.7 ms target**: the remaining cost is spread evenly (`advance`, `wake_at`, `put_entity` and the `by_entity` BTreeMap churn each 0.2-0.4 ms natively). Not done, candidates for a successor: `by_entity` as a dense table (needs a bound on ids from an untrusted snapshot first), skipping repeated `chunk_versions.insert` for the same chunk in `Host::tick`, and the `put_entity` write path (`entity_scopes`, the change log); a cache-footprint change is what shortens the cold wake, and none of these shrinks the working set by much.

**Verification run.** `pnpm test rust -t tick` 29 pass; `pnpm test rust` 801 pass; `pnpm test wasm` 172 pass; `pnpm test unit -t "bench|control"` 16 pass and `-t per-phase` 1 pass; `pnpm test:slow wasm -t tick-phases` 1 pass (31 s); `pnpm test:slow browser -t "large-save|bench"` 3 pass; `tsc` clean for `packages/engine` (`pnpm typecheck`) and `games/reference`; `cargo clippy` on `engine` and `reference-sim` with `bench-phases` on, and the workspace without it, no errors. Not run: full `pnpm test`, `pnpm lint` (the orchestrator's gate), phones.
- **Gate (orchestrator):** `pnpm test` green (unit 407, tools 244, wasm 172, browser 256 in 45 s), lint clean incl. `tsc`; no golden changed. The gate's 'marker ADDED 1' is a false positive (`.skip(1)` on an iterator in `bench_phases.rs`). Rulings: the `VecDeque` drain fix is kept (order and goldens unchanged; it shrinks memory touched per tick, the lever the stop names). `engine.bench_mark` needed ADR 0055 (amends 0014 §3, bench builds only), written; the control-block growth from 74 to 88 words needs none (no ADR fixes its size; M39o grew it the same way). **Conclusion:** the 3x is a cold wake after the 50 ms sleep (the same `.wasm` in Node: 1.3x native back to back, 3.65 ms paced), not wasm or Chromium. The candidates trim tenths of a millisecond; reaching about 3.7 ms needs a smaller per-tick working set, a storage redesign for 262,144 furnaces. That is a scope and cost call, so it goes into **Q18** with this evidence, not into another brief.
