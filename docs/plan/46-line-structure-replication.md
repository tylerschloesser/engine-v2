# M46: Line structure replication

Status: not started · After: 45 · Tyler-dependent: no

Filled in to the full template on 2026-10-12 (the start of the replication phase) from [0078](../decisions/0078-transport-forecast-replication.md) A1-A7, [0079](../decisions/0079-transport-core-decisions.md) §4-§5, §13 and M45's Deviations (3,810 lines at the stated scale; frame building for eight connections is 78 % of the 0.79 ms tick).

## Goal
A client's replica holds the structure of every line whose chunk set meets its subscription: `len`, `speed`, `Output` and segments arrive as whole-value puts in a new frame section `LineStructs` (12) and inside chunk snapshots (by anchor chunk), leave with `Gone` on chunk leave or destroy, and are covered by the per-chunk desync hash (structures only). Nothing about items crosses yet. The netcode harness converges with belts under hash-all, and a deliberate corruption resyncs.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (§1, §4, §6; A3 rule 6 and A6 (0): arrivals are M47's, but the structure a client holds is what makes an item's line known)
3. `docs/architecture/sync-and-netcode.md` ("Wire format and deltas", "Rates, subscriptions, bandwidth", "Integrity and desync") and `packages/engine/crates/engine/src/wire/CLAUDE.md`
4. `packages/engine/tests/netcode/CLAUDE.md`
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`, `.claude/rules/prediction.md`. Skills: `run-tests` (the netcode suite, `assertConverged`, desync dumps).

## Scope
- `wire/lines.rs`: section 12 writer and reader, allocation-free. Records: `Put { id varint, len u32, speed u16, out (the codec's tag and fields of 0079 §15), seg_count u8, segments (0079 §13's encoding) }` and `Gone { id varint }`, ascending by id within a frame; the layout is added to `wire/CLAUDE.md` (the single home of section ids and byte layouts). Chunk snapshot entries (`ChunkSnapshots`, 5) gain the structures *anchored* in the chunk after the entity puts (anchor = the chunk of segment 0's front point, `TransportRead::anchor`).
- Host: a per-line `structure_version` (the tick of the last structure change: `create`, `set_out`, `set_speed`, every surgery, `set_segments`, kept by `Transport` as a derived, non-encoded field like `touched`, plus a per-tick list of lines whose structure changed, drained at `seal`); per connection a sorted `Vec<(LineId, u32 /* version sent */)>` `last_sent`, reserved at attach for the world's `max_lines`; `build_frame` emits `Put` for every line whose chunk set (`TransportRead::chunks_of`) meets a chunk the connection subscribed this tick (with the snapshot) or whose version is newer than `last_sent` (from the changed list, never a scan over every line: O(changed) per connection per tick), and `Gone` when the last subscribed chunk of a held line's set leaves or the line is destroyed. A line without segments has no chunk set and is not replicated until the game registers them (the game does so when it maps a belt, M52).
- Replica: `Transport::apply_structure(Put | Gone)` on the replica's store (reserved at `Welcome` for the world's `max_lines`, and `max_items` for M47's run lists: the client pays what the game's world declares, 0079 §5; the reference game's phone caps are M51/M57's), creating or updating the line record with no items and rebuilding the derived index for it; `TransportRead` on the replica answers `len`/`speed`/`out`/`segments`/`chunks_of`/`anchor`/`lines_at` for held lines and `Unknown` otherwise (0079 §4's rule for `lines_at` stays: an unreserved store is `Unknown`); `count`/`front`/`items_in` on the replica are `Unknown` until M47. A `Put` the replica cannot hold (`Full`) is counted (`transport.structsDropped`) and reported through the desync path of the line's anchor chunk once (no loop: the host resends only on `ResyncChunk`); M48 measures whether the cap is ever reached at scale.
- `integrity.rs`: `chunk_hash` covers, after the entities, the structures anchored in the chunk in ascending `LineId` (their `Put` bytes); items never (0078 §6). `Host` and `Replica` call the one function.
- `fx-belts` netcode scenario (the harness's `fx-belts` world with requests): two clients, lines created, cut, joined, extended, re-segmented and destroyed by requests while one client is subscribed and the other is not, then the other arrives; `assertConverged` on structures under hash-all; `Gone` on leave; `ResyncChunk` after a deliberate corruption of one held structure (`engine/test` gains `corruptLineStructure(client, id)` and `lineStructures(client)`).
- `no_alloc_wire` extends to the section writer and reader; `no_alloc_connection` still passes with lines in the world (the `last_sent` vector reserved at attach).

## Non-scope
- Items, forecasts, arrivals (M47); position-window culling (not needed by 0078 A6 (ii)); the late-join cost (M48 measures it; this milestone records the structure's encoded size per line); the reference game (M51 onward).

## Files, packages and crates touched
- `packages/engine/crates/engine/` (`wire/lines.rs` new, `wire/mod.rs`, `wire/CLAUDE.md`, `host/mod.rs` and `host/subs.rs` (what a subscription change reports), `client/replica.rs`, `transport/mod.rs` (`structure_version`, the changed list, `apply_structure`), `integrity.rs`, `tests/no_alloc_wire.rs`, `tests/no_alloc_connection.rs`, `tests/main/`).
- `packages/engine/src/test/` (the `engine/test` helpers), `packages/engine/tests/netcode/` (one scenario file).
- `packages/engine/fixtures/belts/` only if the scenario needs an op it lacks (none expected: `Chain`, `Cut`, `Join`, `Extend`, `Segments`, `Destroy` exist).

## Seams
**Provides:** `SectionId::LineStructs` (12), `wire::lines::{Put, Gone, write, read}`, `Transport::{structure_version, drain_structure_changes, apply_structure}`, `Host` per-connection `last_sent` (M47 reuses it for forecast versions), replica-side `TransportRead` for held lines, `integrity::chunk_hash` over structures, `engine/test` `lineStructures(client)` and `corruptLineStructure(client, id)`, the netcode scenario `belts/structures_converge` (M47, M48 extend it).
**Consumes:** M43's segments, chunk sets and anchors (0079 §13); M44's `Output` codec (0079 §15); M45's world (`BeltsParams.bench`) for the join measurement M48 owns; the harness (`createNetHarness`, `assertConverged`, the desync dumps).

## Planning decisions
- **The replica reserves the world's caps** (from `Welcome`'s params), structures now and run lists in M47: one rule, no second cap to tune; the reference game's phone caps (M45: 16,384 lines and 131,072 items fit the 8 MiB line as an upper bound) are M51's and measured in M57. A `Full` on the replica is a counted, reported event, never a trap.
- **Puts ride the tick frame on change and the snapshot on subscribe.** A structure changes at placement rate (tens of bytes, a few times a second at most), so it needs no pacing; the chunk bucket paces the snapshot it rides at subscribe. A frame that cannot fit every put keeps the rest in the changed state for the next frame (0078 §7's rule for forecasts, applied the same way).
- **Versions, not acks** (0064 §18): a line's version is the tick of its last structure change; `last_sent` holds what the connection has; a stale `last_sent` can only over-send.
- **Anchored in one chunk, routed by the chunk set.** The snapshot carries a line once (by anchor) and `Gone` fires when the whole set has left, so a line spanning two subscribed chunks is never held twice or dropped early; the derived chunk set is computed on call (0079 §13) and cached per connection decision, never encoded.
- **No line without segments crosses.** The anchor and chunk set come from the segments; a line the game has not placed geometrically is invisible to clients, which is what M52's topology rules want (a belt maps to lines and registers segments in the same tick).

## Order of work
1. `wire/lines.rs` with its unit tests (round trip, malformed rejection) and `wire/CLAUDE.md`; `no_alloc_wire` covers it.
2. `Transport::structure_version` and the changed list; `apply_structure` on the replica; unit tests on a `Transport` pair.
3. Host routing in `build_frame` (`last_sent`, subscribe, leave, destroy) and the snapshot entries; `integrity::chunk_hash` over structures; `chunk_hash_excludes_items`, `chunk_hash_includes_structures`.
4. The netcode scenario and the `engine/test` helpers; `no_alloc_connection` with lines.
5. Deviations (with the encoded size per line of M45's world and the frame bytes a subscribe costs, M48's inputs); `docs/architecture/sync-and-netcode.md` "Scopes" gains one sentence; commit.

## Tests added
Rust suite: `wire_lines_round_trip`, `wire_lines_rejects_malformed`, `transport_structure_version_and_changes`, `replica_apply_structure_put_and_gone`, `replica_transport_reads_are_unknown_for_unheld`, `chunk_hash_excludes_items`, `chunk_hash_includes_structures`, `host_routes_structures_by_chunk_set` (a line spanning two chunks is sent once and `Gone` only when both leave); `no_alloc_wire` and `no_alloc_connection` extended. Netcode suite: `belts/structures_converge` (hash-all), `belts/structure_gone_on_leave`, `belts/structure_resync_after_corruption`, `belts/late_subscriber_gets_snapshot_structures`.

## Exit criteria
- [ ] The netcode scenarios pass with an inject-fail-revert recorded each (a dropped `Gone` reddens the leave test; a structure left out of the chunk hash reddens the corruption test by never resyncing; a version not bumped by `set_speed` reddens convergence).
- [ ] `chunk_hash_excludes_items` (two replicas with equal structures and different items hash equal) and `chunk_hash_includes_structures` (a changed `speed` hashes differently) pass.
- [ ] `no_alloc_wire` covers the section writer and reader; `no_alloc_connection` passes with lines in the world; the fast suites stay inside their budgets (`rust` 10 s, `netcode` 10 s).
- [ ] Deviations record the encoded bytes per structure on M45's world and the bytes a 144-chunk subscribe costs (M48's inputs).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t wire_lines` · `pnpm test rust -t chunk_hash` · `pnpm test rust -t replica_apply_structure` · `pnpm test netcode -t belts` · `pnpm test && pnpm lint`

## Budgets
- Allocation per tick and per frame: `no_alloc_wire`, `no_alloc_connection`. Fast-tier suite budgets (`rust` 10 s, `netcode` 10 s).

## Context artifacts
`wire/CLAUDE.md` (section 12's layout); `docs/architecture/sync-and-netcode.md` ("Scopes": line structures as a fourth replicated thing, one sentence); `packages/engine/tests/netcode/CLAUDE.md` (the belts scenario and helpers).

## Manual device checks
none

## Deviations
(filled in during execution)
