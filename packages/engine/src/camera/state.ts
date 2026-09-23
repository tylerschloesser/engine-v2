// Main-thread camera state (docs/decisions/0019-camera-input-and-overlay.md §1): plain mutable
// fields, integrated once per rAF and written to the camera block in the same callback. Centre is
// `f64` (world tiles can exceed f32's ~2^24 exact-integer range); everything else is `f32`-precision
// by convention even though the fields themselves are plain `number`s. Not restricted by
// `sab.no_alloc_syntax` (only `camera/block.ts` is): this is an ordinary data object, constructed
// once by its owner and mutated every frame.
export class CameraState {
  centreX = 0
  centreY = 0
  velocityX = 0
  velocityY = 0
  tilesAcross = 12
  zoomRate = 0
  halfExtentTilesX = 0
  halfExtentTilesY = 0
  dpr = 1
  frameTimeMs = 0
  cursorTileX = 0
  cursorTileY = 0
  cursorValid = false
  /** M17 (docs/plan/17-drawlist-and-sprites.md, steps 4-6): the real device-pixel viewport size,
   * set by `frame-loop.ts`'s `tick()` each rAF from `renderer.viewport.widthPx/heightPx` (post
   * render-scale) -- distinct from `camera/transform.ts`'s CSS-pixel `CameraViewport`. `0` until a
   * real `TerrainRenderer.viewport` has been sized at least once. */
  viewportPxW = 0
  viewportPxH = 0
}

/** `client.camera.read(out)` (Seams: "fills a caller-owned object"): a plain field-by-field copy,
 * allocation-free, so a game can call it every frame if it wants to. */
export function copyCameraState(src: CameraState, dst: CameraState): void {
  dst.centreX = src.centreX
  dst.centreY = src.centreY
  dst.velocityX = src.velocityX
  dst.velocityY = src.velocityY
  dst.tilesAcross = src.tilesAcross
  dst.zoomRate = src.zoomRate
  dst.halfExtentTilesX = src.halfExtentTilesX
  dst.halfExtentTilesY = src.halfExtentTilesY
  dst.dpr = src.dpr
  dst.frameTimeMs = src.frameTimeMs
  dst.cursorTileX = src.cursorTileX
  dst.cursorTileY = src.cursorTileY
  dst.cursorValid = src.cursorValid
  dst.viewportPxW = src.viewportPxW
  dst.viewportPxH = src.viewportPxH
}
