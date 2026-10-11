# M43: Transport surgery and geometry

Status: not started · After: 42b · Tyler-dependent: no · Split 2026-10-11: the `fx-belts` ops and goldens moved to `43b-transport-surgery-goldens.md` (sizing rule)

## Goal
(Revised 2026-10-11: `insert_at`/`remove_at` landed in M42 ([0079](../decisions/0079-transport-core-decisions.md) §7); this milestone keeps `front` and the surgery, and its edit-while-running goldens exercise the two primitives through `fx-belts` requests.)

Lines can be edited while items are on them, and the engine knows where a line is: `split`, `join`, `extend_front`/`extend_back`, `shrink_front`/`shrink_back`, `rescale` and `destroy` keep items and spacing; `insert_at`, `remove_at` and `front` are the inserter-shaped primitives; the game registers each line's segments and the engine derives its chunk set, anchor chunk and a tile index. The engine-side tests pin every operation on small lines and the no-alloc binary covers surgery; the `fx-belts` ops and the three goldens that pin edits during flow across runtimes are M43b.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§3 surgery and primitives, §4 geometry)
3. `docs/architecture/world-and-worldgen.md` ("Model": `TilePos`, `ChunkCoord`, `WorldPos` Q24.8, `ChunkIndex` is derived)
4. `/Users/tyler/repos/belts/docs/12-belt-physics-measurements.md` (§3d curve geometry, §3e reshape rescale)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`. Skills: `run-tests`.

## Scope
- `transport/surgery.rs`: `split(line, at) -> LineId` (the new line is the back part; items partitioned by position; the cut lands between runs, splitting a run if needed), `join(front, back)` (back's items appended with their gaps preserved; `back` is destroyed; its `Output` must have been `Next(front)`), `extend_back(line, by)`, `extend_front(line, by)` (every position grows by `by`: O(1) with gaps), `shrink_front`/`shrink_back` (refused with `NotEmpty` if an item would fall off), `rescale(line, new_len)` (positions scaled by `new / old`, floor; a pair squashed under `SPACING` is left and resolves by the squash rule), `destroy(line) -> items` (returns the count removed; `Output`s pointing at it become `DeadEnd`).
- `transport/items.rs`: `insert_at(line, pos, item) -> Result<(), NoRoom | Full>` (`SPACING` clear on both sides), `remove_at(line, pos) -> Option<Item>` (the nearest item within `SPACING / 2`), `front(line) -> Option<(Item, pos)>`, `take_front(line) -> Option<Item>` (removes it; a sink the game drives itself).
- `transport/geometry.rs`: `Segment { len, geometry: Straight { from, to } | Arc { centre, radius_q8, start_turn_q8, sweep_q8 } }`, `set_segments(line, &[Segment])` (sum of `len` must equal `line.len`), `pos_to_world(line, pos) -> WorldPos` by prefix sums (binary search over the line's segments), `chunks_of(line) -> &[ChunkCoord]` (derived: the chunks the segments' bounding tiles cover, sorted `(cy, cx)`), `anchor(line) -> ChunkCoord` (the chunk of the front point), and the tile index `lines_at(tile) -> impl Iterator<Item = (LineId, offset)>` rebuilt on `set_segments`/surgery (derived, never encoded; `rebuild_index` reaches what incremental maintenance reaches, the `ChunkIndex` rule).
- Encoding: segments are part of a line's encoded structure (they are state the host set); the index and chunk sets are not.

## Non-scope
- The `fx-belts` ops (`Cut`, `Join`, `Extend`, `Rescale`, `Insert`, `Remove`, `Segments`) and the goldens `edit-while-running`, `inserter-like`, `geometry-arc` (M43b, split 2026-10-11).
- `Merge`/`Fork` (M44); who calls surgery when (the reference game's topology rules, M52); replication of segments (M46); drawing (M49).

## Files, packages and crates touched
- `packages/engine/crates/engine/src/transport/` (three new files, `codec.rs` grows), `world/` only if a `ChunkRect`-from-tiles helper is missing; `crates/engine/tests/`.

## Seams
**Provides:** `TransportWrite::{split, join, extend_front, extend_back, shrink_front, shrink_back, rescale, destroy, insert_at, remove_at, take_front, set_segments}`, `TransportRead::{front, segments, pos_to_world, chunks_of, anchor, lines_at}`, `Segment`, `Geometry`, `NotEmpty` (M43b's ops and goldens consume them).
**Consumes:** M42's `Transport`, `Op` requests, goldens; `WorldPos`, `TilePos`, `ChunkCoord` (0007).

## Planning decisions
- **Positions from the front, gaps toward the back** make `extend_front` O(1) and `extend_back` O(1): the game's common edit (placing the next belt tile at the end of a chain) costs nothing per item.
- **`rescale` keeps squashed pairs.** Factorio's measured rule (12 §3e); resolving them immediately would move items an edit should not move.
- **Arc geometry in Q24.8 turns** (`start_turn_q8`, `sweep_q8`: 256 = one full turn) with a 16-entry quarter-circle table and linear interpolation on the client: no transcendentals in sim-grade code (`determinism.md`); `pos_to_world` is client-side float arithmetic in M49, but the segment data is sim state, so it is integer here.
- **The tile index is a sorted `Vec<(TilePos, LineId, u32)>`** sized by `max_lines x 8`, binary-searched; a tile on a merged line appears once per lane.
- **`insert_at` lands exactly at `pos`** (no push-back): the inserter design of a later effort can add a search for the nearest free slot on top; the primitive stays simple.

## Order of work
1. Surgery with unit tests on small lines (every operation, with items at every boundary case).
2. Item primitives; tests.
3. Geometry, chunk sets, anchor, the index; tests including a line crossing a chunk border and one at `+-2^18` tiles (precision).
4. `no_alloc_transport` extended with a per-tick `insert_at`/`remove_at` pair and a cut/join per 100 ticks (surgery may allocate only from the arena; the test proves it).
5. Deviations, commit.

## Tests added
Rust suite: `surgery_split_partitions_items_and_spacing`, `surgery_join_preserves_gaps`, `surgery_extend_front_is_o1_positions`, `surgery_shrink_refuses_with_items`, `surgery_rescale_floors_and_keeps_squashed`, `surgery_destroy_redirects_outputs`, `items_insert_at_room_rule`, `items_remove_at_nearest`, `geometry_prefix_lookup`, `geometry_arc_quarter_circle_endpoints`, `geometry_chunks_and_anchor_across_border`, `index_rebuild_equals_incremental`; `no_alloc_transport` gains `transport_surgery_no_alloc`.

## Exit criteria
- [ ] Every surgery test passes with an inject-fail-revert recorded (a dropped gap, an off-by-one cut, an index not rebuilt).
- [ ] `index_rebuild_equals_incremental` passes over a scripted sequence of 200 random edits (seeded).
- [ ] `transport_surgery_no_alloc` reports 0.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t surgery_` · `pnpm test rust -t geometry_` · `pnpm test rust -t items_` · `pnpm test rust -t index_` · `pnpm test && pnpm lint`

## Budgets
- Allocation per tick: `transport_surgery_no_alloc`. Suite budgets as M42.

## Context artifacts
`crates/engine/CLAUDE.md` one phrase ("the tile index is derived, like `ChunkIndex`").

## Manual device checks
none

## Deviations
(filled in during execution)
