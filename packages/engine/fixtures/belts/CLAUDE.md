# fixtures/belts (`fx-belts`)

The engine's belt fixture (`PLAN.md` M40 onward; docs/decisions/0076 §9: engine tests never use the
reference game). It pins `engine::transport` (lines, runs, hand-offs, forecasts) through
native tests, `.wasm` goldens and browser pages.

**The request pattern (M42b, `src/lib.rs` module doc).** `Action::Request(Op)` validates the op's
shape and spawns a `Thing::Request` entity, nothing else: 0076 §6 makes `transport_mut()` a debug
panic in `apply`. The spawn auto-wakes into the same tick's `next_woken`, where `Belts::tick` runs
the op through `transport_mut()` and despawns the request (so a request applied at tick T has built
its line by the end of T). Ops: `Chain { from, dir, tiles, speed, items_at_rest }` (one lane of
`tiles x 256` positions; a belt is two chains; up to 8 `(item, pos)` landed by `insert_at`),
`Link { from_line, to_line }` (`Next`), `Spawner { line, item, period }`, `Sink { line }`,
`DeadEnd { line }`. Ops name lines by chain order: `Global::lines[i]` is the `i`-th chain's
`LineId` (32 slots, `0` = refused by `create`; a `Chain` past 32 creates nothing). A `Spawner` request becomes, in place, a `Thing::Spawner`
on the `"spawner"` active list: `acc += 256` per tick; at `acc >= period` (1/256 ticks per item,
`>= 256`) one `insert_back`, accepted `acc -= period`, refused `acc -= 256` (held, never a burst);
the spawner is written only when its state changed, so a backed-up one costs no delta.
`Action::Noop` stays first; `SCHEMA_VERSION` 2.

**Goldens (M42b, `tests/golden_scenarios.rs`).** `pnpm golden belts` writes them from the `.wasm`
under Node; the native tests parse the same scenario files (`connect` is `Joined` then `Connected`)
and assert a property after every tick besides the hash: `scenario.json`/`golden.json` is
`straight-chain` (spacing 64 along a saturated two-line path, phase fixed by the first insert, the
hand-off landing), `-deadend-backup` (gaps `>= 64` on every lane every tick, positions pinned at tick 75 mid-squash,
4 items per tile per lane at 0, 64, 128, 192 at tick 300), `-spawn-to-sink`
(`spawned == live + sunk`), `-big-step` (speed 72: two items land in one tick). Config: `maxLines` 64,
`maxItems` 4,096. `transport_request_is_deferred_to_tick` runs `Belts::apply` between steps and
asserts no line until the next tick. Commands: `pnpm test rust -t belts_golden`,
`pnpm test rust -t transport_request`; the `.wasm` replays them under Node and Bun in
`pnpm test wasm -t determinism` (the discovery leg of `determinism.test.ts` and `bun-leg.mjs`).

**The spike (M40, native only, ships nothing):** `tests/spike_repr.rs` times the three item
representations of 0077 (A per-item list, B1 linked runs, B2 contiguous runs) on the standard belt
world. `tests/common/world.rs` builds that world (`bench_world(seed, regime)`: 50,000 tiles,
~250,000 items, `speed = 24`, four regimes) as plain `LineSpec` data, reused by M45's gated benchmark.
`tests/common/bench_run.rs` is a copy of the reference game's release re-run helper (M45 moves it
into `engine::testing`). Commands: `pnpm test rust -t repr_`, `pnpm test rust -t bench_world`,
`pnpm test:slow rust -t slow_spike_item_representation` (release, one `BENCH_SAMPLE` per candidate x
regime, also written to `test-results/rust/bench/spike-item-representation.json` since nextest hides
a passing test's output; `SPIKE_ONLY=B1/mixed SPIKE_PROFILE_REPEAT=150` on the release test binary
measures one cell and repeats it for a profiler). The numbers live in 0077's Amendment; the spike
stays until M45 deletes it.

**The forecast spike (M41, native only):** `tests/spike_forecast.rs` measures 0078's cheap forecast
on B1 (`common/forecast.rs`: the `Tracker`, an `Observer` of `ReprB` whose hooks only observe; the
forecast builder; the byte model). `Regime::SaturatedView { jam_pct, period }` is its own world
(`saturated_view_world`: 256 x 144 belt tiles, every lane packed and fed, toggled sinks); every line
has a tile `Span`, and `visible_at_centre` gives a regime's visible set. Commands:
`pnpm test rust -t forecast_`, `pnpm test rust -t saturated_view`,
`pnpm test:slow rust -t slow_spike_forecast_cells` (one `BENCH_SAMPLE` per world x depth with the
variants inside (`variants_at`), plus the tracker's tick cost; also in `test-results/rust/bench/spike-forecast.json`).
`forecast_client_matches_advance` is the arbiter: a client that follows only the messages must
draw every visible item where the advance puts it. The numbers live in M41's Deviations and 0078's
Amendment.
