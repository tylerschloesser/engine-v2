# M39aj: zoom feel (start mid-range, bounded wheel zoom, wheel over overlays)

Status: open · After: 39ai · Tyler-dependent: no

## Goal
On 2026-10-10 Tyler played the deployed reference game (Fly, built at `ce6c25b0`) on the iPhone and in Chrome on the Mac and reported: "it zooms in super close instantly and then is stuck". (His other report, pan reversing on release, is a sign error that `b2d7c03c` (M39i) already fixed on `main`; only the deploy is stale.) A read-only diagnosis on 2026-10-10 reproduced it in headed Chromium against the deployed bundle and found three causes, all still on `main`:

1. **The game opens at the zoom-in limit.** `camera/state.ts` defaults `tilesAcross = 12`, which equals `DEFAULT_MIN_TILES` (`camera/camera.ts:46`). The first view is as close as it gets, and zooming in does nothing (`clampTiles`). The camera is persisted, so a session that ended at a limit reopens there.
2. **Wheel zoom has no per-event or per-frame bound.** `recordWheel` (`input/wheel.ts:36`) adds `deltaY × 0.002 × mode × (ctrl ? 10 : 1)` to `pendingDeltaLog`, and `applyWheelEasing` (`camera.ts:325-345`) eases it in at τ = 22 ms. The whole 12-256 range is only ln 21.3 ≈ 3.06. In a synthetic test, 20 ctrl+wheel events of deltaY 4 took 14.66 to 72.6 tiles (×5). A real trackpad pinch or a momentum flick sums a few hundred to a few thousand px of `deltaY`, so it reaches the limit in a few frames and the clamp holds it there. That part is a guess: real deltas were not measured.
3. **Wheel events over an overlay are dropped.** `installWheelListeners` is on the canvas only, and any engine-anchored element with `pointer-events: auto` (collect button, craft menu, build button) swallows them. With the cursor on the Collect button the wheel did nothing at all. That is the "stuck" feel.

When this is done, the game opens mid-range, one gesture cannot slam the zoom from limit to limit, the wheel zooms wherever the cursor is over the game, and tests pin the magnitudes.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0019-camera-input-and-overlay.md` §1 and §3
3. `packages/engine/CLAUDE.md`
Rules that apply: `.claude/rules/hot-paths.md` (the wheel and camera paths run every frame; `[gc] input` must stay green with no budget change).

## Scope
1. **Default zoom.** A fresh camera opens at **32 tiles across**, inside `[minTiles, maxTiles]`. Set it in the engine default, or as the reference game's initial camera if 0019 says the game picks it; say which and why. A persisted camera still restores, but a restored value equal to a limit is fine (that was the player's choice). Fix whatever the default breaks (tests, goldens, gc pages that assumed 12) and list each.
2. **Bounded wheel zoom.** Keep d3's per-pixel form (0019 fixes only the form), but bound the outstanding accumulator: `|pendingDeltaLog|` saturates at **ln 2** (at most one doubling or halving queued), and the ctrl (pinch) multiplier stays if, with the cap, a 20-event deltaY-4 ctrl stream changes the zoom by no more than ×2. If a per-frame rate cap is needed instead or as well, measure and justify it. This changes 0019 §3's constants: write an ADR amending it with the `write-adr` skill.
3. **Wheel over overlays.** Wheel events anywhere over the game's surface (canvas and the engine's overlay layer, including `pointer-events: auto` elements) zoom about the cursor, and `preventDefault` stops the page scrolling or zooming. Compute the cursor position relative to the canvas without allocating per event (see `input/pointers.ts`'s note on `offsetX`/`getBoundingClientRect`; a rect cached on resize is fine). A scrollable DOM panel a game puts in the overlay (if any exists in `games/reference`) keeps its own scroll: say how you handled that.
4. **Touch pinch.** Check that a two-finger pinch on touch is bounded by the same limits and can't get stuck at a limit (it should already work: ×3 for 300→100 px fingers measured). Add a test only if you find a defect.

## Non-scope
Pan, inertia and the release tail (fixed in M39i/M39m and covered). Safari `gesturechange` (covered by `camera.gesturechange_scale_zooms_about_cursor`). Redeploying Fly (the orchestrator does it).

## Files touched
`packages/engine/src/camera/{camera,state}.ts`, `packages/engine/src/input/wheel.ts`, the overlay host where the listener moves to, their tests; `games/reference/src/**` only if the game sets the initial camera; one ADR under `docs/decisions/` plus its line under "Plan-level decisions" in `PLAN.md`.

## Tests added
Unit (`camera.test.ts` / a wheel test), each with an inject-fail-revert red pasted:
- `wheel: one notch zooms by a fixed factor`: deltaY ±100, mode 0, ends at `12 × e^{±0.2}` within 1e-6 (pin the constant), and mode 1 deltaY 3 likewise.
- `wheel: a burst cannot pass one doubling`: 200 events of deltaY 50 in one frame, then integrate to rest: the ratio is ≤ 2 (and fails without the cap).
- `wheel: ctrl pinch stream is bounded`: 20 ctrl events of deltaY 4: ratio ≤ 2.
- `camera: fresh camera opens mid-range`: `tilesAcross` is 32 and strictly between the limits.
Browser (quick, or `@slow` if over ~1 s; say which): `wheel over an overlay button zooms`: a wheel event dispatched on a `pointer-events: auto` overlay element changes `tilesAcross`, and the page does not scroll.

## Exit criteria
- [ ] A fresh camera opens at 32 tiles across (test named).
- [ ] The wheel accumulator is bounded; the burst and ctrl-stream tests fail without the bound (reds pasted).
- [ ] The wheel zooms over overlays (browser test named, red pasted with the listener on the canvas only).
- [ ] `[gc] input` and the other gc pages unchanged (pasted); no zero-GC budget changed.
- [ ] ADR amending 0019 §3 written and indexed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t wheel`, `pnpm test unit -t camera`, `pnpm test browser -t "<name>"`, `pnpm test browser -t "\[gc\] input"`. Foreground, bounded; `uptime` first.

## Manual device checks
After the orchestrator redeploys Fly, Tyler retries pan and zoom on the iPhone and the Mac (part of M39-two-devices and M39-full-game-touch).

## Deviations
