import { expect, test } from 'vitest'
import {
  CAM_OFF_CENTRE,
  CAM_OFF_CURSOR_TILE,
  CAM_OFF_CURSOR_VALID,
  CAM_OFF_DPR,
  CAM_OFF_FRAME_TIME_MS,
  CAM_OFF_HALF_EXTENT_TILES,
  CAM_OFF_TILES_ACROSS,
  CAM_OFF_VELOCITY,
  CAM_OFF_VIEWPORT_PX,
  CAM_OFF_ZOOM_RATE,
  CAMERA_BLOCK_BYTES,
  CameraBlockView,
  createCameraBlock,
  readCameraBlockInto,
  writeCameraBlock,
} from './block.js'
import { CameraState } from './state.js'

test('camera_block.roundtrip', () => {
  const sab = createCameraBlock()
  const block = new CameraBlockView(sab)
  const state = new CameraState()

  // f64 centre, exact at +/-2^23: an f32 would already have lost precision by here (its exact
  // integer range ends at 2^24, but f32 rounds many values below that; 2^23 +/- 1 is chosen so a
  // silent f32 downcast would be caught).
  const big = 2 ** 23
  state.centreX = big
  state.centreY = -big - 1
  state.velocityX = 1.5
  state.velocityY = -2.5
  state.tilesAcross = 24
  state.zoomRate = 0.125
  state.halfExtentTilesX = 12
  state.halfExtentTilesY = 6.5
  state.dpr = 2
  state.frameTimeMs = 16.6667
  state.cursorTileX = -7
  state.cursorTileY = 1000
  state.cursorValid = true
  state.viewportPxW = 1920
  state.viewportPxH = 1080.5

  writeCameraBlock(block, state)

  const dst = new Uint8Array(CAMERA_BLOCK_BYTES)
  expect(readCameraBlockInto(block, dst, 0)).toBe(true)

  const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength)
  expect(view.getFloat64(CAM_OFF_CENTRE, true)).toBe(big)
  expect(view.getFloat64(CAM_OFF_CENTRE + 8, true)).toBe(-big - 1)
  expect(view.getUint32(CAM_OFF_CURSOR_VALID, true)).toBe(1)
  expect(view.getFloat64(CAM_OFF_FRAME_TIME_MS, true)).toBeCloseTo(16.6667, 4)
  expect(view.getFloat32(CAM_OFF_VELOCITY, true)).toBeCloseTo(1.5, 5)
  expect(view.getFloat32(CAM_OFF_VELOCITY + 4, true)).toBeCloseTo(-2.5, 5)
  expect(view.getFloat32(CAM_OFF_TILES_ACROSS, true)).toBe(24)
  expect(view.getFloat32(CAM_OFF_ZOOM_RATE, true)).toBe(0.125)
  expect(view.getFloat32(CAM_OFF_HALF_EXTENT_TILES, true)).toBe(12)
  expect(view.getFloat32(CAM_OFF_HALF_EXTENT_TILES + 4, true)).toBe(6.5)
  expect(view.getFloat32(CAM_OFF_DPR, true)).toBe(2)
  expect(view.getInt32(CAM_OFF_CURSOR_TILE, true)).toBe(-7)
  expect(view.getInt32(CAM_OFF_CURSOR_TILE + 4, true)).toBe(1000)
  expect(view.getFloat32(CAM_OFF_VIEWPORT_PX, true)).toBe(1920)
  expect(view.getFloat32(CAM_OFF_VIEWPORT_PX + 4, true)).toBeCloseTo(1080.5, 5)
})

test('camera_block.cursor_invalid_roundtrips_zero', () => {
  const sab = createCameraBlock()
  const block = new CameraBlockView(sab)
  const state = new CameraState()
  state.cursorValid = false

  writeCameraBlock(block, state)
  const dst = new Uint8Array(CAMERA_BLOCK_BYTES)
  expect(readCameraBlockInto(block, dst, 0)).toBe(true)
  const view = new DataView(dst.buffer, dst.byteOffset, dst.byteLength)
  expect(view.getUint32(CAM_OFF_CURSOR_VALID, true)).toBe(0)
})
