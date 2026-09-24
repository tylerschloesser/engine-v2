# M18: Picking, overlay anchoring, `FrameCx`

Status: not started · After: 17, 09b · Tyler-dependent: no

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
- [ ] All tests above pass by name.
- [ ] `budgets.json` has `gc.pages.anchors` with the constant in its `formula`; pages `anchors`, `input` and `drawables` pass.
- [ ] Source scan: no `getBoundingClientRect`, `offsetWidth` or other layout read under `src/overlay/` or `src/input/`.
- [ ] In desktop Chrome `device.html?anchors=50` shows `pick_id` on the HUD: a click on a ring sets it to that ring's id, a click on empty ground to `-`, a click on an anchored button leaves it unchanged (asserted by the `anchors` browser test reading the HUD text).
- [ ] The `docs/plan/device-checks.md` section for this milestone matches what was built.
- [ ] `pnpm test` and `pnpm lint` are green.

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

**One-wake input latency, found running this cut's own first draft.** `worker/client.ts`'s `body()`
calls `frame()` *before* `inputPump.pump()` drains that same wake's own new `inputRing` records into
`InputQueue` -- a record written before a `stepFrame` call is only visible to the *next* real
`frame()` call's own `cx.input()`, not that same call's. Both `framecx.*` browser tests call
`stepFrame` twice for this reason (`stepFrameTwice`, documented at its own definition site); this is
the same one-wake-old staleness `game_instance.rs`'s own `CachedCameraView` doc comment already
names elsewhere in this pipeline, not a defect this cut introduced or should fix.

**`client.onUi`'s own independent poll**, found running this cut's own first draft: `resultsFrame()`
(`client.ts`) drains `uiRing` and fires `onUi` listeners from a *separate* real-`requestAnimationFrame`
schedule, not from `stepFrame`'s synchronous worker lockstep -- reading `lastUi()` immediately after
two `stepFrame` calls raced that independent rAF and returned `undefined` intermittently (observed:
passed with 1 real second of slack via manual `page.waitForFunction` probing, timed out at exactly
5000ms in one full-suite run under parallel-worker contention). Both `framecx.*` tests use `page.
waitForFunction` (`waitForUi`) rather than a fixed read, and re-ran clean 3/3 plus inside the full
159-test browser suite once fixed.

### Live in production vs. test-only

Live on every real page (not only in tests): `FrameCx`/`ClientSide::frame`'s new call, `cx.input()`,
`InputQueue`'s never-dropped `kind::GAME` policy, `client.input.emit`, `DrawList::anchor`'s header
writes (even when a game never calls it -- the mask is always written, all-zero), `client.overlay.
anchorSlot`, `follow`'s camera-centring in `integrate()`, and `camera.tick()`'s own header read
(unconditional, every rAF, zero-cost when `follow_valid` is `0`). Test-only: `fx-overlay` itself,
`framecx.html`'s `__stepFrame`/`__injectRawInput`/`__emit`/`__lastUi` hooks, `real-camera.ts`'s
`opts.follow`/`opts.anchors` header hand-fill and its `__rcOverlayAnchorSlot*` hooks.

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
- `pnpm test browser` (full) -> `browser pass 159 tests`.
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
  - `framecx.tap_visible_in_frame` / `framecx.emit_visible_in_frame`: `fx-overlay`'s own
    `cx.ui_dirty()` call commented out -> both timed out waiting for `count > 0` (`ui.maybe_run`
    never reruns with no replica mutation on this fixture's own path). Covers `FrameCx::ui_dirty()`'s
    own write-then-read round trip through `game_instance.rs`.
  - `follow.centres_in_same_frame_pan_ignored_zoom_works`: `camera.ts`'s own follow-override block
    gated behind `if (false && follow.valid)` -> failed the first centring assertion (`expected 7,
    received 0`, the un-overridden pre-drag default). Covers `integrate()`'s own follow-override
    branch.
- `pnpm test`/`pnpm lint` (the full runs) not run (delegation prompt: "I am the gate").
- Not run (steps 7-8, later implementer's): `pnpm test browser -t "\btranslate\b"`, any GC/budgets
  command, `pnpm bench:frame`.
