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

**This section covers steps 1-3 only** (commits `M17 step 1: ...`, `M17 step 2: ...`, `M17 step 3:
...`, base `6a84f10`). Steps 4-6 (main acquire/draw, kinds, ghost, counters, zero-GC page, final
number) are a second implementer's, built against the exact seam shapes below.

### Header, as landed (`client/drawlist.rs`)

The 1,024-byte layout is exactly the brief's own Planning decisions table. This cut writes six
fields: `frame_seq` (0, `u32`, wraps every `begin_frame`), `record_count` (4, `u32`), `window_origin`
(8, `i32`x2), `layer_count` (16, `u32`x8), `dropped` (88, `u32`), `frame_time_ms` (96, `f64`). Every
other field (`follow_valid` 48, `flags` 52, `follow` 56, `camera_seq` 72, `anchor_mask` 76, `anchors`
128..640) is left at its zero-initialised default -- reserved for M18 (follow/anchors) and M19
(presences); nothing in this cut ever writes them, including `flags` at 52, whose owner the brief
does not name (Non-scope reads as M18's, by elimination with `camera_seq`/`anchor_mask`).

### `usedBytes`/block count: `drawlist_len()` and where the arithmetic lives

`Instance::drawlist_len(&mut self) -> u32` (new, `ABI_VERSION` 14 -> 15) returns `DrawList::
record_count()` -- **records, not bytes**. `worker/client-drawlist.ts`'s `createDrawlistPump`
computes `usedBytes = recordCount * 32` (`Draw::BYTES`, duplicated as a local `DRAW_BYTES` const
with a comment, the same "an owning milestone may revise its row" allowance `client-upload.ts`'s
`RECORD_BYTES` already uses) and `blocks = Math.ceil(usedBytes / BLOCK_BYTES)`. The header (1,024 B)
is always copied whole, in one `copyBytes` call; each body block is copied only up to `min(BLOCK_
BYTES, usedBytes - blockStart)`, so a frame with e.g. 300 records (9,600 B) copies one 64 KiB block,
not 2 MiB, matching Planning decisions "Proportional publish" exactly. `sab/layout.ts`'s
`DRAWLIST_HEADER_BYTES`/`DRAWLIST_BODY_BYTES` and `sab/triple.ts`'s `BLOCK_BYTES` are now exported
(were private consts) so the pump and `test/client.ts`'s two new helpers don't each carry a third
copy of the same two numbers.

### `ABI_VERSION` 14 -> 15

`drawlist_len() -> u32`: client role, zero params, `Status`-free ("always answer, cost nothing" --
`0` on a wrong role or before the first `frame()` call, same shape as `sim_warm_one`/`upload_stage`).
No region crosses. `src/abi.ts`'s `ABI_EXPORTS.drawlist_len = { role: 'client', params: 0, result:
'u32' }`.

### `drawListHash`/`drawListRecords`: exact definitions (`engine/test`, `test/client.ts`)

Revised at the cut-1 gate ("native-vs-`.wasm` equality, not self-consistency"): the first draft
hashed the whole 1,024-byte header, `frame_seq`/`frame_time_ms` included -- which cannot ever agree
between a native one-shot `extract`+`sort_into` and a `.wasm` instance driven through several real
ticks first (a session-local call counter and a wall-clock field, neither a function of replica or
camera). **`hashDrawListFields(header, body, recordCount): string`** (exported, so both `drawListHash`
and a wasm/browser test needing the same field selection over bytes it already has can call it) now
hashes `record_count`+`window_origin`+`layer_count` (header bytes `[4, 48)`, contiguous) then
`dropped` (`[88, 92)`), then `recordCount * 32` body bytes: two independent 32-bit FNV-1a passes (no
`BigInt`, `.claude/rules/hot-paths.md`'s own reasoning for avoiding it even in test-only code),
combined into 16 lowercase hex digits (`sim_hash`/`worldHash`'s own format). **This is now the exact
twin of `crates/engine/src/client/drawlist.rs`'s own new `hash_region(region, record_count) -> u64`**
(same two seeds, same field order, same byte ranges; a `u32` XOR-then-`wrapping_mul` is bit-identical
to JS's `^=` then `Math.imul`) -- see "Prove the publish end to end", below, for the shared golden
this makes possible. `drawListHash(client): string` reads the newest `drawList` slot directly off the
SAB (`TripleReader`, no worker round trip -- `netCounters`'s own ring-read precedent) and calls
`hashDrawListFields`. `drawListRecords(client, out: DrawRecord[]): number` clears `out` and decodes
every record's nine fields (`pos`, `size`, `kind`, `spriteId`, `layer`, `flags`, `color`, `param`,
`pickId`), returning the count -- one object allocated per record, fine under the `src/test/**`
exemption.

### `FrameView<'a, G>`: exact grown shape (`client/frame_view.rs`)

```rust
pub struct Clocks { pub authoritative: Tick, pub predicted: Tick, pub tick_fraction: f32, pub ticks_per_second: u32 }  // Eq dropped (f32)

pub struct EntityIter<'a, G: Game> { /* private */ }
impl<'a, G: Game> Iterator for EntityIter<'a, G> { type Item = (EntityId, &'a G::Entity, TilePos); }

impl<'a, G: Game> FrameView<'a, G> {
    pub fn new(
        world: &'a dyn WorldRead<G>, clocks: Clocks, me: PlayerId,
        entities: &'a BTreeMap<EntityId, G::Entity>, registry: &'a Registry,
        visible: TileRect, zoom: f32, px_per_tile: f32,
        cursor_tile: Option<TilePos>, window_origin: TilePos, time_ms: f64,
    ) -> Self;
    pub fn world(&self) -> &dyn WorldRead<G>;
    pub fn clocks(&self) -> Clocks;
    pub fn me(&self) -> PlayerId;
    pub fn entities(&self) -> EntityIter<'a, G>;
    pub fn visible(&self) -> TileRect;
    pub fn zoom(&self) -> f32;
    pub fn px_per_tile(&self) -> f32;
    pub fn cursor_tile(&self) -> Option<TilePos>;
    pub fn window_origin(&self) -> TilePos;
    pub fn time_ms(&self) -> f64;
}
```

`entities`/`registry` come from `Replica::{entities_map, registry}` -- made **`pub`, not
`pub(crate)`** (a real, deliberate visibility bump, not an oversight): `WorldRead<G>` stays
object-safe by design (0003), so `EntityIter` cannot be built through it, and `fixtures/drawables`'s
own native golden test (a *different* crate) needs both accessors to build a `FrameView` directly,
outside `game_instance.rs`. Same reasoning promotes `DrawList::begin_frame`/`sort_into` from
`pub(crate)` to `pub`. `entities()`'s footprint-intersection test uses `TileRect::new(origin,
TilePos::new(origin.x + footprint.w - 1, origin.y + footprint.h - 1))` (inclusive rect, matching
`TileRect`'s own convention) intersected against `visible()`.

**`px_per_tile()` is a placeholder (`0.0`), not exact -- for cut 2: exactly what is missing and
where it comes from.** `CameraBlock` (`client/camera.rs`, 80 bytes, byte-for-byte matching
`camera/block.ts`) carries `centre`, `half_extent_tiles`, `tiles_across`, `dpr`, `cursor_tile` --
every quantity the *shader's* own `tiles_per_px` needs except the one this accessor would need: the
**real device-pixel viewport size** (`viewport_px: vec2<f32>` in `render/wgsl/terrain.wgsl`'s
`FrameUniform`, computed on the main thread from `renderer.viewport`/`ResizeObserver`, 0018 §8, and
never copied into any SAB the client worker reads). The exact formula once that value exists:
`pxPerTile = max(viewportPxW, viewportPxH) / tilesAcross` (`camera/transform.ts`'s own `pxPerTile`,
already used for cursor/pointer math on the main thread) -- the missing piece is only the *carrier*:
either (a) grow `CameraBlock` by 8 bytes (two `f32`, `viewport_px`) written by `camera.tick()`
alongside `half_extent_tiles` every rAF, the same pass that already writes the block, or (b) have
`FrameCx`/`ClientSide::frame` (M18) read it some other way once `FrameCx` itself is real (still a
shell here). Nothing in steps 1-3 reads this value (not in "Tests added"); `draw.screen_px_stroke_
constant_under_zoom` (cut 2's own test) is the first thing that will need it for real, since
`SCREEN_PX_STROKE`'s own constant-screen-width behaviour has no other data source once a real
shader exists (the vertex shader can read the frame uniform's `tiles_per_px` directly instead of
this accessor, since it already has `viewport_px`/`tiles_across` there -- so route (a)/(b) above
matters only if `extract()` itself, not the shader, ever needs to *decide* something from a real
pixel size, e.g. a screen-space culling threshold). Left for cut 2 to choose (a) or (b) and wire it.

### `extract` relative to `on_frame`/`ui` inside the client wake

Unchanged from M16b: `worker/client.ts`'s `body()` still calls `frame(t_ms)` before `netPump.pump()`
(which calls `on_frame`), so `extract` (inside `frame()`) runs against replica state as of the
*previous* wake's `on_frame`, same as `ui.maybe_run`'s own dirty-flag-only call already did.
Within `frame()` itself, the order is: `set_camera`/`feed.on_frame`/`uploader.on_frame` (unchanged)
-> build this frame's `CachedCameraView` (window origin, visible rect, zoom, cursor tile) -> build
`FrameView` -> `ui.maybe_run(client, &view, ...)` -> `drawlist.begin_frame(window_origin)` ->
`client.extract(&view, drawlist)` -> `drawlist.sort_into(region, time_ms)`. `ui` runs *before*
`extract` on the same `view` (arbitrary but harmless: neither reads state the other writes).

`on_frame`'s own `FrameView` (built for its `ui.maybe_run` call, unchanged from M16b otherwise) has
no `CameraBlock` in scope (`Instance::on_frame`'s signature is `bytes` only) -- it reuses the last
real `frame()` call's own camera-derived fields, cached on `ClientInstance` as `CachedCameraView`.
`ui()` never reads them today, so the one-wake staleness this can introduce is harmless; flagged
here in case a future game's `ui()` does read `visible()`/`zoom()`/etc.

### `ClientInstance<G>`'s own new fields, and the raw-pointer pattern

`drawlist: Box<DrawList>` (boxed for the same reason `core`/`uploader`/`input_queue` are: a 65,536-
capacity `Vec<Draw>` alone is 2 MiB). `drawlist_region: *mut u8`, taken once at `init` from
`layout.ptr(RegionId::DrawList)` -- **not** a new `Instance::frame` parameter: `CameraBlock::ptr`'s
own precedent and safety argument (`client/camera.rs`'s doc comment) is reused verbatim rather than
changing `Instance::frame`'s signature (which three low-level fixtures -- `terrain`, `worldgen`,
`hash` -- also implement directly; a signature change would have forced edits there too, for no
seam benefit). `GameInstance::Client` is now `Box<ClientInstance<G>>` (clippy's `large_enum_variant`
tripped once `drawlist`/`drawlist_region`/`camera_view` joined the struct); every `GameInstance::
Client(c) => c.field` call site is unaffected (`Box`'s `Deref` makes field/method access
transparent), the two `let ClientInstance { .. } = c;` struct-destructures now read `c.as_mut()`.

### Builder signatures (0018 §2 elides everything past `sprite`/`circle`/`ring`)

This cut's own reading, uniform across every non-sprite kind: `fn KIND(&mut self, layer: u8, pos:
WorldPos, size: [f32; 2], color: u32[, progress: f32 for bar/radial]) -> &mut Draw`. `sprite`
matches the ADR exactly (`layer, pos, SpriteId`). `layer` clamps to `0..=7` (`layer.min(7)`) rather
than panicking on a game's own out-of-range value (client-role code, outside the deterministic
core). Kind constants: `KIND_SPRITE=0, KIND_CIRCLE=1, KIND_RING=2, KIND_RECT=3, KIND_BAR=4,
KIND_RADIAL=5, KIND_GHOST=6` (top 4 bits of `kind_sprite`). Flag bits: `ANCHOR_CURSOR_TILE=1,
SCREEN_PX_STROKE=2, PREDICTED=4, FLIP_X=8`. Window origin snap: `(tile >> 6) << 6` per axis
(floor to a multiple of 64, arithmetic shift -- matches `ChunkDims::chunk_of`'s own negative-correct
style), exposed as `client::drawlist::snap_window_origin(TilePos) -> TilePos`.

### Steps 2/3 boundary: real, not clean (recorded rather than hidden)

`FrameView::new`'s only caller is `game_instance.rs`'s `frame()`/`on_frame()`; growing the
constructor necessarily broke that call site immediately. Step 2's own commit therefore also wires
the new `FrameView` arguments from the real camera block (`CachedCameraView`, the window-origin/
visible-rect maths, the `Box<ClientInstance<G>>` clippy fix) -- everything needed to *compile* and
give `FrameView` real values. Step 3's own commit is strictly the *new* behaviour on top: `drawlist`/
`drawlist_region` fields, the `begin_frame`/`extract`/`sort_into` call sequence, and `drawlist_len`.
Verified independently: `packages/engine` was `cargo check`ed (and the full `rust` suite run) at
each of the three step boundaries in isolation (temporarily stashing the following step's files) to
confirm each commit's own tree actually compiles and its own tests pass, before restoring and
moving to the next step -- steps 1 and 2's own intermediate states pass `cargo check --workspace
--features testing` clean (step 2's leaves `DrawList::record_count` genuinely dead until step 3
wires its one caller, so `pnpm lint`'s `-D warnings` clippy run is red on that one intermediate
state only; the final state, after step 3, is clean).

### "Prove the publish end to end": native-vs-`.wasm`, not self-consistency (revised at the gate)

The first draft compared the published slot against the WASM region it was copied *from* -- proves
the copy is faithful, but cannot catch the `.wasm` build's own `DrawList` diverging from native (a
different sort, a different window-origin snap, a float difference). Fixed per the cut-1 gate, in
the same shape `puts_idle_100`/`puts_script_a` already use: **one golden file, two runtimes.**

- **`fixtures/drawables/tests/golden/drawables_hash.hash`** (native byte-format golden kind, M05):
  a single `hash_region`/`hashDrawListFields` result, 16 lowercase hex digits, blessed with `GOLDEN_
  BLESS=1 cargo nextest run -p fx-drawables -E 'test(drawlist_fixture_hash_golden)'` (`pnpm golden:
  bytes`'s own wrapper rejects `-p`/`-E`, `packages/engine/CLAUDE.md`'s note).
- **Native** (`fixtures/drawables/tests/drawlist_golden.rs`, rewritten): `drawlist_fixture_hash_
  golden` no longer hand-assembles a `FrameView` over a `Loopback`-built replica. It drives
  `GameInstance<Drawables>` **directly** -- `sim.sim_genesis()`/`sim_connect(0)`, then 8 rounds of
  `client.frame()` -> `client_poll_uplink()` -> `sim.sim_admit()` -> `sim.sim_tick()` -> `sim.
  sim_build_frame()` -> `client.on_frame()`, then one final `client.frame()` -- the exact `Instance`
  methods `export_game!(Drawables)` points the compiled `.wasm`'s exports at, called as plain safe
  Rust (no ABI marshaling needed natively). `RegionLayout::bytes(RegionId::DrawList)` (already
  `pub`) reads the raw region afterward; `hash_region(region, drawlist_len())` is compared with
  `assert_golden_hash!`.
- **Wasm** (`tests/wasm/drawlist.test.ts`'s new `drawlist_hash_matches_native_golden`): the *literal
  TS translation* of the same 8-round loop, against real `fx-drawables.wasm` sim/client instances
  (`driveFixedScenario`, shared with the existing publish test), with the *same* camera (centre
  `(0, 0)`, `tilesAcross` 10, half extent `(40, 40)`) and the *same* config (`seed`
  `"0x1234567890abcdef"` -- does not actually change `fx-drawables`' fixed-entity output, kept
  identical anyway so nothing needs to be reasoned about as "doesn't matter"). Reads `RegionId.
  DrawList` directly, calls `hashDrawListFields`, reads the same `.hash` file with `node:fs`, and
  asserts equality.
- **Why this pairing catches real divergence, not just record count:** `hashDrawListFields`/
  `hash_region` include `window_origin` and the body's own relative `pos` bytes -- a wrong snap, a
  wrong sort key or a float rounding difference changes the hash even when `record_count` is
  unchanged.

**Verified: a perturbation goes red.** Temporarily set `tests/wasm/drawlist.test.ts`'s own
`state.centreX = -1` (the wasm side only; native's `shared_camera()` untouched) -- `-1` still keeps
every genesis entity inside `visible()` (`recordCount` stays `3`) but crosses `snap_window_origin`'s
64-tile boundary the other way (`window_origin.x` becomes `-64`, not `0`), changing every `pos` byte
in the body. Result: `drawlist_hash_matches_native_golden` failed at the hash comparison itself
(`expected 'a79fe2eba7c25b7d' to be '07e82d2cb76fe412'`), not at an earlier assertion -- confirming
the test actually exercises the window-origin/body-byte path, not just `recordCount`. Reverted
(`git diff` on the file shows a no-op after revert); `pnpm test wasm -t drawlist` green again
(2 tests).

The one property still *not* covered: `tests/wasm/drawlist.test.ts`'s `drawlist_publish_matches_
the_wasm_region_byte_for_byte` (unchanged from the first draft) is the copy-fidelity proof --
together with the native-vs-`.wasm` golden above, "cut 2 builds on a publish that is already
proven" now covers both halves: the `.wasm` build's own `DrawList` matches native, and the publish
pump copies it faithfully.

### `no_alloc_drawlist.rs`: not fault-injected

Built exactly on `no_alloc_ui.rs`'s own template (measured at two window lengths, asserted equal).
Unlike M16b's own `no_alloc_ui` work, this cut did not additionally break the code to watch the
assertion fail before reverting -- the template itself is already trusted (this is its third use:
`no_alloc_connection`, `no_alloc_ui`, now this), and time was spent elsewhere. `drawlist_extract_
and_sort_does_not_grow_the_arena` passes (both windows read `0` growth) via `DrawList`'s own fixed-
capacity scratch `Vec` (reserved once at `CAPACITY = 65,536`) and `sort_into` writing into a
caller-owned region rather than a buffer of its own.

### `docs/plan/device-checks.md`

Brief says "None" (M17b carries the manual run); untouched.

### Verified (commands and results)

- `pnpm test rust -t draw` -> `rust pass 6 tests` (step 1: `draw_layout_is_32_bytes_le`,
  `drawlist_counting_sort_stable`, `drawlist_layer_counts_and_prefix`, `drawlist_full_drops_and_
  counts`, `drawlist_pos_relative_to_window_origin_exact_at_2pow23`, `drawlist_snap_window_origin_
  floors_to_64`).
- `pnpm test rust -t frameview` -> `rust pass 2 tests` (`frameview_entities_sorted_and_clipped`,
  `frameview_zoom_matches_camera_block`).
- `cargo nextest run -p fx-drawables` (`pnpm test rust`'s own `-t`/`-p` substring filter can't select
  one fixture crate; `cargo nextest`'s `-p`/`-E` flags aren't accepted through `pnpm golden:bytes`'s
  own arg-passthrough either, so this and the next line are the raw commands) -> 6 tests pass:
  `drawlist_fixture_hash_golden` (native-vs-`.wasm` golden, `GOLDEN_BLESS=1 cargo nextest run -p
  fx-drawables -E 'test(drawlist_fixture_hash_golden)'`-blessed to `07e82d2cb76fe412`),
  `drawlist_zoom_threshold_hides_only_the_small_entity` (`below=3, at=3, above=2` -- `>`, not `>=`),
  `drawlist_fixture_hash_is_pure_function_of_replica_and_camera` (two independently built
  `Loopback`s produce byte-identical output), plus 3 `export_bindings_*` (ts-rs auto-generated).
- `cargo nextest run -p engine --features testing -E 'binary(no_alloc_drawlist)'` -> 1 test passes,
  both windows `0` B growth.
- `pnpm test wasm -t drawlist` -> `wasm pass 2 tests` (`drawlist_publish_matches_the_wasm_region_
  byte_for_byte`, `drawlist_hash_matches_native_golden` -- the latter reads the same `drawables_
  hash.hash` the native test above blesses and compares equal: `07e82d2cb76fe412`).
- Full `pnpm test rust` -> `rust pass 321 tests` (was 306 at M16b done, unchanged by the gate fix:
  one test replaced in place, not added). Full `pnpm test wasm` -> `wasm pass 49 tests` (was 48
  before the gate fix: `+1`, the new native-vs-`.wasm` golden test). Full `pnpm test unit` -> `unit
  pass 196 tests` (unchanged). `pnpm lint` -> `biome pass · rustfmt pass · clippy pass · tsc pass`,
  at the final tree. `wgsl.uberquad_validates` and every browser test in "Tests added" are steps
  4-6's, not run here (no `uberquad.wgsl` exists yet).
- `pnpm test`/`pnpm test:slow`/the browser suite were not run (delegation prompt: "Don't run the
  full suites; I am the gate").

### Notes for cut 2 (steps 4-6)

- **`FrameView::px_per_tile()`** is `0.0` always. Missing: a real device-pixel viewport size, which
  no SAB/region currently carries into the client worker (`CameraBlock` has everything else
  `tiles_per_px` needs). See the `px_per_tile()` Deviations entry above for the exact formula and
  the two candidate carriers (grow `CameraBlock` by 8 bytes, or a `FrameCx`-era mechanism once M18
  lands it) -- resolve before `draw.screen_px_stroke_constant_under_zoom` needs a real value.
- The header's `flags` field (offset 52) has no named owner in the brief; this cut leaves it `0`.
  If steps 4-6 need a header-level flag before M18/M19 land, that ambiguity needs resolving then.
- `hashDrawListFields`/`hash_region`'s field selection (record_count + window_origin + layer_count +
  dropped + body, `frame_seq`/`frame_time_ms` excluded) is this cut's own reading, fixed at the
  cut-1 gate; if a later browser test (`drawlist.triple_newest_wins`, "Tests added") wants a
  different shape, both the Rust and TS sides need updating together to stay twins.
- `fixtures/drawables/tests/drawlist_golden.rs`'s `drawlist_fixture_hash_golden` now drives
  `GameInstance<Drawables>` directly (sim + client, 8 rounds of `frame`/`client_poll_uplink`/
  `sim_admit`/`sim_tick`/`sim_build_frame`/`on_frame`) rather than `Loopback`; the other two tests in
  that file still use `Loopback` + a hand-built `FrameView` and were left alone.
- `Draw`'s builder return value (`&mut Draw`) lets a caller chain further field writes (`.flags |=
  ...`, `.pick_id = ...`) after the initial call; no test in this cut exercises that chaining, but
  the shape is there for M18's picking/anchor work and M26's `PREDICTED` styling.

## Steps 4-6 (main acquire/draw, cursor-anchored ghost, counters, zero-GC page, final number)

Base: `7a99608` was not the true base -- steps 1-3's committed head (`c64aa63`) already had an
**uncommitted** step-4 tree (drawables renderer, uberquad shader, camera `viewport_px`, page/spec
files) sitting in the working tree, left mid-flight by a prior session. This cut read it, kept what
was sound (all of it, on inspection -- see below), finished step 4, and committed steps 4-6 as
`7a99608`/`b9d9ae0`/`63fe6f1`.

### `px_per_tile()` resolved for real -- option (a), `CameraBlock` grown

The predecessor's uncommitted tree already chose and implemented option (a) from the "Notes for cut
2" entry above: `CameraBlock::viewport_px: [f32; 2]` fills what was `_reserved1: [u32; 2]` at byte
offset 72 (`CameraBlock::BYTES` stays 80, no field moved), written by `frame-loop.ts`'s `tick()`
every rAF from `renderer.viewport.widthPx/heightPx` (post render-scale), right after
`applyPending()` refreshes the renderer's viewport and before `writeCameraAndWake()`.
`game_instance.rs` derives `px_per_tile = max(viewport_px[0], viewport_px[1]) / tiles_across` when
`tiles_across > 0`, else `0.0` (every native test built from `CameraBlock::for_test` never sets
`viewport_px`/`tiles_across`, so this guard is what keeps existing native tests unaffected). This
cut inspected the diff, ran it against `pnpm test rust -t camera_block` (3 tests) and confirmed it
matches the brief's own formula (Planning decisions references `camera/transform.ts`'s own
`pxPerTile`); no changes made to this part.

### `uberquad.wgsl`/`render/drawables.ts`: exact seam shapes, as landed

- **`DrawablesRenderer`** (`render/drawables.ts`): `writeFrameUniform(v: DrawFrameUniformValues)`,
  `acquire()` (production: pulls the newest `drawList` triple-buffer slot via one `TripleReader`
  built once at `createDrawablesRenderer`, then one `queue.writeBuffer`), `acquireFromBytes(header,
  body)` (the hand-filled-scene path `draw-readback.spec.ts` uses), `draw(target)` (standalone,
  own encoder/pass/submit -- `renderTo(drawablesRenderer, opts)`), `encodeInto(pass)` (the
  shared-pass path, returns the draw-call count it issued), `drawCalls()`/`instanceBytes()`/
  `pipelineSwitches()`/`drawListDropped()` (the `engine/test` counters), plus three test-only
  accessors this cut added in step 6 -- `frameSeq()`/`recordCount()`/`nonEmptyLayerCount()` -- all
  reading fields the renderer's own `acquireCore` already caches on every `acquire()`/
  `acquireFromBytes()` call (`lastFrameSeq`, `lastRecordCount`, the existing `layerCounts`
  `Uint32Array`), never a second `TripleReader` (see "Two-reader torn read", below).
- **`UBERQUAD_VERTEX_LAYOUT`**: `arrayStride: 32`, `stepMode: 'instance'`, five attributes covering
  bytes `[0, 28)` of a `Draw` record (`pos` float32x2, `size` float32x2, `kind_sprite|layer<<16|
  flags<<24` as one `uint32`, `color` as `unorm8x4` in byte order `[r,g,b,a]`, `param` float32);
  `pick_id` (`[28, 32)`) is never bound. `packDrawColor(r,g,b,a)`/`packDrawKindLayerFlags(kind,
  spriteId,layer,flags)` build the packed fields on the TS side (used by `draw-scene.ts`'s
  `buildDrawListBytes`, the hand-filled-scene helper).
- **`DrawFrameUniformValues`** (48-byte `DrawFrame` uniform, `uberquad.wgsl`): `camTileX/Y`,
  `camFracX/Y`, `windowOriginX/Y`, `cursorTileX/Y`, `viewportPxW/H`, `tilesPerPx`, `cursorValid` --
  a **separate** uniform buffer from terrain's own `FrameUniform` (Files touched lists neither
  `render/terrain.ts`'s bind group nor `wgsl/terrain.wgsl`); every page driving both renderers
  writes the overlapping fields into each renderer's own uniform once per frame (no engine-owned
  camera-to-uniform bridge exists yet for either renderer, same as terrain's own precedent).
- **`attachDrawables(terrain, drawables)`**: wires `drawables.encodeInto` into a new
  `TerrainRenderer.onEncode(cb)` hook (`render/terrain.ts`), called inside `draw()`'s own pass right
  after the terrain triangle, before `pass.end()`. `TerrainRenderer.drawCalls()`'s own doc comment
  changed from "count of `draw()` *method* calls" to "count of GPU `draw()` calls" (identical for
  every caller that never registers `onEncode`, which is every existing terrain/connected-terrain/
  sim-paced/etc. page): **verified** this added no measurable cost to those pages by re-running their
  own `pnpm test browser -t "<page> clean"` against the *unchanged* existing `budgets.json` rows for
  `terrain`, `connected-terrain` (`zero_gc_action`), `input` and `sim-paced` -- all pass, confirming
  the brief's own binding decision ("align terrain/input... if the formula gives a figure higher than
  today's, keep today's number and report the formula's figure") needed no action: nothing about
  those pages' own wrapper count or hot-path code changed (`encodeCallback` is a plain `undefined`-
  by-default module closure, checked once per `draw()` call, no allocation).
- **`wgsl_uberquad_validates`** (`crates/engine/tests/wgsl.rs`): `naga` parse + validate +
  entry-point presence (`vs_main`/`fs_main`), the same shape `wgsl_terrain_validates` already uses,
  named separately so a broken uber-quad shader is named by test output.

### Steps 4/5 boundary: not clean, same as steps 2/3's own precedent

The predecessor's single `uberquad.wgsl` commit already contained `ANCHOR_CURSOR_TILE`'s branch
(`vs_main` selecting `cursor_tile` vs `window_origin` as the anchor, plus `hidden = cursor_valid ==
0u`) and `KIND_GHOST`'s fixed `alpha = 0.5`, alongside every other kind -- the file was authored
once, covering the whole Scope list. This cut's own step 5 work is therefore two tests only
(`draw.ghost_follows_cursor_same_frame`, `draw.one_frame_old_list_has_no_error`), not new shader
code; recorded here rather than silently treating step 4's commit as if it had left the ghost
unfinished.

### Failability, all six new browser tests: injected, verified red, reverted

Per the brief's binding instructions ("say what a wrong implementation would still pass ... prove
failability by injection"), each of the six new `draw-readback.spec.ts` tests was proven by a
temporary, reverted edit to `uberquad.wgsl`/`render/drawables.ts` (each covers a distinct branch):

| Test | Injected fault | File / branch | Result before revert |
|---|---|---|---|
| `draw.circle_and_ring_probe` | `alpha = outer_a` (dropped the ring's inner-hole term) | `uberquad.wgsl` `fs_main`, `KIND_RING` | `expectPixel(32,26)` failed (hole pixel read green, not red) |
| `draw.rect_bar_radial_probe` (bar) | `in.uv.x >= in.param` (reversed fill direction) | `uberquad.wgsl` `fs_main`, `KIND_BAR` | `expectPixel(24,32)` failed at `param=0` |
| `draw.rect_bar_radial_probe` (radial) | `atan2(-local.x, -local.y)` (reversed sweep) | `uberquad.wgsl` `fs_main`, `KIND_RADIAL` | `expectPixel(43,32)` failed at `param=0.5` |
| `draw.layers_order` | iterate layers `7..0` instead of `0..7` | `render/drawables.ts` `encodeDraws` | `expectPixel(32,32)` failed (red won over blue) |
| `draw.screen_px_stroke_constant_under_zoom` | `thickness_uv = RING_THICKNESS_DEFAULT` unconditionally (ignore `SCREEN_PX_STROKE`) | `uberquad.wgsl` `fs_main`, `KIND_RING` | the zoomed-in discriminating probe (`64,40`) read the ring colour instead of transparent |
| `draw.ghost_follows_cursor_same_frame` | `if (false && (flags & ANCHOR_CURSOR_TILE) ...)` | `uberquad.wgsl` `vs_main` | ghost stayed at `window_origin` (px `0,0`), never moved to the cursor tile |
| `draw.one_frame_old_list_has_no_error` | `rel_tile = vec2<f32>(origin_tile) - frame.cam_frac` (dropped `cam_tile`) | `uberquad.wgsl` `vs_main` | the rect stayed at its first-camera pixel after the camera moved |

Every injection was reverted immediately after confirming the red result (`git diff` empty on
`uberquad.wgsl`/`drawables.ts` before the next commit); `pnpm test browser -t draw` was green (13
tests, ~5s of the 25s budget) at every commit boundary. Durations (`test-results/browser/report.json`):
`draw.circle_and_ring_probe` 463ms, `draw.ghost_follows_cursor_same_frame` 498ms, `draw.
one_frame_old_list_has_no_error` 490ms, `draw.rect_bar_radial_probe` 695ms, `draw.layers_order`
477ms, `draw.screen_px_stroke_constant_under_zoom` 468ms, `drawlist.triple_newest_wins` 488ms,
`counters.draws_equal_nonempty_layers` 474ms, `drawables clean`/`neg object *` 1.3-1.6s each.

### `fixtures/drawables` gains one `Action`, `Spawn`

`genesis` stays fixed at its original three entities (unchanged: `drawlist_fixture_hash_golden`'s
own golden and `drawlist_zoom_threshold_hides_only_the_small_entity`'s `below=3, at=3, above=2` both
depend on that exact count, verified still passing, golden unchanged). `Action::Spawn { at: Pos,
small: bool }` is new -- always admitted, always applied (`w.spawn(Entity { pos: at, small })`),
same shape as `fx-puts`'s own `Action::Spawn` -- the `drawables` zero-GC page's own way to reach a
few hundred entities without hand-writing them into `genesis`. `cargo nextest run -p fx-drawables`:
6/6 pass (golden hash unchanged: `drawlist_fixture_hash_golden` still blessed to
`07e82d2cb76fe412`; `export_bindings_action` regenerates `fixtures/drawables/target/ts-rs-scratch/
Action.ts` with the new variant, not committed -- `bindings/` for this fixture is scratch-only, no
game package consumes it the way `fx-puts`'s `bindings/` does).

### Two-reader torn read: found and fixed before commit

A first draft of the `drawables` page's own `window.__drawablesTest` test hooks
(`frameSeq()`/`recordCount()`/`layerCounts()`) each built a **second, independent** `TripleReader`
over `clientTestHandle(client).sabs.drawList`, separate from `drawablesRenderer`'s own internal one.
`sab/triple.ts`'s `TripleReader.acquire()` is not read-only: it does an `Atomics.exchange` that
hands back its own front slot and takes whatever the writer last published, mutating **shared**
triple-buffer state on every call. Two independent readers each calling `acquire()` raced that
exchange: one manual check (`recordCount()` read `301`, `layerCounts()` read `[0,0,0,0,0,0,0,0]` on
the very next call, against the same real published slot) confirmed the tear directly. Fixed by
deleting the second reader entirely: `DrawablesRenderer` gained `frameSeq()`/`recordCount()`/
`nonEmptyLayerCount()` (reading the same cached fields `acquireCore` already writes on every real
`acquire()`), and every `window.__drawablesTest` hook routes through `drawablesRenderer`'s own
`acquire()` exclusively. `engine/test`'s existing `drawListHash`/`drawListRecords`
(`test/client.ts`) are unaffected -- they build their own lone `TripleReader` per call, safe only
because nothing else on those call sites ever holds a second one alive at the same time; this
milestone's own `drawablesRenderer` is the first place a page keeps one *and* a test wants to read
the same SAB independently, which is what exposed the bug.

### Parked-worker hang: found and fixed before commit

A first draft of `gc-drawables.ts` called `parkWorkers(client)` immediately after `pumpUntilLive`
(matching `gc-slice.ts`'s own line for line), then ran the ~300-entity population loop's
`harness.stepFrame`/`stepSimTickSync` calls against the now-parked worker, before `installGcPage`.
Every population-loop `stepFrame` call hung until `SPIN_LIMIT` (~12s wall clock), reporting
`W_WAKE` climbing while `W_ACK` stayed frozen at 0 on the `client` isolate (`stepFrame`'s own
`spinTimeoutMessage`). Root cause: **a parked worker only responds to a `{ type: 'resume' }`
postMessage**, not a plain `Atomics.notify` wake (`resumeWorkers`'s own doc comment: "a parked
worker is not blocked" -- parking's `W_YIELD`/`W_PARKED` protocol is a *different* idle mechanism
from the normal `Atomics.wait` loop a freshly-spawned production worker sits in). No other
production-topology page (`gc-terrain.ts`, `gc-connected-terrain.ts`, `gc-slice.ts`) ever calls
`stepFrame` from its own top-level setup script after parking -- they park once and leave `drive()`
unregistered until a test's own `window.__gc.run()` calls `harness.resume()` first (`gc-page.ts`'s
`run()`); this milestone's own setup-time population loop is the first thing to need real frame
stepping *during* page setup, which is what exposed the ordering requirement. Fixed by moving
`parkWorkers(client)` to run once, after every other setup step (drawables renderer, camera,
population loop, upload drain, `EXTRA_SPAWN` bytes), immediately before `installGcPage` -- the
worker spends the whole population loop in its normal, unparked, wake-responsive state and is only
parked right before `__pageReady`, matching what every other production-topology page's own
`__pageReady` state already is. `gc-drawables.spec.ts`'s own `drawlist.triple_newest_wins`/
`counters.draws_equal_nonempty_layers` tests hit the identical class of bug one level up (calling
`stepClientFrameOnly()` against the page's parked-at-`__pageReady` state) and are fixed the same
way: `window.__drawablesTest.resume()`/`.park()` (thin wrappers over `resumeWorkers`/
`parkWorkers`) bracket each test's own direct driving, mirroring `window.__gc.run`'s own bracketing.

### Population loop and entity count

`POPULATE_COUNT = 300`, dispatched as `Action::Spawn` in a 20-column grid (`GRID_SPACING = 4`
tiles) centred near the origin, one `dispatchRaw` + `harness.stepFrame` + `stepSimTickSync` triple
per entity (all one-time setup, 0016 §2, before `installGcPage`). The camera is set wide
(`POPULATE_HALF_EXTENT = 120` tiles, `tilesAcross = 24`) *before* population and stays that way for
the whole run (including the measured window's own panning, `PAN_TILES_PER_SECOND = 8`) so every
populated entity's own chunk stays subscribed and inside `visible()` throughout -- this page is not
exercising eviction (unlike `gc-terrain.ts`'s small cache), only a DrawList genuinely wide enough to
matter for `render.drawCallsMax`/`instanceBytes`. Measured: `window.__drawablesTest.recordCount()`
reads `301` after population (3 genesis + 298 of the 300 dispatched Spawns had landed in the replica
by the trailing extra tick at the time of that one manual check -- not re-verified to the exact
integer since "a few hundred entities" is what the brief asks for and this comfortably clears it;
the remaining stragglers land within the next tick or two regardless, well before any measured
window begins). `drawListDropped()` was checked manually (via `__drawablesTest`) across a normal run
and reads `0` throughout -- 301 records is far under `CAPACITY` (65,536), so the brief's Exit
criterion ("`drawListDropped == 0` in every test except the overflow test") holds; the one sanctioned
exception is `drawlist_full_drops_and_counts` (step 1, native, unaffected by this cut).

### Budget derivations, `gc.pages.drawables`

Formula throughout: 0016 §1 (`ceil(measured clean) + 8 B` margin, no attribution), the same shape
every other WebGPU-adapter page (`terrain`, `connected-terrain`/`zero_gc_action`) already uses.
Wrapper count stays `terrain`'s own 3 (`encoder`, `pass`, `commandBuffer` per `TerrainRenderer.draw()`
call) -- `drawablesRenderer.acquire()`'s `queue.writeBuffer` and `encodeInto`'s `pass.setPipeline`/
`setBindGroup`/`setVertexBuffer`/`draw` calls all return nothing, so they add WebGPU-touching work,
not a new wrapper object.

- `main`: measured `playwright test --project gc --grep "drawables clean" --repeat-each 8 --workers
  1` (this machine): 107.9667-108.2133 B/frame across 8 clean runs (`byFn`: `draw@terrain` 28800 B,
  `drain@wgsl.generated` 12000 B, `stepFrame@client` ~7200 B -- `terrain`'s own three sites,
  unchanged -- plus `pollActionResults@client-*` ~1280 B, the `EXTRA_SPAWN` dispatch's own result
  parse, `gc-slice.ts`'s own precedent for that site). `ceil(108.2133) = 109`, `+ 8 B margin = 117`.
- `client`/`gen0`: constant `0.8133` B/frame across 8 clean runs each, well under the shared "8 B"
  worker figure every other page's client/gen0 row uses -- kept at `8`, not re-derived tighter.
- `sim`: measured 4.6667-4.9333 B/frame across 8 clean runs (lower than `connected-terrain`'s own
  6.46-8.19: this page's `EXTRA_SPAWN` dispatch is rarer, once per 30 frames, and no new-chunk
  admission churn since the wide camera never changes its subscribed set). `ceil(4.9333) = 5`,
  `+ 8 B margin = 13`.
- `software.main` (`GC_MODE=software`, ADR 0029's attribution-only-`main` rule, mandatory per this
  cut's own binding decision: `gc/instrument.ts` throws on a `null` software block and CI runs this
  mode): measured `GC_MODE=software playwright test --project gc --grep "drawables clean"
  --repeat-each 6 --workers 1`: 82.02-82.0467 B/frame attributed across 6 clean runs. `ceil(82.0467)
  = 83`, `+ 8 B margin = 91`. Verified: `drawables neg object main` still trips under `GC_MODE=
  software` too (both hardware and software mode's own object control on `main` checked directly).
- `counters.render.drawCallsMax = 9` (`drawCallsTerrain` 1 + up to 8 non-empty DrawList layers) and
  `counters.render.pipelineSwitches = 1` (`encodeDraws` sets the uber-quad pipeline at most once per
  `draw()`/`encodeInto()` call, regardless of how many layers are non-empty) -- both new entries
  under `budgets.json`'s existing `counters.render` block, read by `counters.draws_equal_nonempty_
  layers` via `budget('counters.render.drawCallsMax')` (the dotted path needs the `counters.` prefix;
  a first draft's own `budget('render.drawCallsMax')` threw "no number at 'render.drawCallsMax'").
- Every negative control verified still tripping at the derived numbers: `object` (fast tier,
  `pnpm test browser -t drawables`, all 4 isolates) and `burst` (`@slow`,
  `playwright test --project gc --grep "drawables neg burst"`, all 4 isolates) both pass (meaning
  each control's own expected-mismatch verdict is observed), hardware mode; `object main` also
  re-verified under `GC_MODE=software`.
- **`terrain`/`input` alignment** (brief's own binding decision): no change made or needed. Verified
  by re-running `pnpm test browser -t "terrain clean"`, `"connected-terrain clean"`
  (`zero_gc_action`), `"input clean"` and `"sim-paced clean"` against their *existing, unchanged*
  `budgets.json` rows -- all pass. Nothing about those pages' own wrapper count or hot-path code
  changed (`TerrainRenderer.onEncode`'s `encodeCallback` is `undefined` by default, a plain checked
  closure with no allocation, and none of those pages ever calls `attachDrawables`), so the formula
  those rows already use produces the same figure it always has; there was no higher number to
  report.

### Verified (commands and results, steps 4-6)

- `pnpm test browser -t draw` -> `browser pass 13 tests` (6 readback probes + `drawables clean` +
  4 `drawables neg object *` + `drawlist.triple_newest_wins` + `counters.draws_equal_nonempty_
  layers`), 5.1s of the 25s browser-suite budget.
- `playwright test --project gc --grep "drawables neg burst"` -> 4/4 pass (`@slow`, not part of
  `pnpm test browser`'s own default run).
- `GC_MODE=software playwright test --project gc --grep "drawables clean"` -> 1/1 pass;
  `GC_MODE=software playwright test --project gc --grep "drawables neg object main"` -> 1/1 pass.
- `pnpm test rust -t drawlist` -> `rust pass 10 tests`; `-t frameview` -> `2 tests`; `-t camera_block`
  -> `3 tests`; `-t wgsl` -> `2 tests` (unchanged from steps 1-3 plus `wgsl_uberquad_validates`).
- `cargo nextest run -p fx-drawables` -> 6/6 pass, golden hash unchanged (`07e82d2cb76fe412`).
- `pnpm test unit -t drawables` -> `2 tests` (`drawables.test.ts`'s own two, plus `render.ts`
  passthrough coverage indirectly); `-t uberquad` -> `1 test`
  (`uberquad.vertex_layout_has_no_pick_id`).
- `pnpm test wasm -t drawlist` -> `wasm pass 2 tests` (unchanged from steps 1-3).
- `DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo clippy --workspace --all-targets -- -D
  warnings` -> clean. `pnpm exec biome check .` -> clean (321 files). `pnpm --filter engine
  typecheck` -> clean (all three `tsc` projects, `tests/browser/gc-drawables.spec.ts` included via
  `tests/tsconfig.json`).
- `pnpm test`/`pnpm test:slow`/`pnpm lint` (the full runs) were not run (delegation prompt: "Don't
  run the full suites; I am the gate").

### Fix round 1 (coordinator review, after M17 done)

Three tests that could not fail as intended, found by review and fixed here, each its own commit
(`037f5fa`, `f06a95d`, `60ef683`):

1. **`counters.draws_equal_nonempty_layers`** only ever saw one non-empty layer (`fx-drawables`'
   `extract` wrote every circle to layer 0), and both sides of its own comparison came from the
   same `layerCounts` array in `render/drawables.ts` (a `computeLayerOffsets` bug would have moved
   `drawCalls()`'s delta and `nonEmptyLayerCount()` together, undetected). `Entity`/`Action::Spawn`
   gain a `layer: u8` field (genesis stays at layer `0`, golden unaffected, confirmed unchanged);
   `gc-drawables.ts`'s population loop spreads its 300 entities across layers `0, 3, 7` (a gap at
   1/2/4/5/6), tracked in its own `POPULATE_LAYERS` -- the test's ground truth now, never anything
   derived from `render/drawables.ts`'s own layer-count parsing. Proven by injection: dropping the
   last layer from `encodeDraws`'s loop bound, and removing its "skip empty layers" check, both
   trip it (verified red, reverted).
2. **`counters.render.pipelineSwitches`** (`budgets.json`) was read by nothing, and neither were
   `pipelineSwitches()`/`instanceBytes()`/`__drawablesGcCounters`. New test `counters.pipeline_
   switches_and_instance_bytes`: `pipelineSwitches`'s delta across one `acquireAndDraw()` call on
   the (now three-layer) frame stays `<= budget('counters.render.pipelineSwitches')`; `instanceBytes`'s
   delta across one `acquire()` call equals `record_count * 32`. Proven by injection: moving
   `encodeDraws`'s `pass.setPipeline` call inside the per-layer loop (3 switches instead of 1) trips
   the first; an off-by-one-record byte count in `acquireCore` trips the second (verified red,
   reverted).
3. **`frameview_zoom_matches_camera_block`** (`crates/engine/src/client/frame_view.rs:346`) built a
   `FrameView` by hand with `zoom: 42.5` and read it straight back -- it proved the accessor exists,
   never that `game_instance.rs` actually wires `zoom: camera.tiles_across`/`px_per_tile` from a
   real `CameraBlock` through `Instance::frame`. Moved to `fixtures/drawables/tests/drawlist_
   golden.rs` (the only place that can drive a real `GameInstance<Drawables>` through the real ABI
   `frame()` method): three `CameraBlock`s with `tiles_across` at `SMALL_ZOOM_THRESHOLD - 1`/`at`/
   `+ 1`, checking `client.drawlist_len()` (3, 3, 2, the same numbers `drawlist_zoom_threshold_
   hides_only_the_small_entity` already pins via `Loopback`, now also proven through the real
   wiring) and a new `LAST_PX_PER_TILE` thread-local (`fx-drawables`' `extract()` records `view.
   px_per_tile()` on every call -- never touches a `Draw` record, so the golden hash is unaffected,
   confirmed unchanged). The old `crates/engine` unit test is removed, not left behind: that crate
   has no concrete `Game` whose `extract()` exposes `zoom()`/`px_per_tile()` observably. Proven by
   injection: swapping `zoom: camera.tiles_across` for `camera.half_extent_tiles[0]` trips the
   record-count assertions; dropping `.max(viewport_px[1])` from the `px_per_tile` formula trips
   the `px_per_tile` assertion (the test's own `VIEWPORT_PX` is deliberately taller than wide so
   the two candidate formulas disagree) -- both verified red, reverted.

None of the three changed `drawlist_fixture_hash_golden`'s own blessed hash (`07e82d2cb76fe412`,
re-verified after every fix). Re-verified at the end: `pnpm test browser -t drawables` -> `8 tests`
(3.8s/25s); `pnpm test browser -t draw` -> `14 tests` (5.2s/25s, the new `counters.pipeline_
switches_and_instance_bytes` at 529ms); `pnpm test rust -t drawlist/frameview/camera_block/wgsl` ->
10/2/3/2; `cargo nextest run -p fx-drawables` -> 7/7; `pnpm test unit -t drawables/uberquad` ->
2/1; `pnpm test wasm -t drawlist` -> 2 (unchanged); `cargo clippy --workspace --all-targets -- -D
warnings`, `pnpm exec biome check .`, `cargo fmt --check`, `pnpm --filter engine typecheck` all
clean. Targeted foreground runs only, nothing in the background left running, no full `pnpm test`/
`pnpm lint` (per the fix-round instruction).

### Notes for later briefs

- `window.__drawablesTest`'s `resume()`/`park()` bracketing requirement (a parked worker only
  responds to `resume`, never a bare `Atomics.notify`) applies to *any* future production-topology
  page whose own test wants to drive `stepFrame`/`stepSimTickSync` directly rather than through
  `window.__gc.run()` -- worth promoting into the `gc-test` skill's own "Production-topology pages"
  section if another milestone hits it again.
- `render/drawables.ts`'s `frameSeq()`/`recordCount()`/`nonEmptyLayerCount()` are test-only (never
  called by `attachDrawables`'s own production path) but live on the production interface rather
  than a `src/test/**` wrapper, since they read state the renderer already caches privately -- the
  same shape `TerrainRenderer.drawCalls()`/`pageSlotsUsed()` etc. already use for their own `engine/
  test` counters.
- M18 (picking) reads the same `drawList` slot and owns the header's `flags` field (offset 52,
  still unwritten) and the anchor table (`128..640`); M19 owns `presences()`. Neither was touched
  here.
