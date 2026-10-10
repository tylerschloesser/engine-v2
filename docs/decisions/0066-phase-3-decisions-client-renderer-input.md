# 0066: Phase 3 decisions: client, renderer and input

Status: Accepted (2026-10-10). Amends [0018](0018-renderer.md) §7 and §9, [0019](0019-camera-input-and-overlay.md) §3 and [0061](0061-wheel-zoom-bounded-accumulator.md) (default zoom). Written at the Phase 3 to Phase 4 handoff (M39b) to keep decisions that lived only in milestone briefs, which Phase 4 deletes. Implemented in M09, M16 to M18, M26, M29, M39h, M39j, M39k and M39aj.

## Context

Phase 3 settled several client, renderer and input choices that the code shows but does not explain, and corrected three places where an accepted ADR was silent or measured the wrong thing. Each entry below is the decision plus the reason that cannot be read from code.

## Decision

### Measuring on real hardware

**1. GPU time is judged from `timestamp-query` execution time, not submit latency (amends 0018 §9).** The "GPU time under about 6 ms" limit means the GPU execution time of the terrain pass. Submit-to-`onSubmittedWorkDone` latency is a vsync floor: a trivial flat full-screen pass reads 12.9 ms p50 on the Pixel 5 while its timestamp delta is 1.18 ms, which is why no render-scale cap ever moved the old 12 to 19 ms readings that appeared to fail the limit. Measured by execution time, the Pixel 5 passes at 5.57 ms of 6 (a thin margin: anyone changing the renderer re-reads it) and the iPhone 12 reads 3.85 ms (0.69 ms with anchors). Timestamps showed no coarse clamping on either phone. Only the terrain pass is timed (drawables ride in it through `onEncode`); the standalone `drawables.draw` pass is not. The option is `render.gpuTiming`, default off, so the shipped device request stays empty and a zero-GC page runs without it ([0016](0016-zero-gc-definition.md)); when on, it samples one frame in four through a ring of mappable buffers read after the writing frame.

**2. Every fixture and game page carries a viewport meta (amends 0019 §3).** Before M39h no fixture page had one, so every phone reading taken from a fixture page (M09b fill-rate, M11 and others) was taken at the browser's 980 CSS px desktop layout (Pixel canvas 1960 x 3999, iPhone visualViewport scale 0.398). The page helper (`input/page-css.ts`) now writes `width=device-width, initial-scale=1, viewport-fit=cover`; pages that do not call the helper carry the same static tag, and pages that do call it carry it too, because a meta inserted after first layout may not take effect everywhere. `user-scalable=no` and `maximum-scale` are deliberately not added: 0019 §3 stops page zoom with `touch-action` and `preventDefault`, and disabling accessibility zoom is not part of it. Any phone number recorded before 2026-10-05 was taken at the wrong size.

**3. A visual criterion needs a pixel readback on the production page.** Reading the DrawList back proves nothing is on screen: M33c found that no production page had drawn a drawable since M20b while every DrawList assertion passed. A criterion of the form "X is visible" is met only by `readPixels`/`expectPixel` ([0020](0020-testing-strategy.md) §6) on the page a player loads.

**4. Android coverage.** Phase 1 listed Chrome Android as Tier 1, but until M39 no Android device was available (iPhone only), so every Android row of the early device rounds read "not run: no device" and the spec was not amended. The Pixel 5 appears from the Phase 3 exit rounds on; numbers on Android before that were never taken.

### Client dispatch, UI ring and clock

**5. `client.dispatch` and `FrameCx` (refines 0012).** `dispatch` before `ready` throws instead of queueing: a queue needs a seq-less second path and hides a bootstrap bug. After ready it never waits on the connection; a full outbox throws `action queue full` (0012 "dispatch fails locally"). `FrameCx` deliberately has no `dispatch`: seq is assigned on main so `dispatch` returns it synchronously, and a second issuer inside the worker would need a reserved seq space and a second result path. Reopening this needs an ADR.

**6. Action results share the UI ring.** Results are record kind 2 in the same ring as `Ui` (kind 1): the same consumer, human rate, and ring order gives "state before result" for free. `Ui` is coalesced newest-wins per rAF; results never are. "Changed" for `Ui` is decided by `PartialEq` on the Rust value, not by JSON bytes. `ui` runs inside `on_frame` before that frame's results (running it in `frame()` made the Ui record lag one wake). `client.clock()` returns one reused object, because a fresh one per call would charge game-UI polling to main's allocation budget ([0016](0016-zero-gc-definition.md)).

### Picking, overlay and the DrawList

