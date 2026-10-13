# fixtures/belts (`fx-belts`)

The engine's belt fixture (M40 onward; 0076 §9: engine tests never use the reference game): it
pins `engine::transport` (`docs/architecture/transport.md`) through native tests, `.wasm` goldens
and browser pages.

**The request pattern (M42b, `src/lib.rs` module doc).** `Action::Request(Op)` validates the op's
shape and spawns a `Thing::Request` entity, nothing else: 0076 §6 makes `transport_mut()` a debug
panic in `apply`. The spawn auto-wakes into the same tick's `next_woken`, where `Belts::tick` runs
the op through `transport_mut()` and despawns the request (so a request applied at tick T has built
its line by the end of T). Ops: `Chain { from, dir, tiles, speed, items_at_rest }` (one lane of
`tiles x 256` positions; a belt is two chains; up to 8 `(item, pos)` landed by `insert_at`), `Link {
from_line, to_line }` (`Next`), `Spawner { line, item, period }`, `Sink { line }`, `DeadEnd { line
}`. Ops name lines by chain order: `Global::lines[i]` is the `i`-th chain's `LineId` (32 slots, `0`
= refused by `create`; a `Chain` past 32 creates nothing). A `Spawner` request becomes, in place, a
`Thing::Spawner` on the `"spawner"` active list, which on the tick it joins gives its line the engine schedule once (M53, 0079 §21: `set_spawner(line, Schedule { period, acc, kinds, next })`) and is never written again: the engine runs the rule at the start of every `advance` (`acc += 256` a tick; at `acc >= period`, 1/256 ticks per item, `>= 256`, one `insert_back`, accepted `acc -= period`, refused `acc -= 256`: held, never a burst); the schedule is line state (saved, restored, carried to the back piece by surgery), `declare_spawners` stays the default, and the tests' conservation reads the engine's store-wide insert count (`Transport::scheduled_inserts_total`, not state). `Action::Noop` stays first; `SCHEMA_VERSION` 2. M43b adds `Cut`, `Join`, `Extend`, `Shrink`, `Rescale`, `Insert`, `Remove`,
`TakeFront`, `Segments` and a `Thing::Tally` of accepted item requests; M44b `Merge`, `Fork`
(`set_out`) and `Destroy` (counted in `Thing::Destroyed`); M46 `Speed` (`set_speed`, appended
last so no encoded op moved); M61 `ForkPair` (a fork paired with a partner: the engine's input turn, appended last); M48b `Belt` and `Action::Probe { tile }` (reads `lines_at` in `apply`, so `NotPredictable` on a client). Semantics: the `src/lib.rs` module doc.

**Goldens (M42b, `tests/golden_scenarios.rs`).** `pnpm golden belts` writes them from the `.wasm`
under Node; the native tests parse the same scenario files (`connect` is `Joined` then `Connected`)
and assert a property after every tick besides the hash: `scenario.json`/`golden.json` is
`straight-chain`, `-deadend-backup`, `-spawn-to-sink`, `-big-step` (M42b; `maxLines` 64, `maxItems`
4,096); `-edit-while-running`, `-inserter-like`, `-geometry-arc` (M43b), `-sideload-saturated`,
`-sideload-contested`, `-fork-50-50`, `-fork-blocked-side`, `-big-step-fork`, `-forty-actions`
(M44b; 42 actions: `runScriptScenario` acks its encoder, so no 32-action cap) at `maxLines` 16,
`maxItems` 512; `-mixed-speeds` (M56: four `Next`-linked chains at 24, 72, 96, 24, spacing held across
every speed change, throughput the slowest line's). `-fork-pair` (M61, `Op::ForkPair`: two saturated inputs paired on one fork, one output blocked until tick 400, then both open). Each property is in its test's doc. `belts_op_*` run each op once;
`transport_request_is_deferred_to_tick` runs `Belts::apply` between steps and asserts no line until
the next tick. Commands: `pnpm test rust -t belts_golden`, `-t belts_op`, `-t transport_request`;
the `.wasm` replays the goldens under Node and Bun in `pnpm test wasm -t determinism` (the discovery
leg of `determinism.test.ts` and `bun-leg.mjs`).

**Properties (M44b, `tests/props.rs`; M56 reuses `tests/common/props.rs`, included by `#[path]`).**
Seeded worlds on a native `Sim`: `prop_conservation`, `prop_spacing_invariant` (two pinned
exceptions), `prop_throughput`, `prop_ring_lap_time` and `_packed_block` (found red in M44b, fixed
by M44's cut-budget round, 0079 §11). `pnpm test rust -t prop_`.

**The bench world (M45, `src/bench.rs`, `src/bench/world.rs`).** `BeltsParams { bench:
Some(BenchSpec { seed, scale }) }` (JSON `params: {"bench": {"seed": 7, "scale": 1}}`; `null` is the
empty world of every scenario) makes `Belts::genesis` build M40's standard `Mixed` world (3,810
lines, 50,000 tiles, 250,000 items at seed 7) through `transport_mut()`, one straight segment per
line, and 1,090 genesis-spawned spawners (activated on tick 1; `Thing::Cycling` for M40's
mixed-kind chains). The worldgen carries the spec in the `aux` of four plain tiles at `y = -1`,
`x = -1..=-4`; M47b's `BenchSpec.regime` (`BenchRegime`, `bench.rs` doc) three more at `x =
-5..=-7`, plain for `Mixed` (`golden-bench-64.json` holds): `SaturatedView` is built at genesis with
`Thing::Jam` sink toggles, `InserterLike` with a `Thing::Inserter`; `MixedFeeders` (M48c) is `Mixed` with a stateless `Thing::Feeder` per spawner (schedule `period 256, acc 0, kinds 0`). Since M53 no regime writes an entity after genesis (`-t belts_feeders_write_no_delta`, every regime: 0 entity deltas over 600 ticks); the spawners' inserts come at the start of `advance`, after the tick's inserter edits. The benchmark's item cap is 393,216 (`BENCH_MAX_ITEMS`), so it never binds. The dev-dependency on `engine` turns on
`bench-phases`, so a test reads the transport advance from `engine::bench_phase::take()`.
`tests/bench_belts.rs`: `pnpm test rust -t bench_`, `-t transport_phone_caps`, `-t
transport_budget_exceeds`; `belts_golden_bench_64` (`golden/scenario-bench-64.json`) replays the
genesis at 1/64 natively, under Node and under Bun; `pnpm test:slow rust -t slow_tick_belts_large` (gated by
`baselines/belts-tick.json`, 5 ms median; re-runs itself in release through
`engine::testing::bench`), `-t slow_snapshot_belts_large` (reported); the `.wasm` twin is `pnpm
test:slow netcode -t "tick-belts-large node"`. M48: `-t belts_restore_keeps`, and `Loopback` tests in
`tests/common/replication.rs` (a module here): `-t region_hash_agrees`, `-t degraded_bundles`.

**The client (M49, M50, `src/client.rs`).** `BeltsClient::extract` draws one belt sprite per belt tile in view (`draw_belts`: `Transport::for_each_tile_in`, atlas id 2, layer 1, grey), then `transport::draw::draw_items` with `FixtureStyle` (sprite = kind mod 3, the test atlas's ids, sized by the atlas, colour by kind, layer 2, no item below 20 px a tile; `LAST_STATS` holds the last call's stats). `tests/drawlist_belts.rs`: `drawlist_belts_hash_golden` (1/64 `SaturatedView` (20, 20), 16 ticks, a frame at 775 ms: 90 belt tiles, 720 items; `tests/golden/drawlist_belts_hash.hash`, also read by `tests/wasm/drawlist.test.ts`), `no_alloc_drawlist_belts_2000_items` (the gc page's world: 0 B over 300 frames), `slow_draw_items_time` (ns per 1,000 items, reported). Pages: `gc-belts`; `belts-bench` (M50, `bench.frame_belts @slow`: scale 1 `SaturatedView` at 256 and 64 tiles across, `pnpm test:slow frame-bench -t frame_belts`, `profile-frame --fixture belts --zoom max|<n>`).
**The spikes (M40, M41) are deleted (M45):** numbers in 0077's and 0078's Amendments, code (`tests/spike_*.rs`, `tests/common/{repr*,forecast,bench_run}.rs`) at `864cb3a8`.
