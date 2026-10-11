# M46: Line structure replication

Status: not started · After: 45 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in to the full template at the start of its phase (after M45), from M45's Deviations and 0078's Amendment.

## Goal
A client's replica holds the structures of every line whose chunk set meets its subscription: `len`, `speed`, `Output`, segments and anchor arrive as whole-value puts in a new frame section `LineStructs` (12) and inside chunk snapshots (by anchor chunk), leave with `Gone` on chunk leave, and are covered by the per-chunk desync hash (structures only). Nothing about items crosses yet. The netcode harness converges with belts under hash-all.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (§1, §4, §6)
3. `docs/architecture/sync-and-netcode.md` ("Wire format and deltas", "Integrity and desync") and `packages/engine/crates/engine/src/wire/CLAUDE.md`
4. `packages/engine/tests/netcode/CLAUDE.md`
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope (sketch)
- `wire/lines.rs`: section 12 writer and reader (allocation-free; `wire/CLAUDE.md` gains the layout: `Put`: `id varint`, structure bytes; `Gone`: `id varint`); chunk snapshot entries gain the structures anchored in the chunk.
- Host: a per-line `structure_version` (the tick of the last structure change); `build_frame` emits puts for lines whose chunk set meets a newly subscribed chunk (with the snapshot) or whose version is newer than the connection's `last_sent` (a sorted `Vec` per connection, reserved for `max_lines`); `Gone` when the last subscribed chunk of a line's set leaves.
- Replica: `Transport::apply_structure(put | gone)`; `TransportRead` on the replica answers for held lines, `Unknown` otherwise; the derived index rebuilds on apply.
- `integrity.rs`: `chunk_hash` covers structures anchored in the chunk in ascending `LineId`; items never.
- `fx-belts` scenario in the netcode harness: two clients, lines created, cut, joined and destroyed by requests while subscribed and while not; `assertConverged` on structures; `ResyncChunk` after a deliberate corruption of one structure.

## Seams
**Provides:** `SectionId::LineStructs`, `wire::lines`, `Transport::apply_structure`, `Host` line versions and per-connection `last_sent`, replica-side `TransportRead`, netcode helpers `lineStructures(client)` in `engine/test`.
**Consumes:** M43 segments, chunk sets and anchors; M45's world at scale for a join measurement (recorded, not gated: M48 owns it).

## Exit criteria
- [ ] Netcode: `belts/structures_converge` (hash-all), `belts/structure_gone_on_leave`, `belts/structure_resync_after_corruption` pass with inject-fail-reverts.
- [ ] `chunk_hash_excludes_items`: two replicas with equal structures and different items hash equal; `chunk_hash_includes_structures`: a changed `speed` hashes differently.
- [ ] `no_alloc_wire` covers the section writer and reader; `no_alloc_connection` still passes with lines in the world.
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- M45: how many structures a dense world holds (lines per 50,000 tiles) and their encoded size, which sizes the per-connection `last_sent` and the join measurement of M48.
- 0078 Amendment (M41): whether position-window culling is needed; if yes, structures still replicate whole and only forecasts are culled (M47).

## Deviations
(filled in during execution)
