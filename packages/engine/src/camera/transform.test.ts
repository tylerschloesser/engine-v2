import { expect, test } from 'vitest'
import { CameraState } from './state.js'
import {
  halfExtentTiles,
  pxPerTile,
  screenToWorld,
  tileUnderPoint,
  worldToScreen,
} from './transform.js'

// A non-square viewport and an off-centre, non-integer point on purpose: at the viewport centre,
// or with a square viewport, a swapped axis or a halved/doubled `tilesPerPx` all agree with the
// correct formula (docs/plan/11-camera-and-input.md's own warning, from M09b's texel-centre
// lesson). `widthPx` (1600) is the long axis here, so `tilesAcross` (20) maps to it, not `heightPx`
// (800): a formula that used `heightPx` for the long axis, or averaged the two axes, disagrees with
// this expectation.
const viewport = { widthPx: 1600, heightPx: 800 }

test('transform: roundtrip', () => {
  const state = new CameraState()
  state.centreX = 137.25
  state.centreY = -42.5
  state.tilesAcross = 20

  const screen = { x: 0, y: 0 }
  worldToScreen(state, viewport, 210.125, -9.75, screen)
  // pxPerTile = max(1600, 800) / 20 = 80; screenX = 800 + (210.125 - 137.25) * 80 = 6630
  expect(screen.x).toBeCloseTo(6630, 9)
  // screenY = 400 + (-9.75 - -42.5) * 80 = 400 + 32.75 * 80 = 3020
  expect(screen.y).toBeCloseTo(3020, 9)

  const world = { x: 0, y: 0 }
  screenToWorld(state, viewport, screen.x, screen.y, world)
  expect(world.x).toBeCloseTo(210.125, 9)
  expect(world.y).toBeCloseTo(-9.75, 9)
})

test('transform: half extent tiles is asymmetric for a non-square viewport', () => {
  const state = new CameraState()
  state.tilesAcross = 20
  const half = { x: 0, y: 0 }
  halfExtentTiles(state, viewport, half)
  // pxPerTile = 80; halfExtentTilesX = 1600 / (2*80) = 10 (half of tilesAcross, the long axis);
  // halfExtentTilesY = 800 / (2*80) = 5 (half as many tiles visible on the short axis).
  expect(half.x).toBeCloseTo(10, 9)
  expect(half.y).toBeCloseTo(5, 9)
  expect(pxPerTile(state, viewport)).toBeCloseTo(80, 9)
})

test('transform: tile under point splits into tile and fraction', () => {
  const state = new CameraState()
  state.centreX = 0
  state.centreY = 0
  state.tilesAcross = 20 // pxPerTile = 80
  const out = { tileX: 0, tileY: 0, fracX: 0, fracY: 0 }
  // tilesPerPx = 1/80 = 0.0125; world = centre + (screen - halfViewport) * tilesPerPx.
  // worldX = 0 + (887 - 800) * 0.0125 = 1.0875 (screen 887 relative to a 1600-wide, centred
  // viewport); worldY = 0 + (387 - 400) * 0.0125 = -0.1625 (screen 387).
  tileUnderPoint(state, viewport, 800 + 87, 400 - 13, out)
  expect(out.tileX).toBe(1)
  expect(out.fracX).toBeCloseTo(0.0875, 9)
  expect(out.tileY).toBe(-1)
  expect(out.fracY).toBeCloseTo(0.8375, 9)
})
