# M42: Transport core

Status: not started · After: 40 · Tyler-dependent: no · Split 2026-10-11: the `fx-belts` requests, scenarios and goldens moved to `42b-transport-core-goldens.md` (sizing rule)

## Goal
`engine::transport` exists as sim state in `Store<G>`: lines with the winning item representation of 0077, the per-tick `advance` with squash, plain hand-off (multi-item crossing), `DeadEnd` and `Sink`, update order, `insert_back`, encoding, hashing and snapshots, the `max_lines`/`max_items` params, and the `WorldRead`/`WorldWrite` accessors with the host-tick-only rule. The rule cases of M40 pass against the production module, the host-tick-only access rule is pinned, and zero allocation per tick is proven by a counting-allocator test. The `fx-belts` requests, scenarios and goldens that drive it across runtimes are M42b.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§1, §2, §3 `insert_back`, §6, §7, §8)
3. `docs/decisions/0077-transport-item-representation.md` (Amendment: the winner and its shape)
4. `docs/architecture/simulation.md` ("The `Game` trait", "The tick": `Sim::step` order, `TickCx`, auto-wake)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md` (the Rust no-allocation principle), `.claude/rules/prediction.md` (`?` on every read: `transport_mut()` is `Unknown` under prediction). Skills: `.claude/skills/run-tests/SKILL.md`.

## Scope
- `crates/engine/src/transport/`: `mod.rs` (`Transport`, `LineId`, `Item`, `SPACING`, `Output`, errors `Full`/`NoRoom`/`BadSpeed`), `line.rs` (a line's record: `len`, `speed`, `out`, its items in the winner's store, a `jam` summary the forecaster will read), `advance.rs` (0076 §2: order, squash, `Next` with `k >= 1` items crossing per tick, `DeadEnd`, `Sink` with a per-line `sunk` counter), `order.rs` (reverse topological order with cycle cutting at the lowest id, recomputed when `set_out`/`create`/`destroy` change the graph; a stale-order flag, never a recompute per tick), `codec.rs` (encoding in ascending `LineId`, every field; decode validates the spacing invariant and rejects with `CodecError`).
- `Store<G>` gains `transport: Transport`; `Store::encode`/`decode`/`state_hash` include it; `Sim::step` calls `transport.advance()` after `G::tick` and before `end_tick`.
- `WorldParams` gains `max_lines`, `max_items` (0076 §8 defaults); `WorldConfig.params` (`sim-config.ts`, `maxLines`, `maxItems`) and the world-config JSON of scenarios carry them; the transport arena is reserved from them at `Store::new`.
- Accessors: `WorldRead::transport(&self) -> &dyn TransportRead` (`len`, `speed`, `out`, `count`, `front`, `items_in(line, f)` for tests; on a client replica reads of an unknown line are `Unknown`), `WorldWrite::transport_mut(&mut self) -> Result<&mut dyn TransportWrite, Unknown>`: `Ok` from `TickCx`, `genesis` and `migrate`; `Err(Unknown)` from `Authority` inside `apply`/`on_player` (a debug assertion names the rule) and from `Predicting`.
- The access-rule tests use a small local test game inside `crates/engine/tests/main/transport_access.rs` (the `no_alloc_tick_state.rs` pattern), not `fx-belts`: `apply` calling `transport_mut()` gets `Unknown` (debug assertion on the host), `Predicting` gets `Unknown`, `TickCx` and `genesis` get `Ok`.
- `tests/no_alloc_transport.rs` (own binary): `thread_live_bytes` and `thread_high_water_bytes` unchanged across 600 ticks of a 1/64 M40 bench world (built straight into `Transport` through `create`/`set_out`/`insert_back`, spawners and sinks driven by the test) with a negative control (an injected per-tick `Vec` growth that must trip it).
- The snapshot container bump: `snapshot::CONTAINER_VERSION` in `persist/snapshot.rs` (today `1`; `persist/CLAUDE.md` names the blessing command for the byte goldens that stamp it) goes to `2`, with the test that a container-version-1 snapshot reports the persist error the ABI maps to `SaveIncompatible`, so existing saves refuse to load cleanly.

## Non-scope
- The `fx-belts` request pattern, the four scenarios and their goldens under Node and Bun, `fixtures/belts/CLAUDE.md` (M42b, split 2026-10-11 to meet the sizing rule: this milestone is the engine crate, the TS params and the tests inside the engine crate).
- `Merge`, `Fork` (M44); `split`/`join`/`extend`/`rescale`/`insert_at`/`remove_at`, geometry, chunk sets, the tile index (M43); replication and forecasts (M46, M47; `advance` leaves hooks: the `jam` summary and a `touched` bit per line the forecaster will read); rendering (M49).

## Files, packages and crates touched
- `packages/engine/crates/engine/` (`transport/`, `store/mod.rs`, `sim/mod.rs`, `world_access.rs`, `authority.rs`, `predict/predicting.rs`, `persist/snapshot.rs`, `tests/no_alloc_transport.rs`).
- `packages/engine/src/sim-config.ts` (two params) and `scripts/lib/engine-test-binary-layout.test.mjs` (allowlist the new binary).

## Seams
**Provides:** `engine::transport::{Transport, LineId, Item, SPACING, Output, TransportRead, TransportWrite, Full, NoRoom}`; `TransportWrite::{create, destroy, set_out, set_speed, insert_back}`; `TransportRead::{len, speed, out, count, front, items_in, lines_len}`; `WorldRead::transport`, `WorldWrite::transport_mut`; `WorldParams::{max_lines, max_items}` and `WorldConfig.params.{maxLines, maxItems}`; `Line::jam()` and `Line::touched()` (M47).
**Consumes:** M40's winner module shape (0077 Amendment A6) and `bench_world` (`fixtures/belts/tests/common/world.rs`, read as data by the no-alloc test); `Store`, `Authority`, `TickCx`, `Predicting`, `Sim::step` (Phase 3).

## Planning decisions
- **Winner and settled rules from M40** ([0077](../decisions/0077-transport-item-representation.md) Amendment A6, A6b): the store is B1 (linked runs in one arena, per-line jam cursor, canonical merged form); a squashed pair across a hand-off is legal and `insert_*` check their own line only; every `count` merge guards `u16` overflow; the codec's spacing check is within a line. B2 (a contiguous ring per line) is the measured fallback if a per-call scan ever matters (A4).
- **`advance` after `G::tick`.** The game's inserts of a tick (spawners, later inserters) land before the lines move, so `insert_back`'s landing at `len - speed` is exactly where the item sits after this tick's move; the opposite order would make every insert account for a move it missed. One order, stated here, pinned by `spawn-to-sink`.
- **The access rule is pinned here, the request pattern in M42b.** `transport_in_apply_is_unknown` and `transport_predicting_is_unknown` prove 0076 §6 with a local test game; `fx-belts` (M42b) routes every topology change through a `Request` entity because of that rule.
- **The jam summary.** `Line::jam()` reports the position of the rearmost packed item at the front (the "jam end"), maintained by `advance` at no extra pass; M47's cheap forecast reads it for `stop`.
- **Order recompute on edit only.** A `graph_dirty` flag set by `create`/`destroy`/`set_out`; `advance` recomputes once when set. Cycle cutting at the lowest `LineId` in each strongly connected component (Tarjan, preallocated scratch sized by `max_lines`).
- **Snapshot bump, saves lost.** Existing reference-game saves become `SaveIncompatible`; the milestone's report tells Tyler (a cost, his to object to); no migration is written.

## Order of work
1. Types, `Transport::new(max_lines, max_items)`, `create`/`destroy`/`set_out`/`set_speed`, the store, the order; unit tests.
2. `advance`: squash, `Next` with multi-item crossing, `DeadEnd`, `Sink`; `insert_back`; the rule cases ported from M40's `repr_rule_cases` (same table, now against the production module).
3. `Store` integration, `WorldParams`, `sim-config.ts`, accessors with the host-tick-only rule, `Sim::step` placement; the snapshot bump and its test.
4. `no_alloc_transport.rs` and its negative control; `cargo fmt`, clippy, the binary-layout allowlist.
5. Deviations, `crates/engine/CLAUDE.md` line, commit.

## Tests added
Rust suite: `transport_rule_cases` (M40's table), `transport_order_reverse_topological`, `transport_order_cuts_cycles_at_lowest_id`, `transport_codec_round_trip_and_rejects_spacing_violation`, `transport_full_at_caps`, `transport_in_apply_is_unknown`, `transport_predicting_is_unknown`, `store_hash_includes_transport` (two stores differing only in one item hash differently), `snapshot_old_layout_is_incompatible`; `tests/no_alloc_transport.rs` (`transport_tick_no_alloc`, `transport_tick_no_alloc_control`).

## Exit criteria
- [ ] `transport_rule_cases` (M40's table, 20 cases) passes against `engine::transport`, with an inject-fail-revert.
- [ ] `transport_tick_no_alloc` reports 0 (live and high-water) and its control trips.
- [ ] `transport_in_apply_is_unknown` and `transport_predicting_is_unknown` pass, each with an inject-fail-revert.
- [ ] `snapshot_old_layout_is_incompatible` passes; the report to Tyler names the lost saves.
- [ ] The fast `rust` suite stays inside 10 s (a 1/64 world is the fast-tier size).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t transport_` · `pnpm test rust -t snapshot_old_layout` · `pnpm test && pnpm lint`

## Budgets
- Allocation per tick (0016, Rust side): `transport_tick_no_alloc`.
- Fast-tier suite budget (`scripts/suites.mjs`): `rust` 10 s.

## Context artifacts
`crates/engine/CLAUDE.md` "Layout": one line for `transport/` (sim-grade; host-tick-only writes; the one direct-mutation exception of 0076 §7). `docs/architecture/simulation.md` "The tick": the `advance` step (one sentence; the subsystem doc itself is M58's). `packages/engine/src/CLAUDE.md` or `sim-config.ts`'s own doc: the two params.

## Manual device checks
none

## Deviations
(filled in during execution)
