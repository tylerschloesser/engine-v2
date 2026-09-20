// The camera block (docs/decisions/0019-camera-input-and-overlay.md §1, Planning decisions "Camera-
// block byte offsets"): a fixed 80-byte seqlock-guarded SAB record, `seq` at offset 0 doubling as
// both the layout's own first field and the seqlock sequence word (docs/plan/06-sab-primitives-and-
// workers.md, Scope). Written once per rAF by main; read by the client worker. Every view is built
// once, in `CameraBlockView`'s constructor; `writeCameraBlock`/`readCameraBlockInto` run every frame
// and allocate nothing (`sab.no_alloc_syntax`).
import type { CameraState } from './state.js'

export const CAMERA_BLOCK_BYTES = 80

export const CAM_OFF_SEQ = 0
export const CAM_OFF_CURSOR_VALID = 4
export const CAM_OFF_CENTRE = 8
export const CAM_OFF_FRAME_TIME_MS = 24
export const CAM_OFF_VELOCITY = 32
export const CAM_OFF_TILES_ACROSS = 40
export const CAM_OFF_ZOOM_RATE = 44
export const CAM_OFF_HALF_EXTENT_TILES = 48
export const CAM_OFF_DPR = 56
export const CAM_OFF_CURSOR_TILE = 64

const MAX_RETRIES = 8

export function createCameraBlock(): SharedArrayBuffer {
  return new SharedArrayBuffer(CAMERA_BLOCK_BYTES)
}

export class CameraBlockView {
  private readonly seq: Int32Array
  private readonly cursorValid: Uint32Array
  private readonly centre: Float64Array
  private readonly frameTimeMs: Float64Array
  private readonly velocity: Float32Array
  private readonly tilesAcross: Float32Array
  private readonly zoomRate: Float32Array
  private readonly halfExtentTiles: Float32Array
  private readonly dpr: Float32Array
  private readonly cursorTile: Int32Array
  private readonly bytes: Uint8Array
  private readonly scratch: Uint8Array

  constructor(sab: SharedArrayBuffer) {
    this.seq = new Int32Array(sab, CAM_OFF_SEQ, 1)
    this.cursorValid = new Uint32Array(sab, CAM_OFF_CURSOR_VALID, 1)
    this.centre = new Float64Array(sab, CAM_OFF_CENTRE, 2)
    this.frameTimeMs = new Float64Array(sab, CAM_OFF_FRAME_TIME_MS, 1)
    this.velocity = new Float32Array(sab, CAM_OFF_VELOCITY, 2)
    this.tilesAcross = new Float32Array(sab, CAM_OFF_TILES_ACROSS, 1)
    this.zoomRate = new Float32Array(sab, CAM_OFF_ZOOM_RATE, 1)
    this.halfExtentTiles = new Float32Array(sab, CAM_OFF_HALF_EXTENT_TILES, 2)
    this.dpr = new Float32Array(sab, CAM_OFF_DPR, 1)
    this.cursorTile = new Int32Array(sab, CAM_OFF_CURSOR_TILE, 2)
    this.bytes = new Uint8Array(sab, 0, CAMERA_BLOCK_BYTES)
    this.scratch = new Uint8Array(CAMERA_BLOCK_BYTES)
  }

  seqWord(): Int32Array {
    return this.seq
  }

  cursorValidView(): Uint32Array {
    return this.cursorValid
  }

  centreView(): Float64Array {
    return this.centre
  }

  frameTimeMsView(): Float64Array {
    return this.frameTimeMs
  }

  velocityView(): Float32Array {
    return this.velocity
  }

  tilesAcrossView(): Float32Array {
    return this.tilesAcross
  }

  zoomRateView(): Float32Array {
    return this.zoomRate
  }

  halfExtentTilesView(): Float32Array {
    return this.halfExtentTiles
  }

  dprView(): Float32Array {
    return this.dpr
  }

  cursorTileView(): Int32Array {
    return this.cursorTile
  }

  bytesView(): Uint8Array {
    return this.bytes
  }

  scratchView(): Uint8Array {
    return this.scratch
  }
}

/** Writer: main thread, once per rAF. Not concurrent with itself (single writer), so the seq word
 * only needs `Atomics` for the cross-thread fence, not mutual exclusion. */
export function writeCameraBlock(block: CameraBlockView, state: CameraState): void {
  Atomics.add(block.seqWord(), 0, 1) // begin: odd
  block.cursorValidView()[0] = state.cursorValid ? 1 : 0
  const centre = block.centreView()
  centre[0] = state.centreX
  centre[1] = state.centreY
  block.frameTimeMsView()[0] = state.frameTimeMs
  const velocity = block.velocityView()
  velocity[0] = state.velocityX
  velocity[1] = state.velocityY
  block.tilesAcrossView()[0] = state.tilesAcross
  block.zoomRateView()[0] = state.zoomRate
  const halfExtent = block.halfExtentTilesView()
  halfExtent[0] = state.halfExtentTilesX
  halfExtent[1] = state.halfExtentTilesY
  block.dprView()[0] = state.dpr
  const cursorTile = block.cursorTileView()
  cursorTile[0] = state.cursorTileX
  cursorTile[1] = state.cursorTileY
  Atomics.add(block.seqWord(), 0, 1) // end: even, published
}

/** Reader: copy-with-retry, up to 8 attempts (docs/plan/06-sab-primitives-and-workers.md, Planning
 * decisions "Seqlock reader rule"). Returns false, leaving `dstU8` untouched, only if every retry
 * raced the writer. */
export function readCameraBlockInto(
  block: CameraBlockView,
  dstU8: Uint8Array,
  dstOffset: number,
): boolean {
  const seq = block.seqWord()
  const bytes = block.bytesView()
  const scratch = block.scratchView()
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const s1 = Atomics.load(seq, 0)
    if ((s1 & 1) === 1) continue
    scratch.set(bytes) // TypedArray.set, not copyBytes: see sab/seqlock.ts on why the window matters
    const s2 = Atomics.load(seq, 0)
    if (s1 === s2) {
      dstU8.set(scratch, dstOffset)
      return true
    }
  }
  return false
}
