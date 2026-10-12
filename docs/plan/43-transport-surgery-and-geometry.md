# M43: Transport surgery and geometry

Status: done (2026-10-11) · After: 42b · Tyler-dependent: no · Split 2026-10-11: the `fx-belts` ops and goldens moved to `43b-transport-surgery-goldens.md` (sizing rule)

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
- [x] Every surgery test passes with an inject-fail-revert recorded (a dropped gap, an off-by-one cut, an index not rebuilt).
- [x] `index_rebuild_equals_incremental` passes over a scripted sequence of 200 random edits (seeded).
- [x] `transport_surgery_no_alloc` reports 0.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t surgery_` · `pnpm test rust -t geometry_` · `pnpm test rust -t items_` · `pnpm test rust -t index_` · `pnpm test && pnpm lint`

## Budgets
- Allocation per tick: `transport_surgery_no_alloc`. Suite budgets as M42.

## Context artifacts
`crates/engine/CLAUDE.md` one phrase ("the tile index is derived, like `ChunkIndex`").

## Manual device checks
none

## Deviations
Steps 1-4 by the implementer (2026-10-11); step 5 (commit) is the manager's.

**Files** (`crates/engine/`, lines): new `src/transport/surgery.rs` 487, `items.rs` 216 (`insert_at`/`remove_at` moved out of `advance.rs`, plus `take_front`), `geometry.rs` 627 (with two unit tests); `mod.rs` 784, `line.rs` 263, `codec.rs` 328, `advance.rs` 316; `predict/predicting.rs` forwards the new reads; tests `tests/main/transport_surgery.rs` 521, `transport_geometry.rs` 448, `transport_rules.rs` (reference extended, two tests updated), `tests/no_alloc_transport.rs` 308. `store/mod.rs` unchanged: `Transport::decode` itself rebuilds the tile index, which covers `Store::decode` and `migrate`'s carry.

**`rescale`: squashed pairs are kept exactly (12 §3e), as negative gaps.** The brief's push-back option fails the measured case: a full outer curve lane (295, five items at 0..256) reshaped to 256 cannot hold five items `SPACING` apart (it needs 257), so the push would refuse a reshape the game cannot refuse. So `Run.gap` is an `i32`, negative for a squashed pair (never below `1 - SPACING`: positions strictly increase; `rescale` refuses `NoRoom` only when two items would share a position, a rescale below 1/64). Consequences: lines are capped at `MAX_LEN = i32::MAX` (`TooLong`, new error; decode rejects); `advance`'s later-run step is `d = clamp(gap + d_prev, 0, speed)` (the squash rule: an item inside its bound does not move); a per-line `squashed` flag disables the early exit (a negative gap behind a full-speed run still holds) and, behind such a run, skips every gap `>= 0` untouched, exactly what the early exit leaves, so a stale flag is unobservable and it is not encoded. `join` keeps a boundary pair closer than `SPACING` (legal across a hand-off, 0077 A6b (i)) the same way. Measured: 295 -> 256 puts 0/64/128/192 at 0/55/111/166 (the measurement's numbers) and on a speed-8 sink they start one by one as leaders pull 64 ahead (`surgery_rescale_floors_and_keeps_squashed`, tick by tick); the per-item reference (which has no runs) agrees through 400 ticks with 5 squashing rescales. **Amends 0079 §2:** decode now rejects `dist == 0`, not `dist < SPACING`; a `dist` in `[1, 64)` is a squashed pair (`transport_codec_round_trip_and_rejects_spacing_violation` updated: 63 decodes as gap -1 and re-encodes byte for byte). For the manager's ADR.

**Codec: segments behind a flag bit, so no golden moved.** The brief's `count u8` on every line would change every `fx-belts` golden (their lines have no segments). Instead bit 7 of the `out` tag announces `seg_count u8` + segments after the runs; a line without segments is byte-identical to M42's record. `fx-belts`' goldens, `store_golden_bytes.hex` and `persist_snapshot_golden_bytes.hex` are untouched and green (the proof that M43 changed nothing for a world without squashes or segments). Decode validates what `set_segments` does (count 1..=16, lengths sum to `len`, arc fields, path tiles).

**Geometry, as built.** Segment 0 starts at position 0 (the front). Arc: `a = start x 256 + floor(sweep x 256 x o / len)` in 1/65,536 turn; a positive sweep turns from `+x` toward `+y` (the brief's "negative for clockwise" depends on the y axis direction, so the doc states the formula instead). Arc checks: `radius >= 1`, `start < 256`, `0 < |sweep| <= 256`, `centre +- radius` inside `i32`. The table has 16 intervals, 17 points (`QUARTER_TABLE`, nearest-integer Q0.16); its check (`quarter_table_is_a_unit_quarter_circle`): ends exact, symmetric about the diagonal, monotone, `|c^2 + s^2 - 2^32| <= c + s` (the rounding bound) and the radius within 2 Q0.16 units (the brief's "within 2 units of 1 << 32" is unreachable at Q0.16: the rounding alone gives up to 51,120). A second unit test sweeps all 65,536 angles: radius within 82 units below 1 (chord sag 79 plus the floor), monotone per quadrant. The straight lerp is `i64` (`|to - from| < 2^32`, offsets `< 2^31`). Chunk sets come from each segment's exact tile box (positions `0..=len-1`; monotone pieces' endpoints), so a segment ending on a tile edge does not claim the next tile; arcs use their real extent, not the circle's box.

**API shape.** `chunks_of`, `segments`, `lines_at` take a callback, not a slice/iterator (`TransportRead` is used as `dyn`); `chunks_of` and `anchor` take `ChunkDims` (the store does not know `CHUNK_BITS`); `chunks_of` is computed on call from at most 16 boxes (sorted `(cy, cx)` by per-row interval merge), nothing stored. `destroy` returns `Result<u32, _>` (the count) and keeps the callback. `split(line, at)` refusals are all `BadSpeed` (`at <= speed`, `len - at <= speed`, a feeder faster than `len - at`); `join` adds `NotLinked` and `Unsupported` (front feeds back: a self-loop); the front's speed and output win. Every surgery changing a line's `len` clears its segments and index entries (a cut cannot split an arc exactly); the game re-registers. The jam cursor of a changed line is invalidated (a valid state, re-walked from the front). `set_segments(&[])` clears.

**Storage and caps.** Segments are pooled, not 16 per line: `max_lines x 4` records of 32 B, contiguous per line, compacted in place when the tail is reached (16 per line would be 12 MiB at the recommended caps). Tile index: `max_lines x 8` entries of 16 B plus `MAX_LINE_TILES` (4,096) entries of merge room; a line's new entries are written past the merge destination, sorted (`sort_unstable`, in place) and merged from the back. Past either cap, or a path entering more than 4,096 tiles, `set_segments` is `Full`, nothing written. `reserved_bytes` at the recommended caps: 16,220,176 B (was 7,503,888): line record 72 -> 80 B, +256 B per line for geometry, +64 KiB merge room. 0079 §5's "7 MiB" and `world-and-worldgen.md`'s "about 7 MiB" are now stale (manager: ADR/doc). Removing a line's entries is a `retain` over the whole index (O(index), surgery rate).

**Inject-fail-revert** (each reverted, file checked): dropped join-boundary gap -> `surgery_join_preserves_gaps` "left: [(1, 100), (1, 234), (2, 298)] right: [(1, 100), (1, 326), (2, 390)]"; off-by-one cut (`keep` one too many) -> `surgery_split_partitions_items_and_spacing` "cut at 364: front part"; back-part gap off by one -> same test "cut at 200: back part"; `destroy` not clearing the index -> `surgery_destroy_redirects_outputs` "the destroyed line's tile entries are gone" and `index_rebuild_equals_incremental` "edit 14: op 7"; table entry 0 off by one -> `geometry_arc_quarter_circle_endpoints` "start 0: left 1187 right 1188"; `shrink` not refusing -> `surgery_shrink_refuses_with_items` "left: Ok(()) right: Err(NotEmpty)"; `rescale` rounding instead of flooring -> `surgery_rescale_floors_and_keeps_squashed` "0, 56, 111, 167 vs 0, 55, 111, 166"; lerp in `i32` -> `geometry_precision_at_2_pow_18` "pos 16". A first off-by-one attempt (`f >= at` -> `f > at`) was equivalent code and passed; replaced by the two above.

**Tests.** `transport_matches_per_item_reference` runs surgery on its own `SimRng` stream (seed 43) so the M42 part draws what it drew: a split or join every 20 ticks, three extend/shrink every 30, three rescales every 50, never on the cycle; it asserts each kind ran at least 4 times (one run: 8 splits, 11 joins, 19 extends, 5 shrinks, 13 `NotEmpty`, 5 squashing rescales). `index_rebuild_equals_incremental` also compares against a brute-force index sampled from `pos_to_world` every tenth edit. `transport_surgery_no_alloc`: 6 surgery steps (cut+join, extend+shrink, rescale there and back, `set_segments`) inside the window, live and high-water deltas 0; the standing control still trips.

**Review fixes** (review `m43-review.md`, the manager's decisions):
1. `lines_at` on an unreserved store (a replica's, never reserved until M46) is `Err(Unknown)`: it names no line, so the slot lookup cannot refuse it (prediction rule). `transport_lines_at_is_unknown_on_a_replica` (`transport_access.rs`, new action `ReadTile`): the client prediction is `NotPredictable`, the host's reserved store answers `Ok` and applies it.
2. The tile walk stops as soon as its callback says so; `count_tiles` stops at `MAX_LINE_TILES + 1`, so a refused `set_segments` or a hostile decode costs O(`MAX_LINE_TILES`), not O(path). `walk_evals()` (a thread-local counter of point evaluations, not state) lets `geometry_refused_path_walks_at_most_the_cap` bound the cost of refusing a `MAX_LEN` straight path (8.4M tiles) at 34 evaluations per tile up to the cap.
3. Tests: (a) cuts at 128 and 428 (a run's last item) in `surgery_split_partitions_items_and_spacing`; (b) `surgery_split_keeps_squashed_pairs`: a line rescaled 1180 -> 1024 (19 items, every pair squashed) cut at 60, 100, 140, 300, 700 and 1000 advances like the unsplit line for 160 ticks on a speed-8 sink, and its encode/decode advances byte-identically; (c) `transport_segment_pool_compacts_no_alloc` (`no_alloc_transport.rs`): caps `(4, 0)` (a pool of 16 records: caps `(2, ..)` hold 8, too few for 16 segments), two 16-tile lines re-registered 300 times with k and 16 - k segments, `segments()` and `lines_at` checked every round inside the window (live and high-water 0), the index equal to a rebuild afterwards.
4. `redirect_feeders` touches every feeder it changes (`split`, `join`, `destroy`); `surgery_destroy_redirects_outputs` asserts both former feeders read `touched()` after the next `advance` and the non-feeder does not.
5. `TransportWrite::join`'s doc says a second `Next(front)` feeder now lands `back.len` further upstream; no refusal.
6. Upkeep cost, measured (`slow_geometry_upkeep_cost`, slow tier, not a gate; `cargo test --release -p engine --features testing --test main slow_geometry_upkeep_cost -- --nocapture`, Mac at load about 10): index at 262,136 entries (32,767 lines of 8 tiles), one line's `extend_back` (its `clear_geometry` `retain` over the index) plus `set_segments` (the merge, the line in the middle of the index): median 201.75 us of 20 (min 201.4, max 203.8). A belt tile is two lanes, so about 0.4 ms per placed tile on the Mac at full caps; whether M45/M52 bucket the index per chunk is the ADR's call.

Inject-fail-revert for the review fixes (each reverted): `lines_at` answering `Ok` unreserved -> `transport_lines_at_is_unknown_on_a_replica` "left: Applied right: NotPredictable"; `count_tiles` never stopping -> `geometry_refused_path_walks_at_most_the_cap` (the evaluation bound; 0.9 s instead of 0.3 s); `last >= at` -> `last > at` in `split` -> `surgery_split_partitions_items_and_spacing` "cut at 128: front part" (128 stays at `pos == len`); `split` leaving the back part's `squashed` false -> `surgery_split_keeps_squashed_pairs` "cut at 60, tick 2" (squashed items moved 8 behind a full-speed leader); no compaction -> `transport_segment_pool_compacts_no_alloc` "segment pool compaction allocated (261632, 261632)"; `redirect_feeders` not touching -> `surgery_destroy_redirects_outputs` "(Ok(false), Ok(false))".

**Manager's gate and review (2026-10-11).** Reran: `surgery_` 8, `geometry_` 5, `transport_` 40, `no_alloc` 15, `pnpm lint` green, full `pnpm test` green at load 3.9 (rust 3.4 s of 10 s); the `fx-belts` goldens and the byte goldens unchanged. Adversarial review (an Opus reviewer, read-only): no determinism or conservation defect; one prediction-rule violation (`lines_at` on a replica answered "no line" instead of `Unknown`), one unbounded walk (a refused `set_segments` or a hostile decode walked the whole path), five test gaps (a cut exactly on an item, a split through a squashed pair, segment-pool compaction, feeders not touched on redirect, the join doc) and the O(index) upkeep cost; all fixed or measured in the "Review fixes" block (the upkeep: 0.4 ms per two-lane tile at the recommended caps on the Mac, `slow_geometry_upkeep_cost`, not gated). The decisions moved are [0079](../decisions/0079-transport-core-decisions.md) §12 (squashed pairs as negative gaps, amending §2), §13 (segments behind a presence bit, pooled geometry, the two per-line limits, the callback API) and §14 (16.2 MiB at the recommended caps, amending §5; the index upkeep cost and the per-chunk bucketing trigger). Deferred to M52's topology rules: a chain longer than 4,096 tiles or with more than 16 segments is two lines.
