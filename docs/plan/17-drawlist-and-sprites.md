# M17: DrawList, `FrameView`, shapes

Status: not started · After: 16f · Tyler-dependent: no

Split during planning: the sprite atlas, the sprite kind, the 65,536-record frame benchmark, the `profile-frame` skill and the manual Safari/Firefox harness run are **M17b** (`17b-sprites-and-frame-budget.md`). M18 and M19 depend on this brief only; PLAN.md lists M17b under M20b's After.

## Goal
`ClientSide::extract` fills an engine-owned `DrawList` from a `FrameView` once per produced frame; the engine counting-sorts it by layer into the staging region, the client worker publishes it to the DrawList triple buffer, and the main thread shows the newest slot with one `writeBuffer` and one instanced draw per non-empty layer through the uber-quad pipeline (every kind except sprite). DrawList bytes are hashed exactly without a GPU; shapes are verified by readback probes. The final main-thread bytes-per-frame number goes into `budgets.json`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` (§2 all of it, §4 "Shapes need no art", §5 entity positions, §6 last paragraph)
3. `docs/decisions/0003-game-facing-api.md` (`ClientSide`, "Contexts": the read-only `View`; Consequences item 7)
4. `docs/decisions/0016-zero-gc-definition.md` (§1 the floor formula; Consequences: the final-number deferral)

Mine from spikes: `spikes/zero-gc-webgpu/public/main.js` (4,096-instance buffer from a shared view with the offset/size `writeBuffer` overload; instanced quad pipeline). Rules that apply: `.claude/rules/hot-paths.md`.

Also read `docs/plan/15b-ring-connection-and-replica-rendering.md`'s Deviations for the client worker loop's shape this milestone's `extract`/publish step runs inside: `worker/client-net.ts` (new file at M15b), the client worker's net pump, built only when linked and run from `body()` *before* `uploadPump.pump()` — `on_frame` (inside the net pump) enqueues a newly dirty chunk into `Uploader`'s own pending queues, and that ordering is what stages a chunk onto the upload ring the same wake it arrived rather than one wake later. The replica → renderer path and the per-frame upload path this milestone builds a first production caller for are real only because of that ordering.

**M15c is changing how cache eviction is reported.** `docs/plan/15c-terrain-visibility-and-cache-invalidation.md` makes `Cache::evict_if_present` start emitting a `CacheEvent` on an overlay-driven eviction (`TerrainStore::replace_overlay`/`clear_overlay`), where today it silently frees the slot. This milestone's DrawList/upload work sits downstream of `Uploader::on_frame`'s `changed` flag, which M15c's own generation-side fix uses as its precedent for the same shape — read M15c's Deviations (filled in once it lands) for the final seam before assuming today's `changed` semantics are the last word.

## Scope
- Rust `client/drawlist.rs`: `DrawList`, `Draw` (0018 §2 layout), builder methods for every kind, full-list drop + debug counter, stable counting sort by `layer` from a scratch list into `RegionId::DrawList` (sized here: 1,024-byte header + the capacity of 0018 §2), header fill. Fills M12's `DrawList` shell.
- Rust `client/frame_view.rs`: grows M16b's minimal `FrameView` to the shape below; window-origin choice.
- `frame(t_ms)` now runs: build `FrameView` → `G::Client::extract` → sort → return status; export `drawlist_len() -> u32`.
- Client worker body: copy `ceil(len / 64 KiB)` body blocks plus the header into the triple buffer's back slot; `publish()`.
- Main `render/drawables.ts` + `wgsl/uberquad.wgsl`: instance buffer (capacity per 0018 §2), `acquire()` newest slot, one `writeBuffer(instanceBuf, 0, slotView, 0, usedBytes)`, `draw(6, n, 0, first)` per non-empty layer in the same pass as terrain. The vertex buffer layout binds every `Draw` field except `pick_id` (0018 §2); it is a module constant, `UBERQUAD_VERTEX_LAYOUT`, so a test can read it. Kinds: circle, ring, rect, bar, radial, ghost; flags `ANCHOR_CURSOR_TILE`, `SCREEN_PX_STROKE`, `FLIP_X`; `PREDICTED` is carried but not styled (M26).
- Fixture game `fixtures/drawables/`.
- Final `main` bytes per frame in `budgets.json`.

## Non-scope
Sprites and the atlas (M17b). Picking (M18 reads the same slot). `FrameCx`, `ClientSide::frame`, follow target, anchor table writes (M18; the header bytes are reserved here). Presences in `FrameView` (M19, M30). Overlay change list and `predicted` styling (M26). Interpolation (M30): `FrameView` reads the replica as of the last applied frame.

## Files, packages and crates touched
`packages/engine/crates/engine` (`client/drawlist.rs`, `client/frame_view.rs`, `abi/registry.rs`), `packages/engine` (`src/render/drawables.ts`, `src/render/wgsl/uberquad.wgsl`, `src/worker/client.ts`, `src/test/*`, `src/abi.ts`, `tests/browser/`), `packages/engine/fixtures/drawables/` (`fx-drawables`).

## Seams
**Provides**
- Rust: `DrawList::{sprite, circle, ring, rect, bar, radial, ghost}` each returning `&mut Draw` (0018 §2); `Draw` constants `KIND_*`, `ANCHOR_CURSOR_TILE`, `SCREEN_PX_STROKE`, `PREDICTED`, `FLIP_X`; `WorldPos` (Q24.8 per axis) and `SpriteId(u16)`; `DrawList::dropped() -> u32`.
- **`FrameView<'a, G>`** (this brief owns the final shape; it extends the struct M16b created, which already has `world() -> &dyn WorldRead<G>` (delegating to `ClientCore::view()`), `clocks() -> Clocks { authoritative, predicted }` and `me()`; 0003 describes it as "`WorldRead` + clocks + presences"). Added here:
  - `entities() -> EntityIter<'_, G>`: `(EntityId, &G::Entity, TilePos origin)` for replica entities whose footprint intersects `visible()`, ascending `EntityId` (makes DrawList hashes stable)
  - M16b's `Clocks` gains `tick_fraction: f32` (progress into the current tick, for smooth progress drawables) and `ticks_per_second: u32`; `time_ms() -> f64`
  - `visible() -> TileRect` (visible rectangle plus a 2-tile margin), `zoom() -> f32` (tiles across the long axis), `px_per_tile() -> f32`, `cursor_tile() -> Option<TilePos>`, `window_origin() -> TilePos`
  - added later: `presences()` (M19 own, M30 remote), `is_predicted(EntityId)` (M26)
- `ClientSide::extract(&self, view: &FrameView<G>, out: &mut DrawList)` with an empty default body.
- DrawList slot header (1,024 bytes; offsets below) and `drawList` triple buffer traffic; ABI `drawlist_len() -> u32` (M02's rule); `RegionId::DrawList`.
- `engine/test`: `drawListHash(client): string` (hash of header fields + used body bytes of the newest slot), `drawListRecords(client, out)`, counters `drawCalls`, `instanceBytes`, `pipelineSwitches`, `drawListDropped`.

**Consumes** M06: `createTriple`, `bodyBlockView`, `SabSet.drawList`. M06b: worker body, `stepFrame`, `untilQuiescent`. M09: frame loop `render` phase, `renderer.frameUniform`, `renderTo`/`readPixels`/`expectPixel` (M09's Deviations, Steps 5-7: both are overloaded — a renderer-only shape and `renderTo(client, opts)`/`readPixels(client)` against a real `Client`'s `uploadRing`; a real-drawables scene should use the `client` overload), the `engine/test` pass-through counters `drawCalls`/`uploadBytes`/`uploadRecords`/`pageSlotsUsed` (already exported over `TerrainRenderer`/`UploadDrain`; this milestone's own `drawCalls`/`instanceBytes`/`pipelineSwitches`/`drawListDropped` counters extend the same renderer, not a separate one — terrain and drawables share one render pass per this brief's own Planning decisions). M11: `camera.cursorTile`, camera block with `cursor_tile`. M12: `ClientSide`, `DrawList`/`FrameView` shells. M15/M15b: `ClientCore::view()` and the replica's per-chunk entity index (add an iterator there if it has none). M16b: minimal `FrameView`. M04: `installGcPage`, `zeroGcSuite`, `budgets.json`.

## Planning decisions
- **Slot header is 1,024 bytes, not 256** (0024 §11): 0018 §2 gives a 256-byte header, but 0019 §5 puts a 64-slot anchor table in it, which alone is 512 bytes. Layout: `0 frame_seq u32`, `4 record_count u32`, `8 window_origin i32×2`, `16 layer_count u32×8`, `48 follow_valid u32`, `52 flags u32`, `56 follow f64×2`, `72 camera_seq u32` (the camera-block `seq` this frame read), `76 anchor_mask u32×2`, `88 dropped u32`, `96 frame_time_ms f64`, `128..640 anchors f32×2×64` (tiles relative to `window_origin`), rest reserved. M18 writes `follow_*` and the anchor fields.
- **Proportional publish.** Staging and each slot body are addressed as 32 blocks of 64 KiB with view pairs made at init (M06 `bodyBlockView`); a frame copies only the blocks it used. A typical frame of a few hundred records copies one block instead of 2 MiB, and the rule of 0014 §4 (whole blocks, no `subarray`) holds.
- **Two lists, one sort.** `extract` appends to a scratch list in the client arena; the counting sort writes the staging region in one pass (count per layer, prefix sums, scatter). Stable, O(n), no comparisons, and `layer_count` falls out of the first pass.
- **Window origin** = the camera centre's tile, snapped to a multiple of 64 tiles, so it changes rarely and DrawList hashes do not change with sub-chunk camera motion. `pos` stays far inside f32's exact range (0018 §5).
- **`ANCHOR_CURSOR_TILE` is resolved in the vertex shader** from the frame uniform's `cursor_tile`, which main writes from the live camera each rAF; the DrawList's `pos` is then an offset from the cursor tile. That is what gives the ghost zero added latency (0019 §4).
- **Final main-thread bytes per frame.** Terrain and drawables share one render pass, so the production wrapper count stays five and the stepped-test shape four (0016 §1 formula, spike table). This milestone measures the clean value over 20 runs of page `drawables` (`pnpm gc reliability`, M04), sets `gc.pages.drawables.isolates.main.bytesPerFrame` in `budgets.json` by the formula (16 × wrappers + 24 + measured harness overhead + 8 margin) with its `formula` text, aligns the other WebGPU pages (`terrain`, `input`) to the same derivation, and records the measurement in Deviations. Sprites (M17b) add a bind group, not a wrapper, so the number is final here; the overlay string constant is M18's.
- **`extract` takes `&self`** (0003); anything it needs from input or the spring is state the game wrote in `ClientSide::frame` (M18).

## Order of work
1. `Draw`, builders, scratch list, counting sort, header; native hash tests. 2. `FrameView` + `EntityIter` over the replica; fixture game. 3. `frame` wiring, `drawlist_len`, worker publish. 4. Main: acquire, `writeBuffer`, per-layer draws, uber-quad kinds one at a time with a probe each. 5. Cursor-anchored ghost. 6. Counters, GC scenario, final number.

## Tests added
- Rust native: `draw.layout_is_32_bytes_le` (golden bytes), `drawlist.counting_sort_stable`, `drawlist.layer_counts_and_prefix`, `drawlist.full_drops_and_counts`, `drawlist.pos_relative_to_window_origin_exact_at_2pow23`, `frameview.entities_sorted_and_clipped`, `frameview.zoom_matches_camera_block` (0018 §6: `zoom()` equals the camera block's `tiles_across`; `fx-drawables`' `extract` skips its smallest drawable above a zoom threshold, and the record count and DrawList hash change across it and nowhere else), `drawlist.fixture_hash_golden` (pure function of replica + camera, 0020 §6 layer a), `wgsl.uberquad_validates`.
- Browser readback (Chromium): `draw.circle_and_ring_probe` (centre colour, outside transparent, ring hole), `draw.rect_bar_radial_probe` (bar and radial at `param` 0, 0.5, 1), `draw.layers_order` (higher layer wins the pixel; reverse submission order within a layer), `draw.screen_px_stroke_constant_under_zoom`, `draw.ghost_follows_cursor_same_frame` (cursor tile changed on main after publish: ghost pixel moves without a new DrawList), `draw.one_frame_old_list_has_no_error` (camera moved after publish: shape stays on its tile).
- `unit` suite: `uberquad.vertex_layout_has_no_pick_id` (`UBERQUAD_VERTEX_LAYOUT` has one 32-byte instance-step buffer whose attributes cover every byte of 0018 §2's record except the four of `pick_id`, and `uberquad.wgsl` declares no input at that offset).
- Browser: `drawlist.triple_newest_wins` (worker publishes faster than main consumes), `counters.draws_equal_nonempty_layers`.
- Zero-GC: page id `drawables` through `zeroGcSuite` (fixture with a few hundred entities, panning, actions from pre-encoded bytes; isolates `main`, `client`, `sim`, `gen0`).

## Exit criteria
- [ ] All tests above pass by name.
- [ ] `budgets.json`: final `main` number on `gc.pages.drawables` by the formula, `counters["render.drawCallsMax"]` (terrain + 8 layers), `counters["render.pipelineSwitches"]`; the page passes on every isolate with no `memory.grow`.
- [ ] `drawListDropped == 0` in every test except the overflow test.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t draw` · `pnpm test rust -t frameview` · `pnpm test rust -t wgsl` · `pnpm test browser -t draw` · `pnpm test browser -t drawables` · `pnpm gc reliability` · `pnpm test` · `pnpm lint`.

## Budgets
- Allocation per isolate (0016 §1): final main number set here; client worker at its budget with publish included.
- GPU upload and constant draws (0018 §2–§3): `counters.draws_equal_nonempty_layers`, `instanceBytes`.
- Memory, client arena (0015 §5): scratch list + staging inside the arena; `W_MEM_GROWS == 0`.
- Frame time: asserted in M17b.

## Context artifacts
`packages/engine/crates/engine/CLAUDE.md`: "`extract` is pure over `FrameView`; iterate `entities()`, never allocate; positions are `WorldPos`, the engine subtracts the window origin". `packages/engine/CLAUDE.md`: how to regenerate the DrawList golden hash.

## Manual device checks
None (M17b carries the manual Safari/Firefox run).

## Deviations
(filled in during Phase 3)
