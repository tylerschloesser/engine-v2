// Pure camera transforms (docs/decisions/0019-camera-input-and-overlay.md §1, §4 "Picking";
// docs/plan/11-camera-and-input.md Scope: "worldToScreen, screenToWorld, tile under a point; pure
// functions shared with M18 picking"). No DOM, no allocation: every function writes into a
// caller-owned `out` object (`.claude/rules/hot-paths.md` -- these run on the per-frame camera and
// picking paths).
//
// Convention (matches `terrain.wgsl`'s `fs_main`, `docs/plan/09-renderer-terrain.md` Planning
// decisions "Bind group layout": `rel = (frag_coord.xy - half_viewport) * tiles_per_px`): world X
// increases right, world Y increases down, exactly like screen/CSS pixels -- no axis flip. One
// scalar `tilesPerPx` (not a per-axis one) is applied to both axes, derived from `tilesAcross`
// (tiles across the *long* axis, 0019 §1) and the viewport's longer side; the shorter axis simply
// shows fewer tiles, which is what makes `halfExtentTilesX`/`halfExtentTilesY` asymmetric for a
// non-square viewport (`camera/camera.ts` writes these into `CameraState` every frame; the device
// page's own stand-in, replaced by a later range, computed a wrong *uniform* `tilesAcross / 2` for
// both axes -- docs/plan/09b-terrain-art-and-lifecycle.md Deviations, "Interpretation calls").
//
// `CameraViewport` is deliberately not `render/terrain.ts`'s `Viewport`: that one is the renderer's
// own device-pixel, DPR/render-scale-aware backing-store size. Chunk subscription and gesture math
// both care about how many *tiles* are visible, which does not change when DPR/render-scale does --
// so this module (and `CameraState.halfExtentTiles*`) works in CSS pixels, the same space pointer
// events and `getBoundingClientRect()` report.
import type { CameraState } from './state.js'

export type CameraViewport = { widthPx: number; heightPx: number }

export type ScreenPoint = { x: number; y: number }
export type TilePoint = { tileX: number; tileY: number; fracX: number; fracY: number }

/** CSS pixels per world tile, the long-axis viewport side divided by `tilesAcross`. Shared by every
 * function below so the same value is never independently recomputed two different ways. */
export function pxPerTile(
  state: Pick<CameraState, 'tilesAcross'>,
  viewport: CameraViewport,
): number {
  return Math.max(viewport.widthPx, viewport.heightPx) / state.tilesAcross
}

/** Half the viewport's visible extent, in tiles, per axis (`CameraState.halfExtentTiles{X,Y}`'s own
 * formula: not `tilesAcross / 2` on both axes -- that is only correct for a square viewport). */
export function halfExtentTiles(
  state: Pick<CameraState, 'tilesAcross'>,
  viewport: CameraViewport,
  out: ScreenPoint,
): void {
  const ppt = pxPerTile(state, viewport)
  out.x = viewport.widthPx / (2 * ppt)
  out.y = viewport.heightPx / (2 * ppt)
}

/** World tile coordinates -> CSS pixel coordinates relative to the canvas's own top-left corner. */
export function worldToScreen(
  state: Pick<CameraState, 'centreX' | 'centreY' | 'tilesAcross'>,
  viewport: CameraViewport,
  worldX: number,
  worldY: number,
  out: ScreenPoint,
): void {
  const ppt = pxPerTile(state, viewport)
  out.x = viewport.widthPx / 2 + (worldX - state.centreX) * ppt
  out.y = viewport.heightPx / 2 + (worldY - state.centreY) * ppt
}

/** CSS pixel coordinates (canvas-relative) -> world tile coordinates. Exact inverse of
 * `worldToScreen` (`transform: roundtrip`). */
export function screenToWorld(
  state: Pick<CameraState, 'centreX' | 'centreY' | 'tilesAcross'>,
  viewport: CameraViewport,
  screenX: number,
  screenY: number,
  out: ScreenPoint,
): void {
  const ppt = pxPerTile(state, viewport)
  const tilesPerPx = 1 / ppt
  out.x = state.centreX + (screenX - viewport.widthPx / 2) * tilesPerPx
  out.y = state.centreY + (screenY - viewport.heightPx / 2) * tilesPerPx
}

const worldScratch: ScreenPoint = { x: 0, y: 0 }

/** The tile under a CSS-pixel point, plus its fractional offset inside that tile (0 <= frac < 1 on
 * each axis) -- the same split `terrain.wgsl` does with `floor(rel)`/`rel - floor(rel)`, at f64
 * precision (0019 §4 "Picking": "tiles by arithmetic from the camera"). `worldScratch` is
 * module-level and reused (not per-call-allocated): this runs on the picking path every hover
 * (`.claude/rules/hot-paths.md`). Not reentrant-safe across two calls without reading `out` first --
 * exactly like every other reused-scratch helper in this codebase (`sab/bytes.ts`'s `at`, etc). */
export function tileUnderPoint(
  state: Pick<CameraState, 'centreX' | 'centreY' | 'tilesAcross'>,
  viewport: CameraViewport,
  screenX: number,
  screenY: number,
  out: TilePoint,
): void {
  screenToWorld(state, viewport, screenX, screenY, worldScratch)
  const tileX = Math.floor(worldScratch.x)
  const tileY = Math.floor(worldScratch.y)
  out.tileX = tileX
  out.tileY = tileY
  out.fracX = worldScratch.x - tileX
  out.fracY = worldScratch.y - tileY
}
