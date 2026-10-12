# M48c: The late-join cost (list re-puts on snapshot, a stateless feeder regime)

Status: not started · After: 48b · Tyler-dependent: no (the default view is his: asked with M48b's numbers, the default keeps 256 x 144)

Added on 2026-10-12 from M48b's measurement ([0078](../decisions/0078-transport-forecast-replication.md) A10): the late join at scale takes 18.85 s against the Consequences' 10 s, and neither cause is the structure encoding the Consequences named.

## Goal
A late join sends each held line's list once, and the join is measured on a world whose feeders write no state, the shape the reference game's spawners must take; the measured figure and the remaining distance to 10 s are recorded for M53 and M57.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (A8, A10), `docs/decisions/0079-transport-core-decisions.md` (§17 (a): a chunk with anchored lines enters by snapshot and the hash covers structures; §19 (e); §20 (c): a lost frame re-snapshots held chunks)
3. `docs/plan/48b-replication-scenarios-and-join.md` Deviations (the join's sections and counts; `belts/join_at_scale`), `docs/plan/46-line-structure-replication.md` Deviations (why a snapshot forces its anchored puts)
4. `packages/engine/crates/engine/src/host/lines.rs` (`plan`: `frame.snapshots` → `scratch.forced`), `transport/replicate.rs` (what the replica does to a chunk's structures when its snapshot arrives), `fixtures/belts/src/lib.rs` (`Thing::Spawner`, the `"spawner"` list)
Rules: `.claude/rules/hot-paths.md`, `.claude/rules/determinism.md`. Skills: `run-tests`.

## Scope
- **Dedupe the forced re-put.** When a chunk's snapshot is sent to a connection, a line anchored in it that the connection already holds at its current `structure_version` (and whose list the client holds, not `unknown`) is not put again; a line not held, held at an older version, or `unknown` is put as today. The replica must keep the held structures and trajectories of a chunk across its snapshot (verify; if it clears them, the engine side of this item is the replica keeping them, and the chunk hash must still agree). Rust: `host_snapshot_does_not_reput_held_lines` (Loopback, a view whose lines are held before their chunk enters: puts counted once per line; chunk hashes agree; items exact), the lost-frame path (§20 (c)) still converges (`lost_frame_never_desyncs_a_held_chunk` green), `forecast_matches_host_under_budget` and the whole `forecast_`/`line_`/`host_` families green.
- **A stateless feeder.** `fx-belts` gains `Thing::Feeder { at, line, item }` (bench genesis only, on the `"spawner"` list): one `insert_back` attempt per tick, refusal dropped, no state, never written, declared to the tracker with `period: 256, acc: 0, kinds: 0`. A `BenchRegime::MixedFeeders` builds the `Mixed` world with feeders in place of every spawner (same lines, same items at rest; the item kind per chain as the world gives it; cycling chains get a plain feeder of their first kind). `belts_feeders_write_no_delta` (Rust: 600 ticks, the change log carries no entity delta from a feeder; `spawner_mismatches` 0).
- **Re-measure the join** (`belts/join_at_scale @slow` gains the `MixedFeeders` cell beside the `Mixed` one, both pinned): ticks and bytes by section to a fully held view at the default pacing; record in Deviations and 0078 A10's follow-up line (manager). Also the `Mixed` cell after the dedupe (the saved list bytes).
- Docs: `docs/architecture/sync-and-netcode.md` (the sentence on what a snapshot carries for lines), `fixtures/belts/CLAUDE.md` (the regime), `tests/netcode/CLAUDE.md`.

## Non-scope
- A smaller default view (Tyler's); a compact structure encoding (3 % of the join); the reference game's spawners (M53); the phone join (M57); position-window culling (0078 A6 (ii)).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/host/lines.rs` (and `host/mod.rs` if the snapshot path needs the held-version read), `transport/replicate.rs` or `client/replica.rs` only if the replica clears structures on a snapshot; `tests/main/`.
- `packages/engine/fixtures/belts/src/{lib,bench}.rs`, `fixtures/belts/tests/`, `fixtures/belts/CLAUDE.md`.
- `packages/engine/tests/netcode/belts-join.test.ts`, `support.ts`, `CLAUDE.md`; `docs/architecture/sync-and-netcode.md`.

## Seams
**Provides:** one list per held line on a join; the `MixedFeeders` regime (M53 and M57 measure against it); the join figures. **Consumes:** M46's forced-put rule and chunk hash, M47's `unknown` lists and `last_sent`, M48's lost-frame rule, M48b's `belts/join_at_scale`.

## Planning decisions
- **A snapshot re-puts only what the client lacks.** The forced put existed so the client's chunk state and its structures arrive together (0079 §17 (a)); a client that already holds the line at the same version has the same structure the snapshot would carry, so the chunk hash agrees without it. The lost-frame rule (§20 (c)) stays correct: a line the lost frame named is already sent `Gone` and re-put by `LineRoute::lost`; a line it did not name is unchanged on the client.
- **The feeder is the reference shape.** 0079 §19 (e): a spawner that writes a delta per insert collapses chunks under production pacing; the reference game's spawners (M53) keep their schedule in the tracker's declaration and write state only when a player changes them. The feeder is that shape in the fixture.
- **No bench baseline moves.** `slow_tick_belts_large` runs the `Mixed` regime; the dedupe runs only on snapshot frames (none in the bench's steady state after warm-up): three runs at quiet load must sit within noise of 1.2638 ms.

## Order of work
1. The replica's behaviour on a snapshot of a chunk with held lines (read, then decide the engine side); the dedupe in `host/lines.rs`; `host_snapshot_does_not_reput_held_lines`; the `forecast_`, `line_`, `host_`, `no_alloc` families.
2. `Thing::Feeder`, `MixedFeeders`, `belts_feeders_write_no_delta`; `pnpm golden belts` idempotent (no golden moves: the regime is new).
3. The join cells; Deviations; docs; three bench runs; `pnpm test`, `pnpm lint`, `pnpm test:slow netcode`.

## Tests added
Rust: `host_snapshot_does_not_reput_held_lines`, `belts_feeders_write_no_delta`. Netcode: the `MixedFeeders` cell of `belts/join_at_scale @slow`.

## Exit criteria
- [ ] `belts/join_at_scale` pins lists applied equal to lines held on both cells (no list twice); the `Mixed` cell's bytes fall by the duplicated lists' share.
- [ ] The `MixedFeeders` cell's ticks and bytes by section are in Deviations and 0078 A10; the distance to 10 s is stated.
- [ ] Every new test has an inject-fail-revert recorded; `pnpm test`, `pnpm lint`, `pnpm test:slow netcode` green; bench within noise.

## Verification commands
`pnpm test rust -t snapshot_does_not_reput` · `pnpm test rust -t feeders_write_no_delta` · `pnpm test rust -t forecast_` · `pnpm test rust -t no_alloc` · `pnpm test:slow netcode -t join_at_scale` · `pnpm test:slow rust -t slow_tick_belts_large` (three runs) · `pnpm test && pnpm lint`

## Budgets
- `belts-tick` 1.2638 ms baseline; the netcode suite 10 s; the 48 KB/s bucket and the 10 s join criterion (0078 Consequences, judged on the reference world in M57).

## Context artifacts
`docs/architecture/sync-and-netcode.md`, `packages/engine/fixtures/belts/CLAUDE.md`, `packages/engine/tests/netcode/CLAUDE.md`.

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
