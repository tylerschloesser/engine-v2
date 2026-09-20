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
}
