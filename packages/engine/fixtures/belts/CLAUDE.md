# fixtures/belts (`fx-belts`)

The engine's belt fixture (`PLAN.md` M40 onward; docs/decisions/0076 §9: engine tests never use the
reference game). It will pin `engine::transport` (lines, runs, hand-offs, forecasts) through
native tests, `.wasm` goldens and browser pages.

**M40 state:** a skeleton `Game` (one 1x1 `Marker` entity, `Action::Noop`, flat grass worldgen) so
the crate builds in `pnpm test`'s `fixtures` step and the allowlist and ABI-registry tests cover it.
No belt rules yet (M42).

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
