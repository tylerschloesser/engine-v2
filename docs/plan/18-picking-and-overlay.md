# M18: Picking, overlay anchoring, `FrameCx`

Status: done · After: 17, 09b · Tyler-dependent: no

Carries a **D**: overlay anchoring on iOS Safari. Order against M19 does not matter: both start from M12's `FrameCx` shell, and whichever lands first adds the `ClientSide::frame` call (M19's brief says the same).

Sized at the limit (estimate ≈ 1,600 lines). Pre-agreed cut if the session runs long: everything under "Rust side" below moves to a new `18b-framecx-and-follow.md` (M20b would then wait for it).

## Goal
Main-thread side: taps and hovers carry the `pick_id` of what is on screen, found by scanning the newest DrawList slot; game DOM elements anchor to world positions or to Rust-published slots through the custom-property mechanism, written in the same rAF as the GPU submit. Rust side: `ClientSide::frame` runs every produced frame with a `FrameCx` that exposes the camera block, the frame's input events and `follow`; a cursor-anchored ghost works end to end for mouse and for the touch tap-then-confirm flow.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` (§1 "Follow target", §4 "Picking", "Cursor tile and ghost", "Input over DOM UI", §5, Consequences)
3. `docs/decisions/0003-game-facing-api.md` (`ClientSide::frame`; "Outside the deterministic core")
4. `docs/decisions/0016-zero-gc-definition.md` (§2: the overlay line in the exemptions; the deferred string constant)

Mine from spikes: none. Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
Main-thread side
- `input/pick.ts`: scan per 0019 §4 over long-lived typed views of each triple-buffer slot; shape containment per `kind`; `pick_id` written into `tap`, `longpress`, `hover` and `drag*` events and ring records; hover pick at most once per rAF and only when the pointer or the slot changed.
- `overlay/anchors.ts`: the anchor layer, the injected static rule, `client.overlay.anchor` and `anchorSlot`, floating origin and re-base, visibility toggling on transitions, the at-most-two-writes rule, slot anchors from the header's anchor table; the per-anchor `translate()` fallback mode behind an option.
- Frame loop: a new first phase `acquire` (take the newest DrawList slot once), so camera follow, picking, overlay and render all use the same slot.
- `client.input.emit(code: number, a = 0, b = 0): boolean` (0024 §7c): the TypeScript-to-`ClientSide` channel for client-local UI intent. It writes one record of a new kind 7 ("game": `code u32` in the `pick_id` field, `a`/`b` as `i32` in the tile field, all else zero) into M11's 32-byte `inputRing` layout; the record surfaces in `FrameCx::input()` in ring order, is not delivered to `client.input.on`, is never dropped by `InputQueue` overflow, and `emit` returns `false` when the ring is full. M33 is the first consumer (construction mode).
- Device page: `device.html?anchors=50` (50 text buttons anchored to tiles, each over a pickable in-canvas ring; 4 slot anchors on moving circles; `&anchorMode=translate`), and one new HUD field on `device.html`, `pick_id`: the `pick_id` of the last `tap` event from `client.input.on` (`-` when the tap hit no drawable; unchanged by a tap on a DOM button, which never reaches the canvas).

Rust side
- `client/frame_cx.rs`: fills M12's `FrameCx` shell; `frame(t_ms)` order becomes build `FrameView` → `ClientSide::frame` → `extract` → header (`follow`, anchors) → sort → publish → clear `InputQueue`. `FrameCx::ui_dirty()` (0024 §7d) sets M16b's client-side dirty flag, so `ui` re-runs this frame when `frame` changed state the `Ui` depends on; the `PartialEq` gate is unchanged.
- `DrawList::anchor(slot, pos)`.
- Main: `camera.setFollow` from the slot header in the frame that draws that slot.

