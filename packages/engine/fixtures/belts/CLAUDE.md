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
