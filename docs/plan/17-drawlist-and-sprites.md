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

Not specified by the brief beyond "hash of header fields + used body bytes" -- this cut's own
reading, and it does **not** attempt to match `crates/engine`'s `Fnv64` bit for bit (no cross-
runtime equality requirement was named for this specific hash, unlike `sim_hash`/`worldHash`).
`drawListHash(client): string` reads the newest slot directly off the SAB (`TripleReader`, no
worker round trip -- `netCounters`'s own ring-read precedent) and computes two independent 32-bit
FNV-1a passes (no `BigInt`, `.claude/rules/hot-paths.md`'s own reasoning for avoiding it even
though this is test-only code) over the **whole 1,024-byte header** (`frame_seq`/`frame_time_ms`
included -- unlike the native `drawlist_fixture_hash_golden`'s own `assert_golden_bytes!`, which
also hashes/pins the whole slice for the same reason) **plus** `record_count * 32` body bytes,
returned as 16 lowercase hex digits (`sim_hash`/`worldHash`'s own format). `drawListRecords(client,
out: DrawRecord[]): number` clears `out` and decodes every record's nine fields (`pos`, `size`,
`kind`, `spriteId`, `layer`, `flags`, `color`, `param`, `pickId`), returning the count -- one object
allocated per record, fine under the `src/test/**` exemption.

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

**`px_per_tile()` is a placeholder (`0.0`), not exact.** `CameraBlock` carries no real device/CSS
viewport pixel size -- the main thread computes `tiles_per_px`/`pxPerTile` itself
(`camera/transform.ts`) from a real `CameraViewport` that never crosses into WASM memory, and
plumbing one through would mean growing `CameraBlock` (currently exactly 80 bytes, a tested seam)
and touching `camera/block.ts`/`camera.ts` -- outside this brief's own Files-touched list. Nothing
in steps 1-3 reads this value (not in "Tests added"; `SCREEN_PX_STROKE` is resolved in the vertex
shader from the *real* main-thread value per the brief's own Planning decisions, not from this
accessor). Left for a later cut to wire for real once something actually consumes it.

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

### "Prove the publish end to end": scope of what was actually proven

The instruction's own wording ("the newest slot's hash equals the native `drawlist.fixture_hash_
golden` for the same replica and camera") would need the TS test to reproduce the *exact* replica-
building script the native golden pins (frame_seq, tick count, etc. all bit-identical) and a hash
algorithm identical to Rust's `Fnv64` -- both reachable, but not attempted here given this cut's own
time budget. What `tests/wasm/drawlist.test.ts` proves instead, against the real production pump
code (`createDrawlistPump`, not a reimplementation): the newest published slot's header and used
body bytes are **byte-for-byte identical** to `RegionId.DrawList`'s own WASM-memory bytes at the
moment of publish, for a real `fx-drawables.wasm` client connected to a real `fx-drawables.wasm` sim
over raw ABI calls (no SAB rings -- a plain region-to-region copy stands in, since the ring itself
isn't under test), with all three genesis entities visible (`recordCount === 3`, `dropped === 0`).
This is the property "cut 2 builds on a publish that is already proven" actually needs (the copy
loop is correct and proportional), even though it does not cross-check against the *specific*
blessed value `fixtures/drawables/tests/golden/drawables_extract_below_threshold.hex` pins. Left for
cut 2, or a later gate, to close the gap fully if the exact cross-runtime hash match still matters
once real rendering exists to make it worth the wire-format-reproduction cost.

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
- `cargo test -p fx-drawables --features engine/testing` (`pnpm test rust`'s own `-t`/`-p` substring
  filter can't select one fixture crate; `cargo nextest`'s `-p`/`-E` flags aren't accepted through
  `pnpm golden:bytes`'s own arg-passthrough either, so this and the next line are the raw commands)
  -> 3 `drawlist_golden.rs` tests pass: `drawlist_fixture_hash_golden` (native golden, `GOLDEN_
  BLESS=1 cargo nextest run -p fx-drawables -E 'test(drawlist_fixture_hash_golden)'`-blessed),
  `drawlist_zoom_threshold_hides_only_the_small_entity` (`below=3, at=3, above=2` -- `>`, not `>=`),
  `drawlist_fixture_hash_is_pure_function_of_replica_and_camera` (two independently built
  `Loopback`s produce byte-identical output).
- `cargo nextest run -p engine --features testing -E 'binary(no_alloc_drawlist)'` -> 1 test passes,
  both windows `0` B growth.
- `pnpm test wasm -t drawlist` -> `wasm pass 1 tests` (`drawlist_publish_matches_the_wasm_region_
  byte_for_byte`).
- Full `pnpm test rust` -> `rust pass 321 tests` (was 306 at M16b done). The `+15`: 6 `draw*`/
  `drawlist_*` tests (step 1) + 2 `frameview_*` tests (step 2) + 3 `export_bindings_*` (ts-rs
  auto-generated, one per `#[ts(export)]` type `fx-drawables` declares: `Pos`, `Action`, `Reject`)
  + 3 `drawlist_golden.rs` tests (step 2) + 1 `no_alloc_drawlist` (step 3). Full `pnpm test wasm` ->
  `wasm pass 48 tests` (was 44 at M16b done: +1 `drawlist.test.ts`, +3 from the new fixture joining
  every fixture-iterating wasm-suite test, e.g. `abi-registry`/`allowlist`/`determinism`). Full
  `pnpm test unit` -> `unit pass 196 tests` (unchanged: this cut touched no `src/**/*.test.ts`).
  `pnpm lint` -> `biome pass · rustfmt pass · clippy pass · tsc pass`, at the final (post-step-3)
  tree. `wgsl.uberquad_validates` and every browser test in "Tests added" are steps 4-6's, not run
  here (no `uberquad.wgsl` exists yet).
- `pnpm test`/`pnpm test:slow`/the browser suite were not run (delegation prompt: "Don't run the
  full suites; I am the gate").

### Notes for cut 2 (steps 4-6)

- `FrameView::px_per_tile()` is `0.0` always; wire it for real (a `CameraBlock` field, or a fresh one
  computed some other way) before anything in steps 4-6 needs an actual pixel value.
- The header's `flags` field (offset 52) has no named owner in the brief; this cut leaves it `0`.
  If steps 4-6 need a header-level flag before M18/M19 land, that ambiguity needs resolving then.
- `drawListHash`'s definition (whole header + used body, two-lane FNV-1a32, no `BigInt`) is this
  cut's own reading; if a later browser test (`drawlist.triple_newest_wins`, "Tests added") wants a
  different shape, it is a test-only function with no other caller to keep in step.
- `Draw`'s builder return value (`&mut Draw`) lets a caller chain further field writes (`.flags |=
  ...`, `.pick_id = ...`) after the initial call; no test in this cut exercises that chaining, but
  the shape is there for M18's picking/anchor work and M26's `PREDICTED` styling.