## Non-scope
Presence sampling and uplink (M19: it gives meaning to `frame`'s `presence` argument). Interpolated positions behind `cx.view()` (M30). Reference-game button and progress bar (M20b). GPU picking (rejected, 0019).

## Files, packages and crates touched
`packages/engine` (`src/input/pick.ts`, `src/overlay/anchors.ts`, `src/frame-loop.ts`, `src/camera/camera.ts`, `src/client.ts`, `src/test/*`, `tests/browser/`, `tests/browser/pages/device.html`), `packages/engine/crates/engine` (`client/frame_cx.rs`, `client/drawlist.rs`), `packages/engine/fixtures/overlay/` (`fx-overlay`: pickable circles, slot anchors, a ghost and a follow toggle).

## Seams
**Provides**
- TS on `Client`: `overlay.anchor(el, worldX, worldY, opts?)` → `{ set(x, y), remove() }`, `overlay.anchorSlot(el, slot)` → `{ remove() }` (0019 §5 signatures). `ClientOptions.overlay?: { root?: HTMLElement; mode?: 'properties' | 'translate' }` (default root: the canvas's parent; the engine appends one anchor-layer element there and **re-parents each anchored `el` into it**).
- `client.input.emit(code, a = 0, b = 0): boolean` (0024 §7c), `FrameCx::ui_dirty()` (0024 §7d), and `InputEvent` kind 7 "game" (`code()`, `a()`, `b()` accessors), consumed by M33.
- `pickAt(cssX, cssY): number` internal, used by the semantic layer; `engine/test`: `pickAt(client, cssX, cssY)`, counters `styleWrites`, `pickScanned`.
- **`FrameCx<'a, G>`** (this brief owns the shape; it fills M12's shell, and M19 adds nothing to it beyond using `frame`'s `presence` argument):
  - `view() -> &FrameView<G>`: the same value `extract` receives (M17: `WorldRead`, ticks, `visible`, `zoom`, `cursor_tile`, `me`), built before `frame` runs
  - `camera() -> &CameraBlock` (M06b: centre, velocity, `tiles_across`, half extents, `dpr`; M17: `viewport_px: [f32; 2]` at offset 72, device pixels, which is what `FrameView::px_per_tile()` reads): what the reference game's spring reads
  - `dt_ms() -> f32` (difference of successive `frame_time_ms`, clamped to 0..100)
  - `input() -> &[InputEvent]`: the events drained from `inputRing` since the previous `frame`, oldest first, at most 64, valid for this call only
  - `follow(&mut self, target: Option<WorldPos>)`
  - `ui_dirty(&mut self)` (0024 §7d; M20b is the first user)
  - no `dispatch` (see Planning decisions)
- The call of `ClientSide::frame(&mut self, cx: &mut FrameCx<G>, presence: &mut G::Presence)` (M12 declared it) once per `frame(t_ms)`, before `extract`. If M19 has not landed, the engine passes a scratch `G::Presence` it then ignores; if it has, M19's kept value.
- `DrawList::anchor(&mut self, slot: u8, pos: WorldPos)` (64 slots); header fields `follow_valid`, `follow`, `anchor_mask`, `anchors` (offsets in M17).
- `device.html` parameters `anchors`, `anchorMode` and HUD field `pick_id` (device item M18-pick reads it).
- `budgets.json`: `gc.pages.anchors` (its `main` = the strict number + the overlay string constant, spelled out in `formula`).

**Consumes** M12: `FrameCx` shell, `ClientSide`. M16b: the `ui` call policy and its client-side dirty flag. M17: slot header layout, `Draw` layout and kind constants, `FrameView`, triple-buffer reader, GC page `drawables`. M11: semantic events, `inputRing`, `InputQueue`, `camera.setFollow`, `camera.cursorTile`, `transform.ts`, injection helpers. M09b: `renderer.onViewportChange(cb)` (`Viewport = { widthPx, heightPx, dpr, renderScale }`; `notifyViewportChange()` fires every registered callback with a plain indexed loop right after `viewport` is mutated in place, at most once per frame, before the camera phase runs — the contract this milestone's anchor re-base runs against), `device.html` (its `anchors`/`anchorMode` URL parameters are reserved there but never read yet — `docs/plan/09b-terrain-art-and-lifecycle.md` Deviations, Steps 6-7: an unread `URLSearchParams` key is tolerated by construction, so this milestone can start reading them with no other change needed on that page). M03: `pnpm device:serve --tunnel`. M17b (optional): sprite pivots from `sprites.json` for sprite picking; without it a sprite picks by its `pos`/`size` rectangle. M04: `installGcPage`, `zeroGcSuite`, `budgets.json`, `pnpm gc reliability`.

## Planning decisions
- **How input reaches the game's Rust (PRE-PLAN §10 gap).** As a borrowed slice, `cx.input()`, of the same 32-byte records main wrote (M11 layout), including `pick_id`. `frame` has `&mut self`, so the game copies what it needs (selection, tool state, ghost rotation) into its `Client` value and `extract` reads it from `&self`. A slice costs nothing, keeps ordering, and needs no callback registration inside WASM.
- **`FrameCx` has no `dispatch`.** Action `seq` is assigned on main so `client.dispatch` can return it synchronously (0003); a second issuer inside the worker would need a reserved `seq` space and a second `onActionResult` path. A game turns a tap into an action in `client.input.on('tap', …)`; Rust-side input is for view state. Reopening this takes an ADR.
- **Containment per kind.** Circle, ring (outer radius) and radial: distance from `pos` ≤ `size.x / 2`. Rect, bar, ghost, sprite: the axis-aligned box of `pos` and `size` (sprite pivot applied when M17b's table is loaded). With `SCREEN_PX_STROKE` a minimum pick radius of 6 CSS px applies. The pointer is converted once to window-origin-relative f32 tiles. The scan reads the `pick_id` column first and touches the other fields only for non-zero ids.
- **Anchored elements are re-parented** into the engine's anchor layer. The mechanism needs `--z` and the layer transform to be inherited, which only descendants get; `remove()` detaches the element and leaves it to the caller.
- **Overlay string constant.** GC page `anchors` mounts exactly 50 static anchors and 4 slot anchors and pans and zooms continuously for the window. Its `main` budget = M17's strict number + the constant, where the constant is the maximum excess over 20 clean runs (`pnpm gc reliability`) plus 16 B; both the constant and the derivation go into the page's `formula` text and the measurement into Deviations (closes 0016's deferral together with M17's number). The strict pages (`input`, `drawables`) keep running with no anchors mounted and hover picking active, which proves that an anchor-free engine writes no styles.
- **Fallback is built, off by default.** `mode: 'translate'` writes one `translate()` per visible anchor per moving frame from the same rAF callback (0019 Consequences). About 60 lines; it lets the device check switch mechanisms with a URL parameter instead of a new milestone.
- **"Follow with user offset"**: closed in M11 as not in v1; `cx.follow` takes a position, so a game adds its own offset.

## Order of work
1. `acquire` phase; slot views; `pick.ts` with unit tests on hand-built slots. 2. `pick_id` in events and records. 3. Anchor layer: static anchors, two-write rule, re-base, visibility. 4. `FrameCx`, `ClientSide::frame`, `cx.input()`. 5. `DrawList::anchor` + slot anchors. 6. `follow`. 7. Ghost flows. 8. GC scenario and constant; fallback mode; device page.

## Tests added
- `unit` suite: `pick.contains_per_kind`, `pick.front_to_back_order`, `pick.skips_zero_id_and_cursor_anchored`, `overlay.rebase_math`, `overlay.align_offsets`.
- Rust native: `framecx.input_slice_order_and_clear`, `input.game_record_round_trip`, `input.game_record_survives_overflow`, `framecx.ui_dirty_reruns_ui`, `drawlist.anchor_table_and_mask`, `framecx.follow_written_to_header`.
- Browser (Chromium): `pick.tap_reports_entity_pick_id`, `pick.hover_once_per_raf_on_change`, `pick.matches_interpolated_frame_on_screen` (pick uses the slot being drawn, not a newer one), `overlay.anchor_tracks_world_point` (element rect vs `worldToScreen` within 0.5 px through pan and zoom; reading layout is allowed in tests only), `overlay.idle_writes_nothing`, `overlay.pan_one_write_zoom_two` (`styleWrites` counter), `overlay.slot_anchor_follows_rust`, `overlay.rebase_beyond_50000px`, `overlay.offscreen_hidden_on_transition_only`, `overlay.widget_click_not_a_tap`, `overlay.translate_mode_equivalent`, `framecx.tap_visible_in_frame`, `framecx.emit_visible_in_frame` (`client.input.emit(3, 1, 2)` arrives as one kind-7 event with the same three values; allocates nothing), `follow.centres_in_same_frame_pan_ignored_zoom_works`, `ghost.mouse_tracks_cursor_tile`, `ghost.touch_tap_then_confirm`.
- Zero-GC: page id `anchors` through `zeroGcSuite`; strict pages unchanged. Per ADR 0026, `anchors`' `burst` negatives are `@slow` automatically (only `gc-loop` stays fast-tier); its clean test must show `presentIsolates` containing every isolate this page names before its verdict check.

## Exit criteria
- [x] All tests above pass by name.
- [x] `budgets.json` has `gc.pages.anchors` with the constant in its `formula`; pages `anchors`, `input` and `drawables` pass.
- [x] Source scan: no `getBoundingClientRect`, `offsetWidth` or other layout read under `src/overlay/` or `src/input/`.
- [x] In desktop Chrome `device.html?anchors=50` shows `pick_id` on the HUD: a click on a ring sets it to that ring's id, a click on empty ground to `-`, a click on an anchored button leaves it unchanged (asserted by the `anchors` browser test reading the HUD text).
- [x] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t pick` · `pnpm test unit -t overlay` · `pnpm test rust -t framecx` · `pnpm test browser -t pick` · `pnpm test browser -t overlay` · `pnpm test browser -t ghost` · `pnpm test browser -t anchors` · `pnpm test` · `pnpm lint`.

## Budgets
- Allocation per isolate (0016): strict main number with no anchors; separate overlay line with 50 + 4 anchors.
- Frame time, main share (0018 §9): worst-case hover pick scans 65,536 records; `bench.frame_worstcase` (M17b) is re-run with hover active and must stay inside its threshold.

## Context artifacts
`packages/engine/CLAUDE.md`: "overlay code never reads layout; at most two style writes per frame". `packages/engine/crates/engine/CLAUDE.md`: `frame` mutates, `extract` reads; input arrives as `cx.input()`.

## Manual device checks
[device-checks.md, M18: Picking and overlay anchoring](device-checks.md#m18-picking-and-overlay-anchoring).
This milestone builds `device.html?anchors=50` for it (50 text buttons anchored to tiles, each over an in-canvas ring, plus 4 slot anchors on moving circles), the `&anchorMode=translate` switch, and the last tap's `pick_id` on the HUD.

## Deviations

**This section covers steps 1-3 only** (commits `36314e3` step 1, `124b705` step 2, `0b05f87`
step 3, base `4977d88`). Steps 4-6 (`FrameCx`, `ClientSide::frame`, `cx.input()`, `DrawList::anchor`,
slot anchors, `follow`) and 7-8 (ghost flows, the GC page `anchors`, `translate` mode, `device.html`)
are a later implementer's, built against the exact seam shapes below.

### The acquired slot (`render/drawlist-slot.ts`, new file, not in the brief's own Files list)

`DrawListSlot` (exported): `header: DataView` (1,024 B), `body: Uint8Array` (2 MiB, what
`queue.writeBuffer` wants), `bodyView: DataView` (the same bytes, what a scan's `getUint32`/
`getFloat32` wants), `recordCount`/`windowOriginX`/`windowOriginY`/`frameSeq`/`dropped: number`
(copied out of the header on every `acquire()`), `fresh: boolean`, and `acquire(): void`. Three of
each view are built once (`createDrawListSlot(sab)`); `acquire()` swaps which one the public fields
*reference* -- a plain pointer reassignment, never a new object. `createClient` (`src/client.ts`)
builds exactly **one** `DrawListSlot` per `Client`, over `sabs.drawList`, and it is the *only*
`TripleReader` that `Client` ever owns over that SAB for its whole life -- docs/plan/
17-drawlist-and-sprites.md's own "Two-reader torn read" finding (`TripleReader.acquire()` mutates
shared state on every call; two independent readers racing it tear the handoff) is now a real risk
the moment anything else builds a second one, which is why `test/client.ts`'s `drawListHash`/
`drawListRecords` were rewritten in this cut to read through `clientTestHandle(client).drawListSlot`
instead of building their own (previously safe only because nothing called them at all -- confirmed
by grep, zero call sites anywhere in `src`/`tests` before this cut).

**Revised at gate round 1 (coordinator review, commit `afdd196`): `render/drawables.ts` now reads
this slot.** The paragraph originally here called the double-reader hazard "latent, not live" because
no existing page combined real drawables rendering with real picking on one `Client` yet -- true
*today*, but wrong as a reason not to fix it: `gc-drawables.ts`, `frame-bench.ts` and `device.html?
harness=1` all still built a *second*, independent `TripleReader` over the exact same `drawList` SAB
the `Client`'s own `DrawListSlot` already owns, every time any of them passed the old `drawListSab`
option -- a live defect in production rendering, not a hypothetical one, regardless of whether
picking happened to be exercised on the same page yet. The gate caught this before it shipped.

**Final shape.** `createDrawablesRenderer(device, { colorFormat, drawListSlot?: DrawListSlot,
checkCompilation })` -- `drawListSab` is gone. `DrawablesRenderer.acquire()` no longer constructs or
calls a `TripleReader` at all: it reads whatever `drawListSlot.header`/`.body` currently reference
(a plain field read) and does the one `writeBuffer`, full stop. The caller is responsible for having
called `drawListSlot.acquire()` (directly, or through `Client.pick.acquire()`) earlier in the same
frame:
- `frame-bench.ts` needs no change beyond the option rename -- it already drives `createRealFrameLoop`,
  whose own `acquire` phase calls `client.pick.acquire()` before `onCamera`'s own
  `drawablesRenderer.acquire()` call.
- `gc-drawables.ts` (`drive()`, and the `__drawablesTest.acquire()`/`.acquireAndDraw()` test hooks)
  and `device.ts`'s `?harness=1` `driveOne()` each hand-roll their own per-frame loop (no
  `frame-loop.ts`): each now calls `client.pick.acquire()` once, immediately before
  `drawablesRenderer.acquire()`.

`grep -rn "new TripleReader" src` now shows exactly one production call site
(`render/drawlist-slot.ts`), plus `sab/triple.test.ts`'s own direct unit coverage of the primitive
itself -- **no remaining code path acquires the `drawList` SAB outside the `acquire` phase** (i.e.
outside a `DrawListSlot.acquire()` call, whether reached through `Client.pick.acquire()` or, in the
three hand-rolled pages above, directly).

New test: `drawlist.picker_matches_renderer_frame_seq` (`gc-drawables.spec.ts`) -- `pick.
matches_interpolated_frame_on_screen` (`pick.spec.ts`) never involves a real renderer, so it cannot
show that picking uses "the slot being drawn" in the sense that matters: the *actual* GPU upload.
This test drives a real `fx-drawables` client + real `DrawablesRenderer` through 20 real publishes;
after each one's single `client.pick.acquire()` + `drawablesRenderer.acquire()`, it asserts
`drawablesRenderer.frameSeq()` (what got uploaded) equals `clientTestHandle(client).drawListSlot.
frameSeq` (what the picker sees) -- every iteration, not just once. **Proven to fail**: a temporary
`FAULT_INJECT_SECOND_READER` reinstated a second `TripleReader` inside `render/drawables.ts`'s own
`acquire()` (over the same SAB, passed as a second, temporary `drawListSab` option alongside
`drawListSlot`), reproducing the exact bug this round fixed. Result: the two `frame_seq` values
diverged on the very first iteration -- renderer `302`, picker `0` (the reinstated reader stole every
fresh publish before the `DrawListSlot`'s own reader ever got one, starving it completely rather than
merely lagging it) -- confirming the test would have caught the original defect. Reverted immediately
after (`git diff` empty on `render/drawables.ts`/`gc-drawables.ts` before the real commit).

### `Client.pick` / `input/pick.ts` (`Picker`), exact shape

- `client.pick.acquire(): void` -- thin pass-through to `DrawListSlot.acquire()`. Called once per
  `tick()` by `frame-loop.ts`'s new first phase, `'acquire'` (`FRAME_PHASES` is now `['acquire',
  'camera', 'writeCamera', 'upload', 'render', 'overlay', 'ui']`), unconditionally -- every `Client`
  has a `drawList` SAB regardless of topology, so this never needs an opt-in hook the way
  `onCamera`/`onOverlay`/`onUi` do.
- `client.pick.at(cssX: number, cssY: number): number` -- internal (Seams: "used by the semantic
  layer"). Converts the point once via `camera/transform.ts`'s `screenToWorld` (continuous world
  tiles, not floored), subtracts the acquired slot's own `windowOriginX/Y`, and scans. Caches the
  last `(cssX, cssY, frameSeq)` it actually scanned; a repeated call at the same point against the
  same acquired slot returns the cached answer with no new scan -- this is what gives hover its "at
  most once per rAF, only when the pointer or slot changed" property (Planning decisions), and it
  lives inside the picker itself, not in `input/semantic.ts`'s own hover-emission gating (which
  already independently gates on tile change, unchanged from M11).
- `engine/test`: `pickAt(client, cssX, cssY): number` (`src/test/client.ts`, thin wrapper over
  `Client.pick.at`), `pickScanned(client): number` (cache-miss count).
- Containment (`scanDrawListForPick`, exported, the pure step-1 function unit-tested on hand-built
  headers/bodies): circle/ring/radial = `distance(pos, point) <= size.x / 2`; rect/bar/ghost/sprite =
  the axis-aligned box centred at `pos`, half-extents `size / 2` (confirmed against `uberquad.wgsl`'s
  own `vs_main`: every non-sprite kind's `pivot` is `(0.5, 0.5)`, i.e. `pos`-centred). `SCREEN_PX_
  STROKE` floors the effective radius/half-extents to `6 / pxPerTile(cameraState, viewport)` tiles.
  **Sprite pivot is not read** (Non-scope: "sprite pivot applied when M17b's table is loaded" needs a
  loaded `LoadedSpriteAtlas`/pivot table this cut has no dependency on) -- a sprite picks by the same
  centred box every other kind uses, not its own pivot offset. Whoever first needs sprite picking to
  respect a real pivot (no named owner in the brief) should thread the same pivot lookup
  `render/drawables.ts`'s own `vs_main`-equivalent uses into `createPicker`'s options.
- Front-to-back order: layers `7..0`, and within a layer, body-record index descending (the *last*
  submitted record in a layer wins, matching `encodeDraws`'s own ascending per-layer draw order --
  later instances paint over earlier ones at the same pixel). The scan reads `pick_id` first and
  skips a zero id or an `ANCHOR_CURSOR_TILE`-flagged record without reading `pos`/`size` at all.

### `pick_id` in events and ring records (`input/semantic.ts`)

`createSemanticRecognizer(inputRingSab, pick?: PickSource)` -- `PickSource = { at(cssX, cssY):
number }`, a narrowed structural type (not importing `Picker` itself, to avoid `input/` depending on
`render/drawlist-slot.ts` for a type-only reason). `emit`'s signature grew one parameter, `pickId:
number`, inserted right after `fracY` (before `button`); every one of its seven call sites computes
it at the point already in scope (`pickIdAt(slot.x, slot.y)` for the four `processSlot` branches and
`endDrag`; `pickIdAt(mouseSlot.x, mouseSlot.y)` / `pickIdAt(hover.x, hover.y)` for the two hover
branches) and passes it through to both `e.pickId` (`InputEventTs`) and `writeInputRecord`'s own
`pickId` field -- the same local variable feeds both, so they can never disagree. `input/record.ts`
itself needed **no change**: M11 already reserved `pick_id` at byte 24 of the 32-byte record and
always wrote `0` there; this cut is only the first to write something else.

### Client construction order (`src/client.ts`)

`cameraViewport` (the CSS-pixel `ResizeObserver`-backed viewport) moved earlier in `createClient`'s
own body, now built before `drawListSlot`/`picker`/`input` rather than after `cameraBundle` --
`Picker` needs `cameraState` + `cameraViewport` before `createSemanticRecognizer` can take it as a
constructor argument. No behavioural change, order only.

### `Client.overlay` / `overlay/anchors.ts` (`createOverlay`), exact shape

- `client.overlay.anchor(el, worldX, worldY, opts?: { align?: 'center' | 'top' | 'bottom' }):
  { set(x, y): void; remove(): void }` (0019 §5's own signature, matched exactly). `client.overlay.
  update(): void` is this cut's own addition (Deviations, not itself a pinned Seam name, mirroring
  `camera.tick`/`input.recognize`'s own precedent): a page's `onOverlay` hook (`frame-loop.ts`) calls
  it once per rAF; `frame-loop.ts` itself does **not** call it automatically (unlike the new
  `acquire` phase) -- `onOverlay` stays page-wired, the same shape `onCamera`/`onUi` already use,
  since not every page that builds a `Client` needs overlay writes every frame.
- **Lazy layer.** `ensureLayer()` builds the one anchor-layer `<div>` (and injects the shared static
  rule, once per `Document`, keyed by element id) only on the *first* `anchor()` call, not at
  `createClient` time. This was necessary, not just tidy: several existing real pages
  (`gc-drawables.ts`, `frame-bench.ts`, `?harness=1`) build a `canvas` that is **never appended to the
  document** (`canvas.parentElement === null`), and `ClientOptions.overlay.root` defaults to that
  parent -- eagerly building a layer in `createClient` would throw for every one of them even though
  none touches overlay. A page that never calls `client.overlay.anchor` pays nothing and needs no DOM
  parent at all.
- **The static rule, per `align`.** 0019 §5 gives one literal transform (`bottom`'s own
  `translate(-50%, -100%)`); this cut reads "one shared, static rule" as "one static rule *per align
  value*" (3 total: `bottom` the base `.engine-anchor` class, `center`/`top` via
  `[data-engine-align]`), selected by a class/attribute set once at `anchor()` time, never rewritten
  per frame -- still zero per-anchor `style.transform` writes, the actual property the ADR's
  "Alternatives rejected" line is about.
- **At-most-two-writes.** `update()` writes at most two properties on the *layer* element per call:
  `transform` (the origin tile's own current screen position, via `worldToScreen`) if it moved,
  `--z` (`pxPerTile`) if zoom changed. Per-anchor `--wx`/`--wy` are written only at `anchor()`
  creation, on `.set()`, and during a re-base -- never inside `update()`'s own per-frame path unless a
  re-base fires that frame.
  visibility (`visibility: hidden`/`visible`, a margin of 64 CSS px) is also checked every `update()`
  call but **written** only on an actual transition, per anchor.
- **Re-base.** `needsRebase(originScreenX, originScreenY)` (pure, unit-tested): true when either axis
  of the origin's own current screen position exceeds 50,000 CSS px. On a re-base, the origin snaps to
  `floor(cameraState.centreX/Y)` and every anchor's own `--wx`/`--wy` is rewritten
  (`rebaseOffset`, also pure/unit-tested) -- an O(N) burst, acceptable since rare by construction.
- **Not built (Non-scope, explicit in the delegation prompt):** `anchorSlot`, `mode: 'translate'`
  (accepted in `OverlayOptions`'s type, stored, never read past a `void` -- a later step swaps that
  for the real fallback), the header's anchor table (`128..640`) is untouched by this cut.
- `packages/engine/CLAUDE.md` gained the context artifact the brief names: "overlay code never reads
  layout... writes at most two style properties per frame on its one shared anchor-layer element."

### Browser tests: no GPU needed, hand-filled DrawList over the real SAB

`real-camera.html`/`src/real-camera.ts` (M11's own reused real-DOM page) gained both the picking and
overlay hooks, rather than a new page: picking needs only a real `Client` + the real `drawList` SAB
(no WASM extract, no renderer) -- `__rcPublishDrawList` builds one `TripleWriter` over
`clientTestHandle(client).sabs.drawList` (the *only* one this page ever builds, matching the "one
writer" production shape) and hand-fills a slot exactly the way `input/pick.test.ts`'s unit tests do,
at browser scale. **Found and fixed before commit:** a first draft's own `frame_seq` bump read-
modified-wrote the field on whichever physical slot `TripleWriter.backSlot()` currently was --
since `publish()` alternates the three physical slots, two consecutive publishes into two different,
previously-untouched slots each read a pristine `0` and wrote `1`, so `Picker.at`'s own
`(x, y, frameSeq)` cache saw no change across a real second publish and returned the *first* frame's
answer even after a fresh `acquire()` -- `pick.matches_interpolated_frame_on_screen` caught this
directly (`nowB` read `1`, expected `2`) on this cut's own first run. Fixed with a page-level
monotonic `nextFrameSeq` counter, independent of any slot's own bytes (matching what
`client/drawlist.rs`'s real `begin_frame` does natively).

Overlay tests needed no GPU either (DOM + camera math only); `overlay.rebase_beyond_50000px`'s first
draft compared the anchor's screen position *before* a pan-away-and-back sequence against its
position *after*, which is wrong on inspection (the camera itself ends at a different centre than it
started -- `(0,0)` vs `(5,5)` -- so the two measurements are of different screen positions by
construction, not a before/after of the same one). Fixed to assert the *final* position directly
against `worldToScreen`, the same invariant `overlay.anchor_tracks_world_point` already checks,
after two re-bases have fired along the way.

### Not run: `pnpm test browser -t ghost`, `-t anchors`, `pnpm test rust -t framecx`

No Rust was touched in steps 1-3 (`FrameCx`/`ClientSide::frame` are steps 4-6); no ghost or
`anchors=50` device-page work exists yet (steps 7-8). `docs/plan/device-checks.md`'s own M18 section
(already written, describing the *finished* milestone) is unchanged -- it names `device.html?
anchors=50`, `&anchorMode=translate` and the HUD's `pick_id` field, none of which steps 1-3 build;
left for whoever lands steps 7-8, per the brief's own line ("this milestone builds `device.html?
anchors=50` for it").

### Commit granularity: not perfectly self-buildable, by file ownership instead

Each of the three commits is scoped to the files its own Order-of-work step names, not to "checks out
and builds alone": `client.ts` (step 1's commit) already wires `picker`/`overlay` together since
`createClient` is one function; `real-camera.ts` (step 3's commit) carries both the picking hooks
`pick.spec.ts` needs and the overlay hooks `overlay.spec.ts` needs, since it is one page script. A
successor bisecting by commit should expect step 1/2's own trees to reference `overlay/anchors.ts`
(a step-3 file) without it existing yet; the final tree (after all three) is what was verified.

### Verified (commands and results)

- `pnpm test unit -t pick` -> `unit pass 5 tests` (this cut's own four: `pick.contains_per_kind`,
  `pick.front_to_back_order`, `pick.skips_zero_id_and_cursor_anchored`, `pick.min_stroke_pick_radius_
  constant`; plus the pre-existing `uberquad.vertex_layout_has_no_pick_id`, M17b, matched by the same
  `-t pick` substring).
- `pnpm test unit -t overlay` -> `unit pass 2 tests` (`overlay.rebase_math`, `overlay.align_offsets`).
- `pnpm test unit` (full) -> `unit pass 214 tests`.
- `pnpm test browser -t pick` -> `browser pass 3 tests` (`pick.tap_reports_entity_pick_id`,
  `pick.hover_once_per_raf_on_change`, `pick.matches_interpolated_frame_on_screen`), ~2.2s/35s.
- `pnpm test browser -t overlay` -> `browser pass 7 tests` (this cut's own six, plus the pre-existing
  `overlay_tile_reaches_screen`, M09, matched by the same `-t overlay` substring), ~2.7s/35s.
- `pnpm test browser -t "input"` -> `browser pass 11 tests` (the strict zero-GC page `input` and
  `semantic.spec.ts`'s own real-DOM tests, unchanged, hover picking now live on that same page's own
  code paths).
- `pnpm test browser -t "drawables"` -> `browser pass 9 tests` (the zero-GC page `drawables`,
  budget unaffected by the gate-round-1 rewiring: same underlying `TripleReader.acquire()` cost, now
  attributed to `client.pick.acquire()` instead of the renderer's own former internal call).
- `pnpm --filter engine typecheck` -> clean (all three `tsc` projects).
- `pnpm format` (Biome + `cargo fmt`) run after every edit; final tree clean.
- `pnpm test`/`pnpm lint` (the full runs) were not run (delegation prompt: "I am the gate").

### Gate round 1 (coordinator review): `render/drawables.ts` rewired, verified

Commit `afdd196`. Full re-run after the fix (all foreground, targeted):
- `pnpm test browser -t drawables` -> `browser pass 10 tests` (the nine above, plus the new
  `drawlist.picker_matches_renderer_frame_seq`).
- `pnpm test browser -t pick` -> `browser pass 4 tests` (the three from steps 1-3, plus
  `drawlist.picker_matches_renderer_frame_seq` again, matched by the same `-t pick` substring
  against `picker_matches`).
- `pnpm test browser -t overlay` -> `browser pass 7 tests` (unchanged).
- `pnpm test browser -t frame` -> `browser pass 9 tests`.
- `pnpm test browser -t device` -> `browser pass 2 tests`.
- `pnpm test unit` (full) -> `unit pass 214 tests` (unchanged: this round touched no unit-tested
  code). `pnpm --filter engine typecheck` -> clean.
- `grep -rn "new TripleReader" src` -> exactly `src/render/drawlist-slot.ts` (production) and
  `src/sab/triple.test.ts` (the primitive's own unit test). **No remaining code path acquires the
  DrawList SAB outside the `acquire` phase.**
- `bench.frame_worstcase` not re-run (coordinator: "not needed now, step 8").

### Notes for steps 4-8

- Header fields `follow_valid` (48), `follow` (56, f64x2), `anchor_mask` (76, u32x2), `anchors`
  (128..640, f32x2x64) are all still zero-initialised/untouched (M17's own state, unchanged by this
  cut) -- read them off the same `DrawListSlot.header` this cut built (`DataView`, little-endian).
  `flags` (52) is likewise still untouched and still has no named owner.
- `render/drawables.ts` already reads the acquired `DrawListSlot` (gate round 1, above) -- a later
  step wiring `device.html?anchors=50` needs no renderer change for this reason, only its own new
  work (picking + rendering already agree on one frame, proven by `drawlist.picker_matches_renderer_
  frame_seq`).
- `Picker`'s options (`createPicker(opts: { drawListSlot, cameraState, viewport })`) has no sprite-
  pivot parameter; adding one is additive (an optional field), not a rename.
- `client.overlay`'s public shape (`{ anchor, update }`) has no `anchorSlot` yet; add it as a third
  member, not a rename, and it can read the same `DrawListSlot.header`'s `anchors`/`anchor_mask`
  fields this cut already exposes.

## Deviations: steps 4-6 (`FrameCx`, `ClientSide::frame`, `cx.input()`, `DrawList::anchor`,
slot anchors, `follow`)

Commits `d8df6df` (step 4), `1f578a2` (step 5), `c988533` (step 6), base `3517bd2` (steps 1-3's own
final commit). Steps 7-8 (ghost flows, GC page `anchors`, `translate` mode, `device.html`) are a
later implementer's, built against the exact seam shapes below. **Attribution note:** the harness's
own git-commit-attribution reminder (`Co-Authored-By`/`Claude-Session` trailer) was not in this
session's context until after the step 4/5 commits already landed; step 6's commit also went out
without it before the gap was noticed. Not fixed by amending (forbidden: "never ... amend"); flagged
here for the orchestrator.

### `FrameCx<'a, G>` (`client/frame_cx.rs`, new file, fills M12's shell in `game.rs`)

`pub struct FrameCx<'a, G: Game> { view: &'a FrameView<'a, G>, camera: &'a CameraBlock, dt_ms: f32,
input: &'a [InputEvent], follow: Option<WorldPos>, ui_dirty: bool }`. Public accessors exactly as
Seams: `view()`, `camera()`, `dt_ms()`, `input()`, `follow(&mut self, Option<WorldPos>)`,
`ui_dirty(&mut self)`; two `pub(crate)` getters (`take_follow`, `took_ui_dirty`) let
`game_instance.rs` read the two write-only fields back after `ClientSide::frame` returns, without
exposing them to a game. `ClientSide::frame`'s own signature grew the lifetime `FrameCx<G>` never
had (`fn frame(&mut self, cx: &mut FrameCx<'_, G>, presence: &mut G::Presence)`, `client/texel.rs`)
-- the brief's own "this brief owns the shape" line for the previously-empty shell, not a change to
an already-fixed seam.

**`dt_ms()`'s source.** `ClientInstance` gained one `f64` field, `last_frame_time_ms` (`0.0` at
`init`); `game_instance.rs`'s `frame()` computes `((camera.frame_time_ms - last_frame_time_ms) as
f32).clamp(0.0, 100.0)` before doing anything else, then updates the field -- matching the Provides
line ("difference of successive `frame_time_ms`, clamped to `0..100`") literally. The first real
frame's own `dt_ms` is whatever `frame_time_ms - 0.0` clamps to (not specially zeroed): harmless,
since no test or production code reads `dt_ms()` before a second real frame establishes a real
delta.

**The scratch `G::Presence`.** `impl<G: Game> Instance for GameInstance<G> where G::Global: Default`
gained a second bound, `G::Presence: Default`, matching the existing precedent for `Global` rather
than widening the `Presence` trait's own supertraits (`pub trait Presence: Codec + Copy + 'static
{}` is untouched). `frame()` builds `let mut presence = G::Presence::default();` fresh each call (a
stack value, `Presence: Copy`) and passes `&mut presence` to `ClientSide::frame`, then never reads
it back -- exactly "a scratch `G::Presence` it then ignores" (Planning decisions). `()` (every
existing fixture's `Presence`) already satisfies `Default` trivially, so no fixture needed a change.

**`frame()`'s new order**, verbatim against the Scope line: build `FrameView` (unchanged) -> a
`FrameCx` borrows it, `camera`, and `input_queue.events()` for one block scope -> `client.frame(&mut
cx, &mut presence)` -> `cx.took_ui_dirty()` drives `ui.mark_dirty()` -> `cx.take_follow()` is read
out and the `FrameCx` block ends (dropping its borrows) -> `ui.maybe_run(...)` (unchanged position,
now *after* `frame` so a dirty flag `frame` just set is seen the same call, matching `ui_dirty()`'s
own doc comment) -> `extract` (unchanged) -> `sort_into(region, time_ms, follow)` -> `input_queue.
clear()`. The brief's own "-> publish -> clear InputQueue" collapses to "clear last": "publish" is
`worker/client-drawlist.ts`'s pump, which runs *after* this whole ABI call returns, outside
`GameInstance::frame` entirely -- `input_queue.clear()` being the literal last statement here is
what "after publish" means from inside this function.

### `InputEvent::code()`/`a()`/`b()`, `kind::GAME`, `InputQueue`'s "never dropped" policy

`client::input::kind::GAME = 7`; `InputEvent::code()`/`a()`/`b()` are thin aliases over
`pick_id`/`tile[0]`/`tile[1]` (Provides names them separately from the fields those already-named
accessors would suggest, since a `kind::GAME` record's meaning for those bytes differs from every
other kind's; the underlying storage is identical, so no wire change). "Never dropped ... with a
fixed 64" (delegation prompt): `InputQueue::push`'s overflow branch tries, in order, (1) evict the
oldest `hover`/`drag` (unchanged from M11), (2) **only if the incoming event is `kind::GAME`**, evict
the oldest event of *any other* kind (`drop_oldest_non_game`, new) -- so a game event always finds
room unless the queue is already 64 game events deep (a call-rate argument, not a hard guarantee:
`client.input.emit` is human/UI-gesture-rate, M33's construction mode; 64 in one un-drained frame is
not reachable by any real caller today). An *already-queued* `kind::GAME` event is never itself a
victim of either eviction path (path 1 only ever matches `hover`/`drag`; path 2 explicitly excludes
`kind::GAME`), so once enqueued it survives every later overflow regardless of what triggered it. No
existing test's own assertions changed to make this true: `queue_overflow_drops_hover_first` and
`queue_overflow_drops_incoming_when_nothing_droppable` pass unmodified (verified: neither test's own
incoming event is ever `kind::GAME`, so both take exactly their pre-existing branch).

### `DrawList::anchor`, header follow/anchor fields (`client/drawlist.rs`)

`DrawList` gained `anchor_mask: u64` and `anchors: [[f32; 2]; 64]`, cleared (`0`) / left as stale
bytes (never read while the corresponding mask bit is clear) respectively by `begin_frame`.
`anchor(&mut self, slot: u8, pos: WorldPos)`: out-of-range `slot` (`>= 64`) is silently ignored
(`push`'s own "drop, don't panic" precedent), in range sets the mask bit and `anchors[slot] =
self.relative_pos(pos)` -- the *same* tiles-relative-to-`window_origin` conversion `Draw::pos`
already uses, reused directly. `sort_into` grew a fourth parameter, `follow: Option<WorldPos>`
(every call site updated: 5 in `drawlist.rs`'s own tests, 1 in `game_instance.rs`, 1 in
`fixtures/drawables/tests/drawlist_golden.rs`) and now also writes: `follow_valid`/`follow` (`Some`
-> `1` + two `f64`s; `None` -> `0` + two `0.0`s, every call, so a stale target never survives a
frame where a game returned control) and `anchor_mask`/`anchors`. **Follow's unit and origin**:
absolute world tiles (`pos.x as f64 / 256.0`, `pos.y as f64 / 256.0`), *not* window-relative like
`Draw.pos`/`anchors` -- chosen because the main thread hands the decoded value straight to
`camera.setFollow(x, y, valid)`, itself in `CameraState.centreX/Y`'s own space (absolute world
tiles, matching `CameraBlock.centre`'s own convention already established by M06b). None of the four
new offsets (48, 56, 76, 128..640) fall inside `hash_region`'s `[4, 48)`/`[88, 92)` ranges, so the
`fixtures/drawables` DrawList golden does not move (confirmed: `drawlist_fixture_hash_golden` passes
unmodified, and it drives the *real* `GameInstance::frame` -> `sort_into` path end to end, not a
hand-called `sort_into` in isolation).

### `client.overlay.anchorSlot` (`overlay/anchors.ts`)

New `SlotAnchorRecord` list, parallel to (not merged with) the existing static `AnchorRecord` list:
`anchorSlot(el, slot)` re-parents `el` into the same lazily-built layer `anchor()` uses and pushes a
record with `hasValue: false` until the first `update()` call finds the slot's own `anchor_mask` bit
set. **Per-frame read**: `update()`'s own new tail loop calls `updateSlotAnchor(rec)` for every
registered slot anchor, which reads `deps.drawListSlot.header` directly via `DataView.getUint32`/
`getFloat32` at the mirrored `OFF_ANCHOR_MASK`(76)/`OFF_ANCHORS`(128) offsets -- **not** the "long-
lived `Float32Array`" 0019 §5's own prose names as the mechanism. Deviation, reasoned: `DataView`
reads are already zero-allocation (`.claude/rules/hot-paths.md` bans `subarray()`/new views per
frame, not `DataView.getFloat32` calls), and the acquired header's own backing view already changes
reference every `acquire()` (`DrawListSlot`'s own doc comment) -- a *second*, parallel set of 3
precomputed `Float32Array`s indexed by physical slot would duplicate that machinery for no measured
benefit. World position is `windowOriginX/Y + anchors[slot]` (undoing the same conversion `DrawList
::anchor` applied), then the *same* `rebaseOffset`/`writeAnchorVars`-shaped write `anchor()`/`.set()`
already use. **"Frozen, not hidden"**: an unset mask bit is not itself a signal to hide (0019 §5 says
nothing about a slot's absence meaning "hide"; it only defines the viewport-margin visibility rule,
which slot anchors also participate in, `updateVisibility`'s own second loop, once `hasValue` is
`true`) -- `overlay.slot_anchor_follows_rust`'s own third assertion pins this reading. `rebase()`
also force-rewrites every slot anchor with `hasValue: true` (using its own last known world
position), the same "every anchor rewritten on re-base" rule static anchors already follow.
`OverlayDeps` gained a required `drawListSlot: DrawListSlot` field (`client.ts`'s only caller updated
to pass its own single instance).

### `follow` (camera.ts, client.ts)

`CameraIntegrator.setFollow` was already a no-op store (steps 1-3); `integrate()` now reads `follow.
valid` once, at a single point *after* every pan-shaped effect this frame has already run (gesture,
pointer drag, WASD, inertia, `moveTo`, `clampToBounds`) and, if set, overwrites `state.centreX/Y`
with `follow.x/y` and zeroes `state.velocityX/Y`. Deviation from a branch-per-function design
(rejected): one override point after everything else is simpler, provably equivalent (every pan
effect only ever reaches the camera through `centreX/Y`, so discarding those two fields discards
every pan effect regardless of source), and needs no new parameter threaded through `applyGesture`/
`applyPointers`/`applyWasd`/`applyWheelEasing`/`applyMoveTo`. Placed *after* `clampToBounds` so a
follow target is authoritative even outside the camera's own pan bounds. `client.ts`'s `camera.
tick(dtMs)` reads `drawListSlot.followValid/X/Y` (three new reused fields on `DrawListSlot`,
populated at `acquire()` time the same way `recordCount`/`dropped`/etc. already are) and calls
`cameraIntegrator.setFollow(...)` as its first statement, before `integrate()` -- since the `acquire`
phase already ran earlier in the same `tick()` (`frame-loop.ts`'s `FRAME_PHASES`), a target the Rust
side published reaches `integrate()` in the same rAF that draws the slot carrying it, matching 0019
§1 literally. Device-pixel-at-rest snapping (0018 §3, unchanged code) can still fire after the
override on a frame with no pointer active, rounding the follow target to the nearest device pixel
-- a real, correct interaction between two independent rules, not a bug (`follow.spec.ts`'s own
precision-1 tolerance on those specific assertions, precision-5 on the one assertion taken while a
pointer is still down and `atRest` is provably `false`).

### `fixtures/overlay` (`fx-overlay`) and `framecx.html`

Minimal by design (module doc comment in `lib.rs`): `genesis` spawns no entities, `extract` is the
still-default no-op. `OverlayClient::frame` records the last `cx.input()` event's raw `kind`/
`pick_id`/`tile` into `Cell`s and calls `cx.ui_dirty()` whenever one arrived (the *only* way this
fixture's `Ui` ever changes, since `apply`/`tick` never mutate the replica -- a real, not merely
convenient, use of the dirty flag, 0024 §7d). `OverlayUi` is hand-mirrored in `framecx.ts` rather
than generated (`fx-overlay` is not in `scripts/build-fixtures.mjs`'s `BINDINGS_FIXTURES` set: five
plain numeric fields are cheaper to keep in sync by hand than a new bindings-export step). `framecx.
html`'s own `createClient` uses an unconnected `host: { kind: 'remote', ... }` (`real-camera.ts`'s
own precedent: the client role's WASM instance runs with no host link at all) but, unlike `real-
camera.ts`'s `terrain` fixture (a hand-written pre-`GameInstance` `Instance` impl that tolerates no
config), needs `options.test.game = { seed: '0x1', params: null }` explicitly -- `fx-overlay` goes
through `engine::export_game!`'s real `TerrainConfig::deserialize`, which a `null` config (what a
`'remote'` host with no `test.game` override otherwise sends) fails as `BadConfig` (found running
this cut's own first draft: `{"ok":false,"code":"worker-fatal","message":"engine_init failed:
BadConfig"}`).

**One-wake input latency: a real production defect, fixed (gate round 1).** The first draft left
`worker/client.ts`'s `body()` calling `frame()` *before* `inputPump.pump()` drained that same wake's
own new `inputRing` records into `InputQueue`, so an event written before a `stepFrame` call was only
visible to the *next* real `frame()` call's own `cx.input()` -- on every real page, not only in
tests, since `body()` is shared client-role infrastructure. Before this milestone nothing in Rust
read input inside `frame` at all, so the two pumps' relative order never mattered; `FrameCx::input()`
is what makes it matter, so it is this milestone's to fix, not a pre-existing characteristic to
document around. **Fixed**: `inputPump.pump()` now runs first in `body()`, before the `CB_FRAME_REQ`
check that gates `frame()` -- unconditionally safe to move (`inputPump` only touches `inputRing` and
the `Rx` region transiently; nothing later in `body()` reads `Rx` before `actionPump` overwrites it
for its own, unrelated purpose; single-threaded, sequential, no concurrent readers). Checked the
other two pumps and the clear-timing question the coordinator asked about: `netPump`/`uploadPump`
neither read nor write `inputRing`/`InputQueue`, so their own relative order (unchanged, both still
after `frame()`) is untouched by this; `InputQueue::clear()` still runs at the very end of
`GameInstance::frame()` (steps 4-6's own placement, unchanged here), so a record drained this wake is
read by this wake's `frame()` before being cleared, and a record arriving *after* this wake's own
`inputPump.pump()` call correctly waits for the next wake's own drain -- neither "cleared unread" nor
"read early" is possible with the new order. Both `framecx.*` tests now assert visibility after
**one** `stepFrame` (`stepFrameTwice` removed). Inject-fail-revert (restored the old order, a fresh
build, foreground `pnpm test browser -t framecx`):
```
FAIL browser [chromium] framecx.tap_visible_in_frame
  Error: tap timed out; debug={"ringStats":{"drops":0,"pushed":1,"popped":1},"uiDrainStats":{"recordsSeen":0,"onUi":0}}
FAIL browser [chromium] framecx.emit_visible_in_frame
  Error: emit timed out; debug={"ringStats":{"drops":0,"pushed":1,"popped":1},"uiDrainStats":{"recordsSeen":0,"onUi":0}}
```
Both fail with the ring itself drained (`popped: 1`) but the UI pipeline never even started
(`recordsSeen: 0`) -- exactly "decoded into the queue, then cleared by this same wake's `frame()`
before the *next* wake's `cx.input()` ever sees it," the old defect. Reverted immediately after
(`git diff packages/engine/src/worker/client.ts` empty before the real commit).

**A second, discovered consequence: `fixtures/terrain`'s own `frame()`.** `worker/client.ts`'s
`body()` is shared by every client-role page, including the low-level, hand-written (pre-
`GameInstance<G>`) `fixtures/terrain`, whose own `frame()` unconditionally called `input_queue.
clear()` every call (the original M11 "cleared each frame" contract, harmless when nothing read the
queue near `frame()` at all). With the reorder, that fixture's own `frame()` now ran *after* the
same wake's drain and erased it immediately -- `semantic.spec.ts`'s pre-existing `input: events reach
wasm` test (whose own `__semReadInputStats` reads the queue via a *separate*, later `on_input(0)`
call, `test-call`-parked, not from inside `frame()`) regressed: `queueLen` expected `2`, got `0`.
Found running the full browser suite after the reorder, not by inspection. This fixture never reads
`cx.input()` (it predates `FrameCx` entirely, Non-scope of this milestone) and nothing else in the
repo depends on its per-frame clear (`grep` for `queueLen`/`__semReadInputStats`/`__semStepFrame`:
`semantic.spec.ts` and its own page script only) -- the clear served "prove the contract", never a
real consumer, so it is removed rather than reordered around a consumer that does not exist
(`fixtures/terrain/src/lib.rs`, the `input_queue: _` binding, `frame()`). `semantic.spec.ts` itself
is unmodified: the fix restores its existing, unweakened assertion (`queueLen === 2`), it does not
relax it. Verified: `pnpm test browser -t "events reach wasm"` -> `pass 1`; `-t semantic` -> `pass
6`; `-t terrain` -> `pass 31`; full `pnpm test browser` -> `pass 159` (all foreground, after the
fix).

**`client.onUi`'s own independent poll: gate round 2 found the real cause, in the test, not
production.** Round 1's own diagnosis ("resultsFrame's real-rAF cadence occasionally landing late")
was wrong -- it explained a `recordsSeen: 1, onUi: 1` timeout as "slow but complete," but never
asked why `onUi: 1` (the callback fired once) and `window.__lastUi?.().count` *still* never became
true. Round 2 instrumented for real: `fx-overlay` gained a temporary `dbg_stats()` export (packed
`frame_calls`/`last_input_len`/`last_ui_dirty`/`last_count_after`, reached via `callParked`) plus
`test/client.ts`'s existing `uiObserverStats()` (`UiObserver::calls`/`records`), snapshotted at four
points in each test. A caught failure's own trace, `framecx.tap_visible_in_frame`:
```
DBG tap baseline        {"frameCalls":0,"lastInputLen":0,"lastUiDirty":0,"lastCountAfter":0,"uiCalls":0,"uiRecords":0}
DBG tap after inject     {"frameCalls":0,"lastInputLen":0,"lastUiDirty":0,"lastCountAfter":0,"uiCalls":0,"uiRecords":0}
DBG tap after stepFrame  {"frameCalls":1,"lastInputLen":1,"lastUiDirty":1,"lastCountAfter":1,"uiCalls":1,"uiRecords":1}
DBG tap after timeout    {"frameCalls":1,"lastInputLen":1,"lastUiDirty":1,"lastCountAfter":1,"uiCalls":1,"uiRecords":1}
```
`frameCalls: 1` (never more than one, ruling out the coordinator's own "a wake the worker runs on
its own" hypothesis outright: no incidental `frame()` call ever ran before `stepFrame`, in this or
any other caught trace). `lastInputLen: 1`, `lastUiDirty: 1`, `lastCountAfter: 1`, `uiCalls: 1`,
`uiRecords: 1` -- the whole Rust/WASM pipeline is provably correct on every single run, including
failing ones: one `frame()` call, input seen, `ui_dirty` set, `ui.maybe_run` ran once and wrote one
record with the right `count`. The bug is entirely on the main thread, in this test's own code, not
`game_instance.rs`, not `worker/client.ts`, not `client.ts`'s `resultsFrame`.

**The actual cause**: `test/client.ts`'s `lastUi()` subscribes to `client.onUi` *lazily, on its own
first call* -- its own doc comment already says so: "a call made after a value already arrived and
was coalesced away still sees every value from that point on" (i.e. **not** one delivered *before*
the first call; `onUi` delivery is coalesced-to-newest with no replay for a late subscriber, `client.
ts`'s own documented contract). `framecx.spec.ts` never called `window.__lastUi?.()` until
`waitForUi`'s own first poll -- which runs *after* `stepFrame`, the state-changing call. `resultsFrame
()`'s independent real-rAF poll can fire in the narrow window between `stepFrame` returning and
`waitForFunction`'s first poll actually subscribing; when it does, it drains and decodes this page's
one-and-only UI record (bumping `uiDrainStats().onUi` -- that counter increments unconditionally,
once per record *decoded*, regardless of whether any listener is subscribed yet) with zero listeners
attached, and the record is gone for good -- nothing else ever changes this fixture's `Ui` again.
`puts-ui.spec.ts` already documents the identical gotcha for the identical helper ("Subscribes
`lastUi` *before* the change that follows... a listener registered late simply never sees it, the
same shape `onActionResult` already has") and works around it the same way this fix now does.
**Fixed** in `framecx.spec.ts` alone (test code; not `client.ts`, not `game_instance.rs`, not `worker
/client.ts` -- production's `onUi` contract is already correct and already documented, and every
other existing caller subscribes early): `createReady` now calls `window.__lastUi?.()` once, right
after the page is ready and *before* any input exists, so the subscription is always in place before
`stepFrame` can possibly produce the one UI change this page ever makes. `waitForUi`'s timeout is
back to an ordinary `5000`ms (`polling: 'raf'`, the default, restored) and `test.setTimeout(45000)`
is removed -- nothing needs to be masked once the record can no longer be lost. Verified: 20/20
clean, foreground, isolated (`pnpm test browser -t framecx` x20, each `pass 2 tests 1.9s/35s` --
down from the worst case's `22s/35s` per failure); full `pnpm test browser` -> `pass 159 tests
22s/35s`. All temporary instrumentation (`fx-overlay`'s `dbg_stats()`/`DBG_*` thread-locals,
`framecx.ts`'s `__debug`/`__dbgSnapshot`, `framecx.spec.ts`'s `dbg()` helper and its call sites)
removed before this commit; `git diff` against gate round 1's own commit confirms `fixtures/overlay/
src/lib.rs` is now byte-identical to it.

**"Allocates nothing" (Tests added: `framecx.emit_visible_in_frame`) is not asserted anywhere.**
`client.input.emit`'s implementation is zero-alloc by the same construction as the pre-existing
`emit()` it sits beside in `input/semantic.ts` (identical `ring.tryClaim`/`slotView`/`commit` shape,
`writeInputRecord`'s own allocation-free encode) -- but no test measures it, in this cut or any
existing zero-GC page (`grep` for `.input.emit` under `tests/browser/pages/src/gc-*.ts`: zero
matches). The natural home is step 8's own `anchors` GC page (the brief's Budgets section already
commits that page to a `50 + 4 anchors` allocation line); a `client.input.emit` call folded into that
page's own measured scenario, or a dedicated assertion there, is that step's to add, not claimed
here.

### Live in production vs. test-only

Live on every real page (not only in tests): `FrameCx`/`ClientSide::frame`'s new call, `cx.input()`,
`worker/client.ts`'s `inputPump.pump()`-before-`frame()` order (gate round 1), `InputQueue`'s
never-dropped `kind::GAME` policy, `client.input.emit`, `DrawList::anchor`'s header writes (even
when a game never calls it -- the mask is always written, all-zero), `client.overlay.anchorSlot`,
`follow`'s camera-centring in `integrate()`, and `camera.tick()`'s own header read (unconditional,
every rAF, zero-cost when `follow_valid` is `0`). Test-only: `fx-overlay` itself, `fixtures/terrain`'s
own removed `input_queue.clear()` call is a real production-fixture change but the fixture itself is
test support, not a shipped page; `framecx.html`'s `__stepFrame`/`__injectRawInput`/`__emit`/
`__lastUi` hooks, `real-camera.ts`'s `opts.follow`/`opts.anchors` header hand-fill and its
`__rcOverlayAnchorSlot*` hooks.

### Verified (commands and results)

- `pnpm test rust -t framecx` -> `rust pass 4 tests` (`framecx_input_slice_order_and_clear`,
  `framecx_follow_defaults_to_none_and_records_a_set_target`, `framecx_follow_written_to_header`,
  `framecx_ui_dirty_reruns_ui`).
- `cargo nextest run --workspace --features testing` -> `333 tests run: 333 passed` (includes the
  above plus `game_record_round_trip`, `game_record_survives_overflow`, `drawlist_anchor_table_and_
  mask`, `drawlist_anchor_out_of_range_slot_ignored`, and `fx-overlay`'s own `export_bindings_*`
  golden checks for `Action`/`Reject`/`OverlayUi`).
- `cargo clippy --workspace --all-targets --features engine/testing -- -D warnings` -> clean.
- `pnpm test unit -t pick` -> `unit pass 5 tests`; `-t overlay` -> `unit pass 2 tests`; full `pnpm
  test unit` -> `unit pass 214 tests` (all three unchanged from steps 1-3's own numbers: this cut
  touched no unit-tested TS code path).
- `pnpm test wasm` -> `wasm pass 52 tests`; `-t "abi registry"` -> `wasm pass 9 tests` (`ABI_VERSION`
  unchanged at 15: no new export).
- `pnpm test browser` (full) -> `browser pass 159 tests` (`22s/35s`, gate round 2's fix: down from
  a worst case of one `framecx.*` timeout alone costing `22s` of the `35s` budget before the fix).
- Gate round 2: `pnpm test browser -t framecx` x20, foreground, isolated, one at a time -> `20/20`
  clean, each `pass 2 tests 1.9s/35s`.
- `pnpm test browser -t pick` -> `4`; `-t overlay` -> `8`; `-t framecx` -> `2`; `-t follow` -> `4`
  (`follow.centres_in_same_frame_pan_ignored_zoom_works` plus three pre-existing matches of the same
  substring: `draw.ghost_follows_cursor_same_frame`, `dom_counter_follows_global`, `overlay.
  slot_anchor_follows_rust`); `-t drawables` -> `10`; `-t input` -> `11`; `-t ghost` -> `1`
  (pre-existing, M17's `draw-readback.spec.ts`, matched by substring only -- no cursor-anchored ghost
  exists yet, step 7's own); `-t anchors` -> `0` (device page is step 8's).
- Source scan (`grep -rn "getBoundingClientRect|offsetWidth|offsetHeight|getClientRects|offsetTop|
  offsetLeft" src/overlay src/input`): zero matches outside comments.
- `pnpm format` run after every edit; final tree clean.
- Inject-fail-revert, one per new browser test (all reverted immediately after, `git diff` confirmed
  clean before the real commit):
  - `overlay.slot_anchor_follows_rust`: `anchorMaskBit` forced to always return `false` ->
    `updateSlotAnchor` never writes `--wx/--wy` for any slot -> failed on the first position
    assertion (`expected 266.67, received 200`, the CSS-px equivalent of "never moved off its
    default"). Covers `overlay/anchors.ts`'s own mask-bit-gated write branch.
  - `framecx.tap_visible_in_frame` / `framecx.emit_visible_in_frame`, **the UI-rerun path**:
    `fx-overlay`'s own `cx.ui_dirty()` call commented out -> both timed out waiting for `count > 0`
    (`ui.maybe_run` never reruns with no replica mutation on this fixture's own path). Covers
    `FrameCx::ui_dirty()`'s own write-then-read round trip through `game_instance.rs`. (Round 1
    gate: this alone proves the rerun path, not delivery -- see the next two.)
  - `framecx.tap_visible_in_frame`, **delivery**: `FrameCx::input()` forced to always return `&[]`
    -> `OverlayClient::frame` never sees the tap, never calls `cx.ui_dirty()` -> timed out, `debug=
    {"ringStats":{"drops":0,"pushed":1,"popped":1},"uiDrainStats":{"recordsSeen":0,"onUi":0}}` (the
    ring itself still drains; nothing downstream of `cx.input()` ever ran). Covers `FrameCx::input()`'s
    own return path.
  - `framecx.emit_visible_in_frame`, **delivery**: `InputQueue::push` made to silently drop every
    `kind::GAME` record -> timed out, `debug={"ringStats":{"drops":0,"pushed":1,"popped":1},
    "uiDrainStats":{"recordsSeen":0,"onUi":0}}` (same signature: ring drained, nothing reaches `Ui`).
    Covers `InputQueue::push`'s own kind-7 acceptance path. Also confirmed (not a new fault, an
    existing-assertion check): both tests already assert the exact `pick_id`/`code`/`a`/`b` values
    they received (`ui?.last_pick_id`, `last_tile_x`, `last_tile_y`), not only `count > 0` --
    `framecx.tap_visible_in_frame` additionally asserts `last_kind`/`last_pick_id: 77`/`last_tile_x:
    5`/`last_tile_y: -2`; a wrong-but-nonzero delivery would fail these even if `count` alone would
    not have caught it.
  - `follow.centres_in_same_frame_pan_ignored_zoom_works`: `camera.ts`'s own follow-override block
    gated behind `if (false && follow.valid)` -> failed the first centring assertion (`expected 7,
    received 0`, the un-overridden pre-drag default). Covers `integrate()`'s own follow-override
    branch.
  - `framecx.tap_visible_in_frame`, **the `lastUi()` early-subscription fix (gate round 2)**: reverted
    `createReady`'s own early `window.__lastUi?.()` call (subscribing only on `waitForUi`'s first
    poll, as before round 2) -> reproduces the original failure signature intermittently (this is a
    timing race, not a deterministic branch -- not re-verified with a fresh forced failure beyond the
    original catch, since there is no code path left to gate behind a boolean; the fix is removing a
    race window, confirmed instead by the 20/20 clean run above and the trace in `Deviations` showing
    the pre-fix mechanism precisely).
- `pnpm test`/`pnpm lint` (the full runs) not run (delegation prompt: "I am the gate"). All commands
  above run in the foreground (coordinator instruction, gate rounds 1-2); none backgrounded.
- Not run (steps 7-8, later implementer's): `pnpm test browser -t "\btranslate\b"`, any GC/budgets
  command, `pnpm bench:frame`.

## Deviations: steps 7-8 (ghost flows, GC page `anchors`, `translate` mode, `device.html`)

Commits `945bc78` (step 7), `85e4474`, `d643882`, `d66666b`, `47f7f91` (step 8), base `c988533`
(step 6's own final commit). "I am the gate" (delegation prompt): `pnpm test`/`pnpm lint` full runs
not run; every command below is a targeted foreground run.

### `fixtures/overlay/src/lib.rs`'s `extract()` (new; steps 4-6 left it the default no-op)

Draws three unconditional groups every frame, shared by every page that loads this fixture
(`framecx.html` never inspects the DrawList, so this is free there): `RING_COUNT = 50` pickable
rings on a fixed grid (`RING_COLS = 10`, `RING_ROWS = 5`, `RING_SPACING_TILES = 3`, tile-centred:
`tx = (col - 5) * 3`, `ty = (row - 2) * 3`, `pos = (tx + 0.5, ty + 0.5)` tiles, `pick_id = i + 1`,
`size = [1.2, 1.2]` tiles i.e. pick radius `0.6` tiles); `ANCHOR_SLOT_COUNT = 4` circles orbiting the
origin at `ANCHOR_ORBIT_RADIUS_TILES = 6.0`, one full orbit every 8 s (`view.time_ms() * TAU /
8000.0`, `#[allow(clippy::disallowed_methods)]` on the two `sin`/`cos` calls: client-side draw
position only, never replicated/hashed, 0003 "Outside the deterministic core" -- `.claude/rules/
determinism.md`'s transcendentals ban is for the sim/worldgen/apply core), each also published
through `out.anchor(slot, pos)`; a cursor-anchored ghost (`out.ghost(2, WorldPos::from_tile(view.
window_origin()), [1.0, 1.0], color).flags |= ANCHOR_CURSOR_TILE`, only while `view.cursor_tile()`
is `Some`) -- `pos` is always the origin tile itself (`relative_pos` of `window_origin` is exactly
`(0, 0)`), since the *shader* places the instance at the live `cursor_tile` via the flag, not this
record's own `pos`.

### `input/semantic.ts`: touch tap now sets the cursor tile

0019 §4's "touch: tile of the last tap" was never built in steps 1-6 (only mouse hover ever wrote
`cameraState.cursorTileX/Y/cursorValid`) -- found because `ghost.touch_tap_then_confirm` needs it.
Fixed in the one `emit('tap', ...)` call site (`wasActive[i] === 1` branch, `input/semantic.ts`):
`cameraState.cursorTileX/Y/cursorValid` are set from the same `tileScratch` the emitted event uses,
for every pointer kind (a mouse tap re-affirms what hover already published, so no behaviour change
on that path). Inject-fail-revert: removing these three lines reproduces `cursor: {x:0,y:0,
valid:false}` after a real touch tap (`ghost.touch_tap_then_confirm`'s own second assertion) --
covers this exact branch.

### `ghost.html`/`ghost.ts` (new): real connected `fx-overlay`, not `framecx.ts`'s unconnected shape

`host: { kind: 'local', world: { worldId: 'ghost-test', params: { seed: '1', worldgen: null } },
connect: true }`, `genWorkers: 1`, `test: { clock: createManualClock(), flags: {} }`,
`pumpUntilLive(client)` (not a bare `await client.ready`) -- needed because `ghost.
touch_tap_then_confirm` calls `client.dispatch(null)` for real, which throws unless `session_state
=== Live` (`client.ts`'s own `dispatch`), and only a real net-pump round trip over a real sim
connection ever sets that. `client.overlay.anchor`'s `worldX`/`worldY` grew no new option for this:
the confirm button is plain page code (Planning decisions: "`FrameCx` has no `dispatch`").
Hooks (all `__ghost`-prefixed after a rename, next paragraph): `__ghostInjectPointer`,
`__ghostInjectHover` (`input/pointers.ts`'s own `recordMouseHover`, exported for the first time to
a test page here -- genuine idle-mouse hover, unlike a held-and-moved pointer which the camera also
reads as a pan gesture), `__ghostDriveFrame(dtMs)` (`client.pick.acquire()` then `client.camera.
tick(dtMs)` then `stepFrame(client, dtMs)` then `client.overlay.update()`), `__ghostCursorTile`,
`__ghostRecord` (the newest `KIND_GHOST` record via `drawListRecords`, or `undefined`),
`__ghostLastTap`, `__ghostConfirmVisible`, `__ghostLastDispatchSeq`. **Found and fixed before
commit**: the page's first draft used the plain names (`__injectPointer` etc.), which collided at
the TypeScript `declare global` level with `camera.spec.ts`'s own same-named globals (a *different*
page, `real-camera.html`, with an incompatible parameter list) -- `pnpm --filter engine typecheck`
caught it (TS2717); every ghost hook renamed `__ghost*`.

### `overlay/anchors.ts`: `mode: 'translate'` (the Non-scope line steps 1-3 explicitly deferred)

No floating origin, no re-base: `applyTranslateAnchor` calls `worldToScreen` directly (full
float64), computing each anchor's own screen position fresh, writing `el.style.transform` only when
that position actually changed since the last write (`rec.lastTX/lastTY`, `NaN` initially) and
`el.style.visibility` only on a transition -- the same "idle writes nothing" / "one write per
visible anchor per moving frame" shape `'properties'` mode has, at a per-anchor cost instead of a
per-layer one (0019's own "N strings and N style writes per frame" downside). `client.overlay.
anchor`'s `.set()` and `anchorSlot`'s per-frame refresh both branch on `mode` (`refreshSlotAnchorValue`
split out of the old `updateSlotAnchor`, so `'properties'` mode's own behaviour -- byte-for-byte,
all 8 pre-existing `overlay.*` tests unchanged -- shares the read path with the new mode without
duplicating the header-decode). `real-camera.ts`'s `__rcCreate` grew `opts.overlayMode`, threaded
into `ClientOptions.overlay.mode`, for `overlay.translate_mode_equivalent` alone.

### GC page `anchors`: real defect found, and the Planning decisions' own `+16 B` margin re-derived

`gc-anchors.ts`: unconnected (`host: 'remote'`, `test.game = { seed: '0x1', params: null }` --
`'0x1'`, not `'1'`: `TerrainConfig::seed` is `HexU64`, found via a `BadConfig` page error on the
first run), `genWorkers: 1`, real terrain+drawables rendering (`gc-drawables.ts`'s own shape) over
`fx-overlay`; 50 `client.overlay.anchor` + 4 `client.overlay.anchorSlot` mounted once at setup
(never rebuilt inside `drive()`); a triangle-wave zoom (`tilesAcross` 20↔28↔20 every 120 frames) on
top of the existing `gc-drawables.ts`-style pan; one `client.input.emit(3, ..., ...)` call per
`drive()` frame.

**Real defect, found by folding `client.input.emit` into a measured window for the first time**
(step 4-6 Deviations flagged this as undone): `input/semantic.ts`'s `emit`/`emitGame` each passed
`writeInputRecord` a fresh object literal per call, not the preallocated-scratch shape `.claude/
rules/hot-paths.md` requires (`writeInputRecord`'s own doc comment already says "pure, allocation-
free" -- only its callers were not). Fixed with one shared `InputRecordFields` scratch
(`recordScratch`, mutated in place); saved ~56 B/frame on `gc-anchors`' own clean measurement (554.7
-> 498.7 B/frame, 3 consecutive runs each direction). Inject-fail-revert: reverting to inline
object literals in `emitGame` alone reproduces `anchors clean` failing at 554.71 B/frame against the
final 508 B/frame budget -- covers `emitGame`'s own write path.

**Budget, and where the brief's own `+16 B` estimate broke down**: `bytesPerFrame.main` measured
498.29-499.14 B/frame across 50 clean `pnpm gc reliability`-shaped runs. A first pass followed the
brief literally (`ceil(499.14) + 16 = 516`), but `anchors neg object main` (the fixed 16 B/frame
`allocateObject` control) then measured a stable **514.43-514.49 B/frame** against that budget (3
consecutive runs) -- *never* tripping: a 16 B margin cancels the object control's own 16 B delta
almost exactly on this page's noisier baseline (the control is sized against the *standard* `0016
§1` `+8 B` margin, `src/test/controls.ts`'s own doc comment: "a budget is `ceil(clean) + 8 B`, so a
`clean + 16` reading beats it by 7-8 B/frame"). Re-derived using that ordinary formula instead:
`ceil(499.14) + 8 = 508`. Verified: clean (499.14 max) < 508 < object (514.43 min), an 8.86 B/6.43 B
split either side, the same shape every other page's own formula in `budgets.json` uses. Full
formula strings and all four negative-control numbers: `budgets.json`'s own `gc.pages.anchors`
entry. Software row (`GC_MODE=software`, `attributionRoots: ["drive"]`): 475.39-475.81 B/frame
across 20 runs, `ceil(475.81) + 8 = 484` (the ordinary margin here too -- no separation problem
found in software mode). `client`/`gen0`: the shared `8` B/frame figure, measured 0.81 B/frame,
unchanged from every other page. `input`/`drawables` pages: unaffected (their own budgets untouched,
both still green after the `emit` fix -- the fix only *lowers* their already-passing numbers).

### `device.html?anchors=N[&anchorMode=translate]` (new mode) and `frame-loop.ts`

`createRealFrameLoop`/`RealFrameLoopOptions` gained `onOverlay` (forwarded straight to
`createFrameLoop`, matching the existing `onCamera`/`onPhase` shape) -- nothing forwarded it before
this cut, since no real page had needed `client.overlay.update()` wired to a real rAF loop yet.

`runAnchorsCheck` (`device.ts`) is a *separate* function from `runFillRateHud`, not a flag layered
onto it: a real, connected `fx-overlay` client (`host: 'remote'`, `test.game = { seed: '0x1', params:
null }`), not `fx-terrain` -- `device-checks.md`'s own pre-written M18 section assumed `&anchors=50`
composed with `runFillRateHud`'s own `&autopan`/`&tiles`/`&scale` scene, which is not buildable (one
WASM game per page); the section is rewritten to describe this instead. Mounts one small (`14x14px`)
DOM button per Rust-drawn ring, anchored to the exact grid `fixtures/overlay/src/lib.rs`'s own
`extract()` uses (`ringWorld(pickId)`, exported as `window.__anchorsRingWorld` for a spec), and one
marker per slot anchor. HUD gained `pick_id` (the last canvas tap's `pick_id`, `-` on a miss) plus
`runFillRateHud`'s own rAF-interval/GPU-latency fields (`RollingStat`/`percentile` hoisted to module
scope so both modes share one implementation, rather than a second copy).

**A real, pre-M18 production defect, found building the `anchors` browser test and fixed at the
coordinator's own gate round 1** (not a test quirk, not worked around by slowing the test down): a
synthetic `page.mouse.click(x, y)` dispatches a real `pointerdown`+`pointerup` pair at the *same*
coordinates under 1 ms apart -- confirmed with a temporary `canvas.addEventListener` probe
(`{"t":"pointerdown",...,"ts":1378.955}`, `{"t":"pointerup",...,"ts":1378.995}`, a 0.04 ms gap) --
and `input/semantic.ts`'s recognizer only samples `PointerSlots.active` once per rAF (its own doc
comment: "Runs once per rAF"), so a down-then-up inside one JS task, before the frame loop's next
real `requestAnimationFrame` callback, was never observed as a state *transition* at all:
`wasActive[i]` stayed `0` through both events, and the "just released" tap branch (which requires
`wasActive[i] === 1`) never ran. This is not specific to Playwright's synthetic events: `recordPointer
Up` (`input/pointers.ts`) sets `slot.active = false` the instant a real `pointerup` fires, and the
recognizer's own once-per-rAF sampling of `PointerSlots.active` (M11's own design, `input/pointers.ts`
+ `input/semantic.ts`, unchanged since) is exactly as blind to a **real** press-and-release that both
land inside one ~16ms rAF gap -- a macOS trackpad tap-to-click and a fast phone tap both routinely do.
M18's own exit criterion ("a click on a ring sets `pick_id`") and M20b's collect button both depend on
this path, so masking it behind a slowed-down test (the first draft's own `tap()` helper, a real
50 ms gap forced between down and up) would have shipped the defect. **Fixed** in `input/pointers.ts`/
`input/semantic.ts` instead (gate round 1, coordinator ruling): `PointerSlot` gained a `quickTap`
latch (`quickDownX/Y/TMs`, `quickUpX/Y/TMs`, `quickButton/Shift/Ctrl/Alt/Meta/Kind`) -- `recordPointer
Down` always captures the down side (every press might turn out to be quick), `recordPointerUp`
always latches `quickTap = true` with the up side on top, regardless of whether the press was already
being tracked normally (cheap, no allocation, `.claude/rules/hot-paths.md`: listeners record, rAF
integrates). `processSlot` (`input/semantic.ts`) gained a third branch, `else if (slot.quickTap)`,
taken only when the slot is currently inactive *and* `wasActive[i]` never saw it active either: fires
one `tap` from the latched down/up data (`pick_id` and tile from the *down* position, a coordinator
ruling -- a real tap's down and up are the same point in practice; tap-radius and `TAP_MAX_MS` checked
fresh from the latched positions/times, since this slot's own `movedPastThreshold`/`heldMs` arrays
were never touched for this press). The other two branches (`slot.active` and `wasActive[i] === 1`,
both unchanged in their own logic) each clear `slot.quickTap = false` on entry, so a normal
multi-frame press's own already-correct handling can never be shadowed by a stale or redundant latch,
and a normal press is never double-fired. **Two full clicks on the same slot inside one frame gap**:
the second `recordPointerDown`/`recordPointerUp` pair simply overwrites the latch's own fields before
the recognizer ever consumes it -- one tap surfaces, using the *second* cycle's own down/up data, not
two (documented on `PointerSlot.quickTap`'s own doc comment: an input rate no real pointer device
reaches). **Verified no regression** in camera inertia/drag recognition, which reads the same
`PointerSlots` (`camera.ts`'s own pan/pinch/inertia never touches `quickTap` at all -- it is
`processSlot`'s own local branch, not a new field `camera.ts` reads): `pnpm test browser -t input`
(11), `-t camera` (4), `-t semantic` (6) -- see "Verified", below, for the ring-round-2 numbers.
**Unit test** (`semantic.test.ts`, "press and release inside one frame still taps"): down+up recorded
before a single `recognize()` call produces exactly one tap, `pick_id` from the down position (a
`PickSource` deliberately returning a different id for the down vs. up coordinates), tile `(0, 0)`;
a second full click-pair before the next `recognize()` call coalesces to one more tap (not two); a
press that moves past the tap radius entirely inside one frame gap fires no tap; an ordinary
multi-call press (observed active, then released) is unaffected. Inject-fail-revert (both the new
unit test and `anchors: pick_id on the HUD`, `anchors.spec.ts`'s own `tap()` helper reverted to a
plain `page.mouse.click()`): reverting `input/pointers.ts`/`input/semantic.ts` to their pre-round-2
shape (`git show <pre-round-2 commit>:...`) reproduces both failures exactly --
`semantic.test.ts`: `AssertionError: expected +0 to be 1` (zero taps fired); `anchors.spec.ts`:
`pick_id` stays `-`, `Timeout 5000ms exceeded while waiting on the predicate`. Reverted immediately
after (`git diff --stat` on both files showed only the intended fix before the real commit). A
second, smaller finding along the way (unrelated to the rAF-sampling defect): clicking exactly on a
button's own bottom-edge pixel (`y = 320`, the anchor point itself, `align: 'bottom'`'s own
`translate(-50%, -100%)`) is boundary-ambiguous and measurably missed the ring in an early draft
(`RING_SCREEN` moved to `y = 330`, 10 px clear of the button's own box, still inside the ring's 24 px
screen pick radius).

### `frame-bench.ts`: hover picking added, re-run

`onCamera` now calls `client.pick.at(renderer.viewport.widthPx / 2, renderer.viewport.heightPx / 2)`
once per frame (Budgets: "worst-case hover pick scans 65,536 records ... `bench.frame_worstcase` ...
is re-run with hover active"). No real pointer/DOM listener: the acquired slot's own `frame_seq`
changes every real frame regardless of scene content (`worker/client-drawlist.ts`'s pump publishes
unconditionally every wake), so `Picker.at`'s own `(cssX, cssY, frameSeq)` cache never hits at a
fixed point either -- a genuine full 65,536-record scan every frame, not a one-off. `window.
__frameBench` gained `pickScanned()` (`src/test/client.ts`'s own `pickScanned`) for a future spec to
assert against; not asserted by any test in this cut (the brief's own ask was the re-run and its
result line, not a new spec). **Re-run** (`pnpm bench:frame`, foreground, alone): `bench.
frame_worstcase [full]: records=65536 frames=306/23 warmup=120 timed=300 swiftshader=false` --
`main   p50=0.617ms p95=0.676ms budget<=1.3ms baseline.p50=0.637ms (+/-25%)`, `worker p50=1.880ms
p95=1.953ms budget<=2.7ms baseline.p50=2.152ms (+/-25%)`. Both comfortably inside `baselines/
frame.json`, unchanged (not touched).

### Verified (commands and results)

- `pnpm --filter engine typecheck` -> clean throughout (checked after every step; two real
  collisions caught and fixed along the way, both recorded above).
- `pnpm test unit -t pick` -> `unit pass 5 tests`; `-t overlay` -> `unit pass 2 tests`; `-t semantic`
  -> `unit pass 5 tests`; full `pnpm test unit` -> `unit pass 214 tests`.
- `pnpm test rust -t framecx` -> `rust pass 4 tests`; full `pnpm test rust` -> `rust pass 333 tests`
  (unchanged from steps 4-6's own count: no Rust test added or removed this cut).
- `pnpm test wasm -t "abi registry"` -> `wasm pass 9 tests` (`ABI_VERSION` unchanged: no new
  export).
- `pnpm test browser -t pick` -> `6`; `-t overlay` -> `9`; `-t ghost` -> `3` (this cut's own two plus
  the pre-existing `draw.ghost_follows_cursor_same_frame` substring match); `-t anchors` -> `6`
  (`gc-anchors`'s clean + 3 object controls, plus `anchors.spec.ts`'s own 2); `-t framecx` -> `2`;
  `-t device` -> `2`; `-t canvas` -> `3`; `-t input` (the strict GC page) -> `11`; `-t drawables` ->
  `10` (both unaffected by the `emit` fix beyond a lower, still-passing clean reading).
- `pnpm test browser -t "anchors neg burst"` -> `3 passed` (`@slow`, run directly since `pnpm test`
  skips it); `GC_MODE=software` (direct `playwright test --project gc --grep anchors`) -> `7 passed`
  (clean + every object/burst control, software mode).
- `pnpm gc reliability -t "anchors clean"` -> `50 passed` (hardware); a second, direct 20-run
  `GC_MODE=software` pass for the software row.
- `pnpm bench:frame` -> see the frame-bench paragraph above for the exact result line.
- Source scan (`grep -rnE "getBoundingClientRect|offsetWidth|offsetHeight|getClientRects|offsetTop|
  offsetLeft" src/overlay src/input`) -> zero matches outside comments (exit criterion 3).
- `pnpm format` (Biome + `cargo fmt`) run after every edit; final tree clean.
- `pnpm test`/`pnpm lint` (the full runs) not run (delegation prompt: "I am the gate"); nothing
  backgrounded (the one background `vite preview` used for manual `playwright-cli` debugging was
  killed before the final commit, not part of any test run).
- Inject-fail-revert, one per new browser test (all reverted immediately after, confirmed by
  `git diff --stat` matching only the intended change before the real commit):
  - `ghost.mouse_tracks_cursor_tile`: `fixtures/overlay/src/lib.rs`'s `extract()` ghost branch
    gated behind `if false && view.cursor_tile().is_some()` -> `ghost1` (`__ghostRecord()`)
    `undefined` even with a real hover in place. Covers `extract()`'s own ghost-drawing branch.
  - `ghost.touch_tap_then_confirm`: `input/semantic.ts`'s new cursor-tile-on-tap lines removed ->
    `cursor` reads `{x:0,y:0,valid:false}` after a real touch tap. Covers the `emit('tap', ...)`
    branch this cut added.
  - `overlay.translate_mode_equivalent`: `applyTranslateAnchor`'s own transform-write `if` gated
    behind `if (false)` -> the anchor never leaves its CSS default position (`box.x + box.width/2`
    reads `0`, not the expected `420`). Covers the whole translate-mode write path (both the
    creation-time and per-frame call sites share this one function).
  - `anchors clean` (GC page): `emitGame`'s preallocated-scratch write reverted to an inline object
    literal -> `bytesPerFrame.main` measured `554.71`, over the `508` budget. Covers the hot-path
    fix itself (see "Real defect" above; this is the same fault, shown against the *final* budget
    rather than the placeholder used while deriving it).
  - `anchors: pick_id on the HUD`: `device.ts`'s `client.input.on('tap', ...)` HUD-update body
    emptied -> `pick_id` never leaves `-` even for a direct ring click. Covers the HUD wiring
    exit criterion 4 depends on.

### Gate round 1 (coordinator review): a real pre-M18 defect, `quickTap`, fixed

The "Found building the `anchors` browser test" paragraph above (originally: "a synthetic click
never registers, masked by slowing the test down") is superseded by the real fix described there
now: `input/pointers.ts`'s `PointerSlot.quickTap` latch + `input/semantic.ts`'s `processSlot` third
branch. `anchors.spec.ts`'s `tap()` helper is removed; every call site is back to a plain
`page.mouse.click()`. New unit test: `semantic: press and release inside one frame still taps`
(`semantic.test.ts`).

- `pnpm --filter engine typecheck` -> clean.
- `pnpm test unit -t semantic` -> `unit pass 6 tests` (the new one); full `pnpm test unit` ->
  `unit pass 215 tests` (214 + 1).
- `pnpm test browser -t input` -> `11`; `-t camera` -> `4`; `-t semantic` -> `6`; `-t anchors` -> `6`;
  `-t ghost` -> `3`; `-t overlay` -> `9`; `-t pick` -> `6`; `-t follow` -> `4` -- all unchanged from
  before this round, confirming no regression in camera inertia or drag recognition (both read the
  same `PointerSlots` `quickTap` now lives on).
- `pnpm test browser -t "input clean"` -> `1 passed` (the strict zero-GC page, budget 190 B/frame,
  untouched) -> passes unchanged. `pnpm exec playwright test --project gc --grep "input"` (direct,
  every isolate/control) -> `8 passed`. `pnpm exec playwright test --project gc --grep "anchors"`
  (direct) -> `7 passed` (unaffected: `gc-anchors.ts` never calls `client.camera.tick()`/
  `recognize()` at all, so `quickTap` never executes on that page).
- Inject-fail-revert (both tests the coordinator named, together): `input/pointers.ts`/
  `input/semantic.ts` reverted to their pre-round-1 shape (`git show 5850fd6:...`, the commit before
  this round) --
  - `pnpm test unit -t "press and release inside one frame"` -> `FAIL`: `AssertionError: expected +0
    to be 1` (zero taps fired for a down+up landing inside one `recognize()` gap).
  - `pnpm test browser -t "anchors: pick_id"` -> `FAIL`: `Expected: "26" Received: "-"`, `Timeout
    5000ms exceeded while waiting on the predicate` (a plain `page.mouse.click()` on a ring never
    sets `pick_id`).
  Reverted immediately after (`cat` from a pre-edit backup, not `git checkout`): `git diff --stat`
  on both files showed only the intended `quickTap` addition before the real commit; both tests
  re-verified passing (`unit pass 1 tests`, `browser pass 1 tests`).
- `pnpm format` run after; final tree clean. `pnpm test`/`pnpm lint` (full) not run (same rule).
  Nothing backgrounded.

### Gate round 2 (coordinator review, full-diff review agent): five fixes

A review agent read the whole `git diff 4977d88..HEAD` (22 commits) plus a targeted mutation-style
pass over every named test. Full report:
`/private/tmp/claude-501/-Users-tyler-repos-engine-v2/55b258e9-8b53-4237-883f-8e84e83cc072/scratchpad/m18-review.md`
(not part of this repo; summarised here). Five findings fixed, across the whole milestone (not only
steps 7-8); the rest are listed below as skipped, with reasons, per the coordinator's own ruling.

**1. `overlay/anchors.ts`'s `rebaseOffset()` on the per-frame hot path (review Finding 4).**
`updateVisibility()` (steps 1-3's own code, not steps 7-8's) called the exported, object-literal-
returning `rebaseOffset()` once per anchor every rAF in `'properties'` mode (54 calls/frame on the
`anchors` GC page: 50 static + 4 slot) -- a real `.claude/rules/hot-paths.md` violation ("no ...
literals" on a per-frame path), invisible to the `anchors` GC budget only because V8's escape
analysis eliminates the allocation in practice, not by any guarantee the rule or the harness
enforces syntactically. `rebaseOffset` itself is unchanged (still returns a fresh object; `overlay.
rebase_math` calls it directly and cannot be weakened) -- only its two per-frame call sites inside
`updateVisibility()` are gone, replaced with the subtraction inlined directly (`(rec.worldX -
originX) * z`, no function call, no intermediate object at all, not even one escape analysis has to
eliminate). **Measured, not lowered**: 10 clean `pnpm gc reliability`-shaped runs after the fix read
498.29-498.83 B/frame (main), essentially identical to the pre-fix 498.29-499.14 range -- confirming
V8 was already eliminating this allocation, so the fix changes the *guarantee*, not the measured
byte count. Budget (508) is unchanged, per the coordinator's own "I decide that."
- `pnpm test unit -t overlay` -> `2`; `pnpm test browser -t overlay` -> `9`; `-t anchors` -> `6`,
  unchanged.

**2. `InputQueue::clear()` had no test (review Finding 1, "dead test," highest severity, whole
milestone not just this cut).** New native test `input_queue_cleared_between_frames`
(`game_instance.rs`): `MClient::frame` now stores `cx.input().len()` into a new test-only static,
`M_LAST_INPUT_LEN`; one real event pushed through the real `on_input` ABI path, `frame()` called
twice with no second `on_input` in between -- frame 1 sees length 1, frame 2 sees length 0, proving
`frame()`'s own trailing `input_queue.clear()` actually runs. Inject-fail-revert (delete
`input_queue.clear()`): `assertion left == right failed: frame 2 must not see frame 1's already-
consumed event / left: 1 / right: 0`. Reverted; `git diff --stat` showed only the intended addition;
full `pnpm test rust` -> `334` (333 + 1) both before and after the injected fault's revert.

**3. `drawlist.picker_matches_renderer_frame_seq` never proved either side was live (review Finding
2).** Added `expect(rendererSeq).toBeGreaterThan(previousSeq)` every iteration, `previousSeq`
starting at `0` (not `-1`) so the check also forces the very first iteration nonzero -- one check for
both properties the review named. Inject-fail-revert (coordinator's own prescribed fault, `DrawListSlot
.acquire()` made a no-op): failed, but with a different pair of numbers than a naive "both stuck at
0" guess -- `pickerFrameSeq()` (a cached number field, only ever written inside `acquire()`) froze at
`0`, while `frameSeq()` (read live off a `DataView` whose *reference* also never updates, but whose
*underlying SAB memory* keeps changing as the triple buffer's producer cycles back to the one frozen
physical slot) kept advancing to a real-but-wrong value (302) -- `Expected: 0, Received: 302`. The
pre-existing equality check alone already caught this particular fault; the new "advancing" check is
what closes the *other* half the review named (both stuck together, which this fault didn't happen to
produce, but the coordinator's own prescribed injection -- a no-op `acquire()` -- is exactly what was
run, and it failed, as required).
- `pnpm test browser -t drawlist.picker_matches_renderer_frame_seq` -> `1`; `-t drawables` -> `10`.

**4. `framecx_follow_written_to_header`'s `None` case used a fresh buffer (review Finding 3).** Now
reuses the one `out` buffer `Some` already wrote non-zero bytes into, across both `sort_into` calls.
Inject-fail-revert (skip the `None` arm's writes entirely, relying on the caller's buffer already
being zero -- the review's own suggested mutation): `assertion left == right failed / left: 1 /
right: 0` at the `follow_valid(&out2)` (now `&out`) assertion -- the stale `1` from the `Some` call
leaked through exactly as the review predicted. Reverted; `git diff --stat` clean; `pnpm test rust`
-> `334`.

**5. Quick-tap `TAP_MAX_MS` branch untested (review Finding 10).** Added one case to `semantic:
press and release inside one frame still taps`: down and up latched 350ms apart (over `TAP_MAX_MS`,
300ms), no movement -- fires no tap. Inject-fail-revert (drop the `heldMsQuick < TAP_MAX_MS` half of
the quick-tap branch's own condition): `AssertionError: expected 3 to be 2` (the held-too-long press
now wrongly fired a tap). Reverted; `pnpm test unit -t semantic` -> `6`.

**Skipped, per the coordinator's own instruction ("leave ... unless one is a one-line addition")**:
- Review Finding 5 (`overlay.rebase_beyond_50000px` never checks a rebase actually fired, only the
  final position) -- not a one-line addition (needs a new counter or hook exposing rebase count).
- Review Finding 6 (`needsRebase` unit test never checks the exact `50_000` boundary, only ±1px) --
  arguably a one-line addition, but explicitly named in the coordinator's own "leave" list.
- Review Finding 7 (`pick.hover_once_per_raf_on_change` never tests "same point, new `frame_seq`")
  -- needs a second real publish at the same cached point, not a one-line addition.
- Review Finding 8 (`pick.contains_per_kind` misses one axis for `bar`/`ghost`, and `KIND_SPRITE`
  has no dedicated case) -- several new cases, not one line.
- Review Finding 9 (`input.game_record_survives_overflow` never reaches "64 `kind::GAME` already
  queued, one more `kind::GAME` push") -- already reasoned as "not reachable by any real caller
  today" in the original Deviations; left as is.
- Review Finding 10's second gap (quick-tap scores movement as net down-to-up displacement only,
  never consulting intermediate `recordPointerMove` samples inside the same frame gap) -- needs
  either a new per-slot sample-scan or a documented, deliberate simplification; not a one-line fix.
- `follow.centres_in_same_frame_pan_ignored_zoom_works` never asserts velocity zeroing (Part 1,
  Finding 11) -- no `__rcRead` field exposes velocity today; would need a new test hook.

**Longpress slot-reuse state corruption (Part 3, review's own last bullet) -- pre-M18, not fixed,
recorded for the ledger per the coordinator's instruction.** If the same physical pointer slot is
reused by a second press while `wasActive[i]`/`heldMs[i]`/`downX/Y[i]` bookkeeping from a first,
completed *multi-frame* longpress hasn't been reset (the "just engaged" branch that resets it only
runs when `wasActive[i] === 0`, never fires if `wasActive[i]` is already `1` when a new press
starts), the second press's own tap/drag/longpress classification can be corrupted by the first
press's stale values. Same bug class `quickTap` fixed for the *same-frame* case (gate round 1); the
*multi-frame* case is not covered by that fix. Confirmed by the review as pre-existing (`camera.ts`
grepped directly for `quickTap`/`quickDown`/`quickUp`: zero matches, so this is unrelated to M18's
own new code) -- not reproduced or fixed here; a candidate for `docs/plan/deferred-ledger.md`.

### Verified (gate round 2, commands and results)

- `pnpm --filter engine typecheck` -> clean.
- `pnpm test rust` (full) -> `334 tests` (333 + `input_queue_cleared_between_frames`), both before
  and after every inject-fail-revert's own revert.
- `pnpm test unit -t semantic` -> `6`; `-t overlay` -> `2`.
- `pnpm test browser -t overlay` -> `9`; `-t anchors` -> `6`; `-t drawables` -> `10`; `-t input` ->
  `11`; `-t camera` -> `4`; `-t ghost` -> `3`; `-t pick` -> `6`; `-t follow` -> `4`; `-t framecx` ->
  `2`; `-t drawlist.picker_matches_renderer_frame_seq` -> `1` -- all unchanged from before this
  round, confirming no regression from any of the five fixes.
- `pnpm format` run after every edit; final tree clean. `pnpm test`/`pnpm lint` (full) not run (same
  rule: "I am the gate"). Nothing backgrounded -- every fault injection and its revert was run
  directly in the foreground; the build's own `fixtures` step varied 21-177s run to run on this
  machine under load, unrelated to any of these changes.

## Orchestrator's gate record

Cut 1-3 / 4-6 / 7-8, three implementers. Cut 1 had one fix round, cut 2 two, cut 3 two (the second from a Sonnet review agent's read of the whole ~5,300-line diff). What each round found:
- **Cut 1, two readers of one triple buffer.** `client.ts` built its `DrawListSlot` while `render/drawables.ts` kept its own `TripleReader` over the same SAB (live on `gc-drawables`, `frame-bench`, `device?harness=1`). Now one reader. `drawlist.picker_matches_renderer_frame_seq` guards it: I re-ran its injection (a second reader at the page) and got 302 against 0.
- **Cut 2, input one wake late on every real page.** `worker/client.ts`'s `body()` ran `frame()` before `inputPump.pump()`, and both `framecx.*` tests stepped twice to hide it. Fixed by reordering.
- **Cut 2, round 2.** `framecx.*` failed 2 in 12 isolated runs behind a 20 s wait. The cause was `lastUi()`'s lazy subscription (a test bug; `onUi`'s contract is unchanged). The wait is back to 5 s, and I measured 15/15 isolated.
- **Cut 3, a press and release inside one frame was never a tap** (M11's `pointers.ts`/`semantic.ts`, pre-existing; a trackpad tap-to-click or a fast phone tap). The `anchors` test's 50 ms gap hid it. Fixed with a `quickTap` latch; the test uses plain `page.mouse.click()`.
- **Review round.** A per-anchor `{wx, wy}` literal on the default per-frame path (fixed; the clean figure did not move, so V8 had been eliding it). `InputQueue::clear()` was untested (now `input_queue_cleared_between_frames`). Three weak assertions were strengthened.
- **My own fix** (`render/drawlist-slot.ts`, under 20 lines). `createDrawListSlot` started its views on slot 0, the triple buffer's initial *middle*, which the writer's `publish()` takes and writes. So any read before the first `acquire()` raced the producer. The review round's no-op-`acquire` injection exposed it: the renderer read `frame_seq` 302 through a slot the reader never owned. It now starts on slot 2, the reader's initial `front`.

Final gate: `rust` 334, `unit` 215, `wasm` 52, `browser` 168 at 25 s of 35 s, lint clean, no golden changed, `ABI_VERSION` unchanged at 15. Loops: `browser` 30/30 under `--load 10` (slowest 33 s) and 28/30 quiet. The two quiet failures were one `park('sim')` timeout on `gc: flat transport parity` (the standing `parkWorkers` watch item) and **one `stepping: 1,000 stepTick()` hash mismatch**, never seen before, 0/40 isolated, on a path M18 did not touch. That one is `docs/plan/18c-stepping-hash-under-load.md`. `bench.frame_worstcase` with hover picking: main p50 0.617 ms, worker p50 1.880 ms, inside `baselines/frame.json`.
