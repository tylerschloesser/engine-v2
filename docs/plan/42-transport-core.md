# M42: Transport core

Status: not started · After: 40 · Tyler-dependent: no

## Goal
`engine::transport` exists as sim state in `Store<G>`: lines with the winning item representation of 0077, the per-tick `advance` with squash, plain hand-off (multi-item crossing), `DeadEnd` and `Sink`, update order, `insert_back`, encoding, hashing and snapshots, the `max_lines`/`max_items` params, and the `WorldRead`/`WorldWrite` accessors with the host-tick-only rule. `fx-belts` drives it through tick-rule requests and pins the first goldens natively, under Node and under Bun. Zero allocation per tick is proven by a counting-allocator test.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§1, §2, §3 `insert_back`, §6, §7, §8)
3. `docs/decisions/0077-transport-item-representation.md` (Amendment: the winner and its shape)
4. `docs/architecture/simulation.md` ("The `Game` trait", "The tick": `Sim::step` order, `TickCx`, auto-wake)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md` (the Rust no-allocation principle), `.claude/rules/prediction.md` (`?` on every read: `transport_mut()` is `Unknown` under prediction). Skills: `.claude/skills/run-tests/SKILL.md` (goldens: `pnpm golden belts`).

## Scope
- `crates/engine/src/transport/`: `mod.rs` (`Transport`, `LineId`, `Item`, `SPACING`, `Output`, errors `Full`/`NoRoom`/`BadSpeed`), `line.rs` (a line's record: `len`, `speed`, `out`, its items in the winner's store, a `jam` summary the forecaster will read), `advance.rs` (0076 §2: order, squash, `Next` with `k >= 1` items crossing per tick, `DeadEnd`, `Sink` with a per-line `sunk` counter), `order.rs` (reverse topological order with cycle cutting at the lowest id, recomputed when `set_out`/`create`/`destroy` change the graph; a stale-order flag, never a recompute per tick), `codec.rs` (encoding in ascending `LineId`, every field; decode validates the spacing invariant and rejects with `CodecError`).
- `Store<G>` gains `transport: Transport`; `Store::encode`/`decode`/`state_hash` include it; `Sim::step` calls `transport.advance()` after `G::tick` and before `end_tick`.
- `WorldParams` gains `max_lines`, `max_items` (0076 §8 defaults); `WorldConfig.params` (`sim-config.ts`, `maxLines`, `maxItems`) and the world-config JSON of scenarios carry them; the transport arena is reserved from them at `Store::new`.
- Accessors: `WorldRead::transport(&self) -> &dyn TransportRead` (`len`, `speed`, `out`, `count`, `front`, `items_in(line, f)` for tests; on a client replica reads of an unknown line are `Unknown`), `WorldWrite::transport_mut(&mut self) -> Result<&mut dyn TransportWrite, Unknown>`: `Ok` from `TickCx`, `genesis` and `migrate`; `Err(Unknown)` from `Authority` inside `apply`/`on_player` (a debug assertion names the rule) and from `Predicting`.
- `fx-belts` grows the request pattern: `Action::Request(Op)` spawns a `Request` entity (plain data, one `Op` enum: `Chain { from, dir, tiles, speed, items_at_rest }`, `Link { from_line, to_line }`, `Spawner { line, item, period }`, `Sink { line }`, `DeadEnd { line }`); the entity's auto-wake lets `Belts::tick` execute it through `transport_mut()` and despawn the request. `Belts::tick` also runs the spawners (an active list) with `insert_back`. Scenarios (`golden/scenario-*.json`) drive everything through these actions.
- Goldens (`pnpm golden belts`, checkpoint hashes native/Node/Bun): `straight-chain` (one line pair fed to saturation, 400 ticks: speed, spacing, hand-off), `deadend-backup` (capacity 4 per tile per lane, boundary spacing), `spawn-to-sink` (conservation: spawned = live + sunk), `big-step` (speed 72: two items crossing in one tick).
- `tests/no_alloc_transport.rs` (own binary): `thread_live_bytes` unchanged across 600 ticks of a 1/64 mixed world with spawners and sinks running; with a negative control (an injected per-tick `Vec` growth that must trip it).
- The snapshot format version bump in `persist/identity.rs` (whatever stamps the snapshot layout; find it, bump it, add the test that an old-layout snapshot reports `SaveIncompatible`), so existing saves refuse to load cleanly.

## Non-scope
- `Merge`, `Fork` (M44); `split`/`join`/`extend`/`rescale`/`insert_at`/`remove_at`, geometry, chunk sets, the tile index (M43); replication and forecasts (M46, M47; `advance` leaves hooks: the `jam` summary and a `touched` bit per line the forecaster will read); rendering (M49).

## Files, packages and crates touched
- `packages/engine/crates/engine/` (`transport/`, `store/mod.rs`, `sim/mod.rs`, `world_access.rs`, `authority.rs`, `predict/predicting.rs`, `persist/identity.rs`, `tests/no_alloc_transport.rs`).
- `packages/engine/src/sim-config.ts` (two params) and `scripts/lib/engine-test-binary-layout.test.mjs` (allowlist the new binary).
- `packages/engine/fixtures/belts/`.

## Seams
**Provides:** `engine::transport::{Transport, LineId, Item, SPACING, Output, TransportRead, TransportWrite, Full, NoRoom}`; `TransportWrite::{create, destroy, set_out, set_speed, insert_back}`; `TransportRead::{len, speed, out, count, front, items_in, lines_len}`; `WorldRead::transport`, `WorldWrite::transport_mut`; `WorldParams::{max_lines, max_items}` and `WorldConfig.params.{maxLines, maxItems}`; `Line::jam()` and `Line::touched()` (M47); `fx-belts` `Action::Request`, `Op`, the spawner active list; goldens `straight-chain`, `deadend-backup`, `spawn-to-sink`, `big-step`.
**Consumes:** M40's winner module shape (its Deviations name the layout) and `bench_world`; `Store`, `Authority`, `TickCx`, `Predicting`, `Sim::step` (Phase 3); `testing::testkit::run_script`, `pnpm golden` (0020 §5).

## Planning decisions
- **`advance` after `G::tick`.** The game's inserts of a tick (spawners, later inserters) land before the lines move, so `insert_back`'s landing at `len - speed` is exactly where the item sits after this tick's move; the opposite order would make every insert account for a move it missed. One order, stated here, pinned by `spawn-to-sink`.
- **Requests, not direct writes.** `fx-belts` routes every topology change through a `Request` entity because 0076 §6 forbids `apply` from touching lines; the fixture thereby pins the rule (`transport_in_apply_is_unknown`: an `apply` that calls `transport_mut()` gets `Unknown` on the host in debug builds and under `Predicting`).
- **The jam summary.** `Line::jam()` reports the position of the rearmost packed item at the front (the "jam end"), maintained by `advance` at no extra pass; M47's cheap forecast reads it for `stop`.
- **Order recompute on edit only.** A `graph_dirty` flag set by `create`/`destroy`/`set_out`; `advance` recomputes once when set. Cycle cutting at the lowest `LineId` in each strongly connected component (Tarjan, preallocated scratch sized by `max_lines`).
- **Snapshot bump, saves lost.** Existing reference-game saves become `SaveIncompatible`; the milestone's report tells Tyler (a cost, his to object to); no migration is written.

## Order of work
1. Types, `Transport::new(max_lines, max_items)`, `create`/`destroy`/`set_out`/`set_speed`, the store, the order; unit tests.
2. `advance`: squash, `Next` with multi-item crossing, `DeadEnd`, `Sink`; `insert_back`; the rule cases ported from M40's `repr_rule_cases` (same table, now against the production module).
3. `Store` integration, `WorldParams`, `sim-config.ts`, accessors with the host-tick-only rule, `Sim::step` placement; the snapshot bump and its test.
4. `fx-belts` requests and spawners; the four scenarios; `pnpm golden belts`; `pnpm test wasm -t determinism` and the Bun leg.
5. `no_alloc_transport.rs` and its negative control; `cargo fmt`, clippy, the binary-layout allowlist.
6. Deviations, `crates/engine/CLAUDE.md` line, commit.

## Tests added
Rust suite: `transport_rule_cases` (M40's table), `transport_order_reverse_topological`, `transport_order_cuts_cycles_at_lowest_id`, `transport_codec_round_trip_and_rejects_spacing_violation`, `transport_full_at_caps`, `transport_in_apply_is_unknown`, `transport_predicting_is_unknown`, `store_hash_includes_transport` (two stores differing only in one item hash differently), `snapshot_old_layout_is_incompatible`; `fx-belts` golden tests for the four scenarios (`belts_golden_*`); `tests/no_alloc_transport.rs` (`transport_tick_no_alloc`, `transport_tick_no_alloc_control`).
`wasm` suite: the four goldens replay under Node and Bun through the existing determinism test (no new file; the fixture is discovered).

## Exit criteria
- [ ] The four goldens are written by `pnpm golden belts` from the `.wasm` under Node and match natively and under Bun; `deadend-backup` holds exactly 4 items per tile per lane at rest; `spawn-to-sink` conserves items.
- [ ] `transport_tick_no_alloc` reports 0 and its control trips.
- [ ] `transport_in_apply_is_unknown` and `transport_predicting_is_unknown` pass, each with an inject-fail-revert.
- [ ] `snapshot_old_layout_is_incompatible` passes; the report to Tyler names the lost saves.
- [ ] The fast `rust` suite stays inside 10 s and `wasm` inside 7 s (scenario sizes chosen for it; a 1/64 world is the fast-tier size).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t transport_` · `pnpm test rust -t belts_golden` · `pnpm golden belts` · `pnpm test wasm -t determinism` · `pnpm test && pnpm lint`

## Budgets
- Allocation per tick (0016, Rust side): `transport_tick_no_alloc`.
- Fast-tier suite budgets (`scripts/suites.mjs`): `rust` 10 s, `wasm` 7 s.

## Context artifacts
`crates/engine/CLAUDE.md` "Layout": one line for `transport/` (sim-grade; host-tick-only writes; the one direct-mutation exception of 0076 §7). `fixtures/belts/CLAUDE.md`: the request pattern and the goldens. `docs/architecture/simulation.md` "The tick": the `advance` step (one sentence; the subsystem doc itself is M58's).

## Manual device checks
none

## Deviations
(filled in during execution)