**7. Picking and overlay shape.** Input reaches Rust as a borrowed slice `cx.input()` of the 32-byte records; the game copies what it needs into its `Client` value because `extract` is `&self`. Anchored overlay elements are re-parented into the engine's anchor layer, so they need `--z` and the layer transform inherited. `mode: 'translate'` (one `translate()` write per visible anchor, [0019](0019-camera-input-and-overlay.md) "Alternatives rejected") is built but off by default so a device check can switch to it by URL parameter. "Follow with user offset" is not in v1: `cx.follow` takes a position and the game adds its offset.

**8. DrawList window origin and cursor anchor.** [0024](0024-planning-amendments.md) fixes the slot header at 1,024 B. Two reasons it does not state: the window origin is the camera-centre tile snapped down to a multiple of 64 tiles (`snap_window_origin`), so DrawList hashes do not change with sub-chunk camera motion; and `ANCHOR_CURSOR_TILE` is resolved in the vertex shader from the live camera, which gives zero ghost latency (a CPU-side resolution would trail the cursor by a frame).

**9. A pending tile is styled by the game, not the terrain shader.** The tile texel carries only the predicted value; the game draws a `rect` or `ghost` from `predicted_tiles`. Reason: `TileTexel` has no spare meaning and the terrain shader has no per-game styling hook, while the DrawList has both. Entities carry a `PREDICTED` flag set by `extract` ([0018](0018-renderer.md) §2 flags).

**10. The reveal gate is opt-in.** `FrameLoopOptions.revealed?` and `TerrainRenderer.draw(target, { reveal })` exist, but only the multiplayer page supplies `revealed`; omitted, `reveal` stays `true`. Reason: gating every page would make `client.ready` an insufficient "first frame shows terrain" signal for the many pixel-probe tests that predate it. A game that wants the gate on by default can wire `client.revealed` into its frame loop; making it the default is a later call.

**11. The engine owns the default camera zoom (amends 0061).** `DEFAULT_TILES_ACROSS = 32` in `camera/state.ts`; 0019 §1 makes the engine own the camera, so a game need not override it on every page. 12 is the zoom-in limit, so the old default left a fresh camera unable to zoom in. Pinch was checked and has no defect: each frame applies the incremental ratio through `applyZoomTo`, which clamps. Test pages that assume 12 call `moveTo` explicitly after `createClient`.

### Renderer device request (amends 0018 §7)

**12. Compatibility-mode details 0018 §7 omits.** `featureLevel: 'compatibility'` is a `requestAdapter()` option, not a `requestDevice()` one (`ADAPTER_REQUEST` in `render/device.ts`). In compatibility mode a texture bound with a non-default view dimension needs `textureBindingViewDimension: '2d-array'` at texture creation time, not only in the bind-group layout. Both were found only from `uncapturederror`; the second has no code comment beyond the texture creation sites, so it is stated here.

## Known limitations (recorded, not fixed at Phase 3 exit)

- **Overlay buttons over picked entities on small Android screens.** Chrome Android's touch adjustment snaps a tap near a drawn ring to its overlaid DOM button (`elementFromPoint` says canvas, the real target is the button). The M18-pick device check cannot be completed on a 392 px Pixel 5 at 40 tiles (a tap 11 px under the ring's anchor picks it, 9 px hits the button, 15 px misses), so a real player has the same problem there. It passes on the iPhone. Mitigation if it matters: keep buttons out of the ring's touch-adjustment radius, or pick on `pointerdown` before the click retarget.
- **First DOM anchor shows at the layer origin for one frame.** `overlay.anchor()` creates the element visible and writes only its own `--wx/--wy`; the layer transform is written by the next `apply`, so first anchors overlap and can intercept each other's pointer events for that frame. The fix is small (create hidden until the first `apply`, or write the layer transform in `anchor()`); unscheduled.

## Alternatives rejected

- A dispatch queue before `ready`: hides bootstrap bugs and needs a seq-less path (5).
- `dispatch` on `FrameCx`: needs a reserved seq space and a second result path (5).
- Per-game terrain shader styling for pending tiles: no hook exists, the DrawList already has one (9).
- `user-scalable=no` to stop page zoom: removes accessibility zoom; `touch-action` and `preventDefault` already do the job (2).
- Timing submit-to-done latency on phones: vsync floor, insensitive to the pass (1).

## Consequences

- Phone numbers taken before 2026-10-05 (fixture pages) are not comparable with later ones; re-read any budget that cites one.
- The Pixel 5 GPU margin (5.57 of 6 ms) is the first thing to check after any terrain or drawable shader change.
- Revisit 10 if a second game wants the reveal gate; revisit the limitations when a game places buttons over pickable entities on small screens.

## Sources

- Pixel 5 and iPhone 12 driven rounds (M39j, M39k), 2026-10-05 to 2026-10-10.
- Code checked 2026-10-10: `render/device.ts`, `render/gpu-timing.ts`, `render/terrain.ts`, `frame-loop.ts`, `camera/state.ts`, `overlay/anchors.ts`, `client.ts`, `crates/engine/src/client/drawlist.rs`.
