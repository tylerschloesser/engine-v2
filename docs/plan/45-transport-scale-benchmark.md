# M45: Transport scale benchmark

Status: done (2026-10-12) · After: 41, 44b · Tyler-dependent: no · Revised 2026-10-12 from 0079 §5, §14-§16 (the caps are opt-in and 16.5 MiB at the recommended values)

## Goal
The production transport module meets Tyler's scale: a world tick with 50,000 belt tiles and 250,000 items runs in at most 5 ms median natively in release on the baseline machine, gated by a baseline (`belts-tick.json`) that a regression trips; the same `.wasm` under Node reports its ratio (warn-only); the recommended `max_lines`/`max_items` (0076 §8) are measured against the phone memory split and the largest caps that fit the 8 MiB slack are recorded as M57's phone candidates. M40's spike is deleted. Phase end: tag `belts-core-complete`.

## Read first
1. `docs/architecture/README.md`
2. `docs/architecture/testing-and-tooling.md` ("Benchmarks and baselines", "The slow tier")
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§8) and `docs/decisions/0077-transport-item-representation.md` (Amendment: the spike's numbers to beat)
4. `games/reference/sim/tests/common/bench_run.rs` and `bench_host.rs` (the release re-run pattern and the host-with-connections harness; the netcode twin `packages/engine/tests/netcode/tick-large-save-node.test.ts`)
Rules that apply: `.claude/rules/hot-paths.md`. Skills: `run-tests` ("The slow tier and the benchmarks": `gate`, `pnpm bench:baseline`), `profile-frame` (its method, not its script, for a native profile).

## Scope
- `engine::testing::bench` (feature `testing`): `run_in_release`, `gate` moved from the reference game's `tests/common/bench_run.rs` so a fixture can use them; the reference game's copy becomes a re-export.
- `fx-belts/tests/bench_belts.rs`: `slow_tick_belts_large`: M40's `bench_world` (`Mixed` regime) built at genesis by a `Belts::genesis` that reads `BeltsParams.bench` (a new `Worldgen::Params` type for the fixture, like the reference game's `RefParams.bench`; genesis creates the lines directly through `transport_mut()`, which is `Ok` in genesis (0079 §4), not through requests: 3,810 lines would exceed the request pattern's 32-slot table), with the world's caps set from `WorldConfig.params.maxLines`/`maxItems` (the recommended values), `Host<Belts>` with 8 connections holding maximum views (M36's shape), 200 warm-up and 1,200 measured ticks; a tick = admit + seal + tick + build_frame x 8. Metrics: `medianMs`, `p99Ms`, `maxMs`, `tickMedianMs` (the sim step alone), `advanceMedianMs` (the transport advance alone, from `bench_phase` marks), `framesMedianMs`, `frameBytesPerTick`. Baseline `packages/engine/baselines/belts-tick.json` with `limits.medianMs: 5`, `gated: ["medianMs"]`, fingerprint and conditions as `tick.json`.
- The Node twin: `tests/netcode/tick-belts-large-node.test.ts` (`tick-belts-large node @slow`, warn-only) on the `fx-belts` `.wasm` through `createWorldServer`, reporting the ratio to native in its output and in Deviations (0077 §2's deferred WASM figure).
- A `slow_snapshot_belts_large`: encode and decode time and bytes of the transport store at scale (reported; the snapshot proxy of M36 applies: `SNAPSHOT_PROXY_MS`).
- The phone split check, revised: `Transport::reserved_bytes` at the recommended caps (32,768 / 262,144) is about 16.5 MiB (0079 §16), over 0007 §8's 8 MiB slack, so no test asserts they fit. `transport_phone_caps_fit_split` pins instead the largest caps of the form (`lines`, `8 x lines`) whose `reserved_bytes` fits the slack (compute from the real record sizes, pin the pair as literals with the bytes, so a record growth moves it) and records them in Deviations as M57's phone candidates (the reference game's belt scale on a phone is M57's measurement); `transport_budget_exceeds_arena_is_clean` keeps the `BudgetExceedsArena` path (`init_counts_the_transport_arena` already covers the recommended caps against a pre-M42 split).
- An optimisation step if the gate is missed: profile first (named functions), then change the code, never the workload, the limit or the baseline.
- Delete the spikes: `fixtures/belts/tests/spike_repr.rs`, `spike_forecast.rs`, `common/{repr,repr_a,repr_b,forecast,bench_run}.rs` (their numbers live in 0077 and 0078; M47 reads the tracker's design from `common/forecast.rs` at the M44b commit or tag `belts-core-complete~1`, never copies it); keep `common/world.rs` (the bench world) and drop its `Observer`-dependent parts if any.

## Non-scope
- Forecast tracker cost (M47 re-runs this benchmark with the tracker on and records the delta); replication bytes (M47); the phone measurement itself (M57).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/testing/` (new `bench.rs`), `packages/engine/fixtures/belts/`, `packages/engine/baselines/belts-tick.json`, `packages/engine/tests/netcode/` (one file), `games/reference/sim/tests/common/bench_run.rs` (re-export).

## Seams
**Provides:** `engine::testing::bench::{run_in_release, gate}`; baseline `belts-tick`; `fx-belts` `BeltsParams.bench` and `genesis` at scale (M47, M50, M57 reuse the world); `slow_tick_belts_large`, `tick-belts-large node @slow`, `slow_snapshot_belts_large`; the tag `belts-core-complete`.
**Consumes:** M40 `bench_world`, M42-M44 `Transport`, M36's bench host pattern, `scripts/lib/bench-gate.mjs`.

## Planning decisions
- **The limit is Tyler's 5 ms for the whole tick** (one world tick, desktop), owned by the baseline's `limits`, not duplicated in `budgets.json`; `advanceMedianMs` is recorded so the transport's share is known (0077 §3's 3 ms is the advance's decision threshold, stated there).
- **Frames are built for 8 connections** as in `tick.json`: the belts tick budget includes frame building, which M47's forecasts will add to; the baseline is re-recorded in M47 for that reviewed cost.
- **Moving the bench helpers into the engine** is a technical call: two copies of `run_in_release` would drift; the `testing` feature is dev-only.

## Order of work
1. `engine::testing::bench`; the reference game's tests still pass.
2. `Belts::genesis` at scale from `BeltsParams.bench`; `bench_world_at_genesis_is_deterministic`.
3. `slow_tick_belts_large`, run several times, `uptime` checked; baseline recorded with `pnpm bench:baseline belts-tick`; conditions filled by hand.
4. If over 5 ms: profile, optimise, re-measure (Deviations records each round with its numbers).
5. The Node twin and the snapshot benchmark; the phone-split unit test.
6. Delete the spikes; Deviations; tag `belts-core-complete`; commit; push.

## Tests added
Rust suite: `bench_world_at_genesis_is_deterministic`, `transport_phone_caps_fit_split`, `transport_budget_exceeds_arena_is_clean`; slow: `slow_tick_belts_large`, `slow_snapshot_belts_large`. Netcode suite: `tick-belts-large node @slow`.

## Exit criteria
- [x] `slow_tick_belts_large` median at most 5 ms on the baseline machine at a 1-minute load under 5, three runs; `belts-tick.json` recorded with conditions; the gate trips when the baseline's `medianMs` is edited to a value 30 % under the measurement (inject-fail-revert of the gate).
- [x] `tick-belts-large node @slow` reports the WASM ratio in Deviations; 0077's Amendment gains the figure.
- [x] `transport_phone_caps_fit_split` pins the largest caps that fit the 8 MiB slack (literals), recorded in Deviations as M57's candidates; `transport_budget_exceeds_arena_is_clean` passes.
- [x] The spikes are deleted; the rust fast tier is inside 10 s.
- [x] `pnpm test`, `pnpm lint` and `pnpm test:slow rust` are green; tag `belts-core-complete` on the pushed commit.

## Verification commands
`pnpm test:slow rust -t slow_tick_belts_large` · `pnpm test:slow netcode -t "tick-belts-large node"` · `pnpm test rust -t transport_phone_caps` · `pnpm test && pnpm lint && pnpm test:slow rust`

## Budgets
- `belts-tick` baseline, `limits.medianMs` 5 (Tyler, 2026-10-11), gated on the baseline machine by `slow_tick_belts_large`.
- The snapshot proxy (M36's `SNAPSHOT_PROXY_MS`) for `slow_snapshot_belts_large`, reported.

## Context artifacts
`fixtures/belts/CLAUDE.md` (the bench feature and how to run the benchmark); `docs/architecture/testing-and-tooling.md` "Benchmarks and baselines" gains the `belts-tick` baseline in its list; `run-tests` skill's benchmark paragraph names it.

## Manual device checks
none (M57 runs the phones).

## Deviations
Implementer, 2026-10-11 (steps 1-5; step 6's commit and tag are the manager's).

**Files.** New: `crates/engine/src/testing/bench.rs` (83 lines: `repo_root`, `run_in_release(package, test_file, name)`, `gate`), `fixtures/belts/src/bench.rs` (174: `BenchSpec`, `BeltsParams`, the marker, `build`), `fixtures/belts/tests/bench_belts.rs` (380), `tests/common/bench_host.rs` (119), `tests/netcode/tick-belts-large-node.test.ts` (111), `baselines/belts-tick.json` (draft). Moved: `tests/common/world.rs` to `src/bench/world.rs` (539; genesis must build it, natively and in the `.wasm`, so it cannot stay test code; `Span`, `Toggle`, `SaturatedView`, `visible_at_centre` kept; it held no `Observer` part). Changed: `src/lib.rs` (+31), `Cargo.toml` (dev-dependency `engine` gains `bench-phases`), `golden_scenarios.rs`/`common/props.rs` (`worldgen: BeltsParams::default()`), the reference game's `tests/common/bench_run.rs` (12 lines: re-exports `gate`, wraps `run_in_release` with `reference-sim`). Deleted: `spike_repr.rs`, `spike_forecast.rs`, `common/{repr,repr_a,repr_b,forecast,bench_run,mod}.rs` (4,949 lines).

**Changed from the brief, and why.**
- *Genesis sees no params*, so the spec rides in the worldgen as the reference game's bench marker does: `FlatWorldgen` writes three raw tiles in chunk `(-1, -1)` (magic, seed, scale) and `genesis` reads them. `BenchSpec { seed, scale }` carries the seed (7, M40's) because `Mixed`'s line count depends on it.
- *`BeltsParams` serialises through `Option<RawParams>`*, so `None` is JSON `null` and every `scenario*.json` stays byte-identical; the goldens pass natively and under Node and Bun (`pnpm test`).
- *Spawners at genesis* cannot be put on an active list (`WorldWrite` has no `activate`): a genesis spawn is woken, and `Belts::tick` now activates a woken `Thing::Spawner` (never woken before: `TickCx` puts do not wake, so no golden moved). Rate: `period = round(65,536 / rate256)` (24 becomes 2,731, 0.01 % slower than the spike). M40's cycling spawners: the item's high bit `CYCLE` (0x8000) steps the item through `1..=6` from `item & !CYCLE` (encoding unchanged).
- *Views*: the world is 220 x 545 tiles (a row per belt chain), so a 4 x 2 grid would stack four views on one centre; the eight 256 x 256 views are stacked from the top edge to the bottom (x 128, y 128 + 289 i / 7).
- *The item cap binds*: M40's mixed world grew to 315,444 items uncapped; at the recommended 262,144 it reaches the cap about 30 ticks into the warm-up (262,039 at the end) and spawners then refuse `Full`. The workload is the brief's caps; recorded, not changed.
- *`advanceMedianMs`*: the `bench-phases` feature is on for the fixture's test binaries through the `engine` dev-dependency (the `.wasm` never carries it); the test reads `bench_phase::take()[Phase::Transport]` after each step.
- *`transport_budget_exceeds_arena_is_clean`*: `init_counts_the_transport_arena` proves the status only; this test adds the cleanliness on the belt game (a fresh thread: high-water under 1/16 of the arena during the refused init, 0 B left) and that the exact split is accepted.
- *Node twin*: lifts the four bandwidth caps to 10^9 B/s (the native bench is unpaced; at the default 16/64 KB/s caps the host would degrade a 6 KB-per-tick connection) and runs `hashAll: false`.

**The three gated runs** (`pnpm test:slow rust -t slow_tick_belts_large`, uptime checked before each, nothing interleaved), native release, Apple M3 Max:

| Run | Load 1/5 min | medianMs | p99Ms | maxMs | tick | advance | frames | frame B/tick |
|---|---|---|---|---|---|---|---|---|
| 1 | 2.64 / 4.90 | 0.7907 | 1.858 | 1.912 | 0.179 | 0.0423 | 0.619 | 50,756 |
| 2 | 3.04 / 4.78 | 0.7911 | 1.870 | 1.942 | 0.179 | 0.0419 | 0.620 | 50,756 |
| 3 | 2.65 / 4.54 | 0.7926 | 1.868 | 2.082 | 0.181 | 0.0426 | 0.623 | 50,756 |

Median 0.79 ms against the 5 ms limit (16 %): no optimisation round, no profile taken. Frames are 78 % of the tick (`build_frame` x 8 over 1,090 spawner entities that write most ticks); the advance is 42 µs, 2.5x the spike's 16.8 µs for B1 mixed (the production store carries geometry, the squash and cut rules and the caps; still 1.4 % of 0077 §3's 3 ms). Genesis builds the full world in 18 ms (geometry upkeep included). The draft baseline holds run 2's metrics.

**Inject-fail-revert of the gate.** `medianMs` in the draft set to 0.5538 (30 % under 0.7911): the run failed with `bench gate 'belts-tick' failed: bench belts-tick: medianMs 0.813 is 47% over its baseline 0.554 (limit 25%)`; restored, the same command passed (`matched: true`, no failures).

**Node twin** (`pnpm test:slow netcode -t "tick-belts-large node"`, release `fx-belts` `.wasm` through `createWorldServer`): median 1.140 ms, p99 2.75 ms, **1.44x** the native 0.789 ms (load 6.6 at the start: the suite's own build). The figure includes the TS host's sends, as `tick-large-save node` does; it is 0077 A7's ratio for the manager to add to the Amendment.

**Snapshot** (`slow_snapshot_belts_large`, after 60 ticks): whole store 1,415,875 B, encode 5.8 ms (inside M36's 83.3 ms proxy), decode 13.2 ms; the transport section is 1,390,522 B (98.2 % of the bytes), encode 0.31 ms, decode 9.4 ms (most of the store's decode: the tile index is rebuilt). Restored store hashes equal to the live one.

**Phone split** (`transport_phone_caps_fit_split`): the largest `(lines, 8 x lines)` with `lines` a multiple of 1,024 inside 0007 §8's 8 MiB slack is **(16,384 lines, 131,072 items), 8,273,936 B** (16,384 + 1,024 does not fit); the recommended caps are 16,482,320 B (0079 §16), also pinned. M57's phone candidates.

**Other results.** `pnpm test rust`: 914 tests, 1.6 s of 10 s. `pnpm test:slow rust -t slow_tick_large_save` (the reference game through the moved helper): pass, median 1.82 ms, gate matched. Full `pnpm test`: all five suites pass (load 3.5 at start). `pnpm lint`: pass. `pnpm test:slow rust`: 16 tests pass, 53 s in the suite, 67 s wall (load 15 at its start from a foreign spike; `belts-tick` median 0.833 ms passed the gate, a `maxMs` warn line, not gated).

**Review fixes** (implementer, 2026-10-11, the review's findings 1-3 and 5-9; finding 4 and 0077 A7 are the manager's). These supersede the paragraphs above where they differ.
- *A stationary world (1).* The benchmark's item cap is now 393,216 (`BENCH_MAX_ITEMS`, `tests/common/bench_host.rs`; the recommended game caps stay 262,144 and are not what the bench pins), and the Node twin uses the same cap. `measure_tick` reads at tick 200 and tick 1,400 the items on sink lanes vs dead-end lanes, the refused `insert_back` calls per tick over the window's first and last ten ticks, and the spawners that never inserted. **Uncapped:** sink lanes 200,000 to 200,000; dead-end lanes 59,795 to 115,444; total 259,795 to 315,444 (+21.4 %, exactly M40's uncapped figure). Refusals per tick are 327 sink / 5.4 dead-end over the first ten ticks and 327 / 115 over the last ten. 0 sink-lane spawners and 6 dead-end ones never inserted. **Capped at 262,144** (the earlier config, one run): the sink lanes fell to 152,643 (-24 %) and refusals rose to 404 / 184, which confirms the review's starvation. The 5 % rule on the *total* cannot hold for `Mixed` as M40 defines it: its dead-end lanes fill by design (a compression front moving back), and the 327 sink-lane refusals per tick are the saturating feed (`rate256 = 256` tries every tick and is refused `NoRoom` about 5 ticks in 8), not starvation. The test therefore asserts what stationarity means here: sink-lane items within 5 % (0.0 %), no sink-lane spawner idle, and the item cap never met (no `Full`). The capped config fails the first assertion, which serves as the inject. Before/after the cap change (medians of three): advance 0.042 to 0.044 ms, frames 0.62 to 0.68 ms, whole tick 0.79 to 0.86 ms.
- *Re-measured gated runs* (`pnpm test:slow rust -t slow_tick_belts_large`; 1-min/5-min load 3.96/4.36, 3.95/4.42, 3.84/4.38): medianMs 0.8645 / 0.8628 / 0.8542, p99 2.06 / 2.06 / 1.96, advance 0.0446 / 0.0441 / 0.0431, frames 0.678 / 0.681 / 0.675, 53,501 B of frames per tick. The draft baseline holds the middle run with refreshed conditions. Inject-fail-revert redone: `medianMs` 0.604 (30 % under) gave `medianMs 0.856 is 42% over its baseline 0.604 (limit 25%)`; restored, it passes with `matched: true`.
- *Ten runs for the floor (5).* The release binary alone (`--exact`, no rebuild), 1-min load 3.46-3.85: 0.8522, 0.8495, 0.8457, 0.8502, 0.8572, 0.8570, 0.8563, 0.8556, 0.8458, 0.8445 ms. The range is 1.5 % (2.4 % over all 13 runs), far under 10 %, so no 0047 `minDeltaMs` is proposed. One run inside the full `pnpm test:slow rust` (all `slow_*` tests in parallel, the old config) read +5 % over its quiet median; the baseline's conditions record both.
- *Native vs `.wasm` genesis (2).* `golden/scenario-bench-64.json` (`bench: {seed 7, scale 64}`: 78 lines, 3,906 items, 22 spawners; `maxLines` 256 because the tile index needs room for 1,562 lane-tiles, and 128 refused `set_segments`, which the counts caught; `maxItems` 8,192; 300 ticks) with `golden-bench-64.json` `46f44b15f176be73` from `pnpm golden belts`. The thirteen earlier hashes are unchanged. `belts_golden_bench_64` asserts the hash, and after every tick the lines, the spawners and `genesis + spawned == live + sunk`. Inject: a marker carrying seed + 1 failed natively (lines 62 vs 78) and under Node and Bun (`got 7bb98854fa32ba62, golden has 46f44b15f176be73`). Scale 32 failed natively (lines 128 vs 78) and under Node and Bun (`got 55f9bfe1110b530a`). Both reverted.
- *Node twin (3).* It runs `debugHashMode: 'production'` as the native `BenchHost` does. It fails without the world: frame bytes per tick must exceed 20,000 (53,467 measured), and the line count is read back from a snapshot's tail (`next_id - 1` = 3,810). Inject `worldgen: null`: `expected 36 to be greater than 20000`; reverted. The ratio is now against the gated native median in `baselines/belts-tick.json`: 1.244 ms = **1.44x** 0.863 ms (load 3.65/4.96). The twin lifts the bandwidth caps and `tick-large-save node` does not, so the two twins' ratios differ in method.
- *`Thing::Cycling` (6).* A cycling spawner is its own appended entity variant, made only by the bench genesis, rather than a `cycle: bool` field: a field would change the encoding of every spawner-holding golden. `Op::Spawner`'s `item` again means the item for any `u16`, and `CYCLE` is gone. `bench_cycling_spawners_cycle_kinds` checks that after 600 ticks at 1/64 every cycling sink lane's rear line holds only kinds 1..=6 and more than one of them. Inject: a constant-kind formula failed with `line 13 holds 1 kind(s): [0, 0, 0, 36, 0, 0, 0]`; reverted.
- *Wording and nits (7, 9).* The phone pair (16,384, 131,072) is an upper bound, not a usable cap: 0007 §8's 8 MiB line is "lists, timers, players, and slack", and the pair leaves 114,672 B of it (said in the test's doc). `belts-snapshot` metrics are `encodeMs`, `decodeMs`, `bytes` (now 1,414,787: the cycling variant), `transportBytes`, `transportEncodeMs`, `transportDecodeMs`; there is no `totalMs`. `fixtures/belts/CLAUDE.md` cites commit `864cb3a8` only. The `Mixed` world has no merges or forks, so 0079 §16's per-merge cursor question stays open for M44b's property worlds or M56. The marker is now four tiles of the world's plain kind (`Tile::new(0, 0, aux)`) with the data in `aux` (magic 0xBE17, seed low and high halves, scale; `BenchSpec.scale` is a `u16`).
- *Finding 8, accepted as is.* The bench world stays in the fixture's default build. The fixture ships nowhere, and the `bench-64` golden needs the genesis path in the plain `.wasm` that `pnpm golden` and the determinism leg build.
- *Verification.* `pnpm format`, `pnpm lint`: pass. `pnpm test rust -t belts_`: 21 pass. `pnpm golden belts`: idempotent, one file added. `pnpm test wasm -t determinism`: 49 pass. `pnpm test:slow rust -t slow_tick_belts_large`: pass, gate matched. `pnpm test:slow netcode -t "tick-belts-large node"`: pass. Full `pnpm test` at load 3.94/4.86: rust 916, unit 381, wasm 215, netcode 149, browser 259, all pass.

**Manager gate (2026-10-12).**
- *Stationarity decision.* The bench asserts what `Mixed` can promise: the sink lanes stationary (items within 5 %, measured 0.0 %; no sink-lane spawner idle) and the item cap never binding (no `Full`). The dead-end lanes filling between tick 200 and 1,400 (+21 % on the total) is M40's `Mixed` by definition and deterministic, so the gate compares like with like; a total-within-5 % rule is not demanded. The 262,144-item config failing the sink-lane assertion (-24 %) is the inject.
- *Reruns.* `pnpm test rust -t belts_` 21 pass; `transport_phone_caps`, `bench_world_at_genesis`, `transport_budget_exceeds`, `bench_cycling`, `init_counts_the_transport` pass singly; `pnpm lint` green; `pnpm golden belts` idempotent (`golden-bench-64.json` `46f44b15f176be73`, the thirteen earlier hashes unchanged). Masks grep over the diff: `#![allow(dead_code)]` on the shared `common` module, `#[allow(unused_imports)]` on the reference game's `bench_run` re-export, `clippy::disallowed_types` on the bench timers (the reference bench's pattern); no skipped or ignored test, no tolerance beyond the plan's.
- *Gate run and baseline.* `pnpm test:slow rust -t slow_tick_belts_large` at 1-min/5-min load 3.10/5.19: medianMs 0.8815 (matched against the draft's 0.8628, +2.2 %), p99 2.01, advance 0.0452, frames 0.697, 53,501 B of frames per tick. That record was promoted with `pnpm bench:baseline belts-tick` (the baseline holds the tool's latest record, never a hand-typed one; `gated`, `limits` from `BENCHES`). Fourteen runs span 0.8445-0.8815 ms (4.4 %), inside the 25 % rule without a 0047 floor.
- *Node twin rerun.* 1.276 ms, 1.48x the then-gated 0.863 ms (1.45x the promoted 0.8815); warn-only, recorded. 0077 A7 refreshed with the re-measured figures.
- *Full tiers.* `pnpm test` at load 2.37/4.05: rust 916, unit 381, wasm 215, netcode 149, browser 259, all pass; `pnpm test:slow` (every suite, started at 1-min load 11.1 right after the browser suite): rust 16, unit 4, wasm 26, netcode 15, browser 90, frame-bench 2, all pass; inside it `belts-tick` read 0.919 ms (+4.3 % over the baseline, gate matched; a `maxMs` 4.47 warn line, not gated) and the Node twin 1.242 ms (1.41x).
- *Open.* 0079 §16's per-merge cursor (M56 or M44b's property worlds); the 5-min load rule for gated runs stays as the run-tests skill says.
