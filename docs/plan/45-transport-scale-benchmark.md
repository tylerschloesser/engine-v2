# M45: Transport scale benchmark

Status: not started · After: 41, 44b · Tyler-dependent: no · Revised 2026-10-12 from 0079 §5, §14-§16 (the caps are opt-in and 16.5 MiB at the recommended values)

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
- [ ] `slow_tick_belts_large` median at most 5 ms on the baseline machine at a 1-minute load under 5, three runs; `belts-tick.json` recorded with conditions; the gate trips when the baseline's `medianMs` is edited to a value 30 % under the measurement (inject-fail-revert of the gate).
- [ ] `tick-belts-large node @slow` reports the WASM ratio in Deviations; 0077's Amendment gains the figure.
- [ ] `transport_phone_caps_fit_split` pins the largest caps that fit the 8 MiB slack (literals), recorded in Deviations as M57's candidates; `transport_budget_exceeds_arena_is_clean` passes.
- [ ] The spikes are deleted; the rust fast tier is inside 10 s.
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow rust` are green; tag `belts-core-complete` on the pushed commit.

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
(filled in during execution)
