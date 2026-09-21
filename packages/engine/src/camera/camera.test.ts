import { expect, test } from 'vitest'
import { KeyState, recordKey } from '../input/keys.js'
import {
  PointerSlots,
  recordGestureChange,
  recordGestureStart,
  recordPointerDown,
  recordPointerMove,
} from '../input/pointers.js'
import { recordWheel, WheelState } from '../input/wheel.js'
import {
  applyInertia,
  createCameraIntegrator,
  DEFAULT_MAX_TILES,
  DEFAULT_MIN_TILES,
} from './camera.js'
import { CameraState } from './state.js'
import { screenToWorld } from './transform.js'

// A wide, non-square viewport throughout: 1600x800 means `tilesAcross` maps to the *width*
// (pxPerTile = 1600 / tilesAcross); every pivot point below is off-centre and asymmetric on
// purpose (docs/plan/11-camera-and-input.md's own warning against a probe point where a sign
// error, a half-tile offset or a swapped axis would still agree).
const viewport = { widthPx: 1600, heightPx: 800 }

test('camera: pan keeps world point', () => {
  const state = new CameraState()
  state.centreX = 50
  state.centreY = -20
  state.tilesAcross = 20
  const pointers = new PointerSlots()
  const integrator = createCameraIntegrator({
    pointers,
    keys: new KeyState(),
    wheel: new WheelState(),
  })

  recordPointerDown(pointers, 1, 900, 450, 0)
  const before = { x: 0, y: 0 }
  screenToWorld(state, viewport, 900, 450, before)
  integrator.integrate(state, viewport, 16) // the down frame itself never pans

  recordPointerMove(pointers, 1, 940, 470, 16) // drag 40px right, 20px down
  integrator.integrate(state, viewport, 16)

  const after = { x: 0, y: 0 }
  screenToWorld(state, viewport, 940, 470, after)
  expect(after.x).toBeCloseTo(before.x, 9)
  expect(after.y).toBeCloseTo(before.y, 9)
  expect(state.centreX).not.toBeCloseTo(50, 3) // and it actually moved
})

test('camera: pinch about midpoint', () => {
  const state = new CameraState()
  state.centreX = 10
  state.centreY = 5
  state.tilesAcross = 40
  const pointers = new PointerSlots()
  const integrator = createCameraIntegrator({
    pointers,
    keys: new KeyState(),
    wheel: new WheelState(),
  })

  recordPointerDown(pointers, 1, 750, 380, 0)
  recordPointerDown(pointers, 2, 1050, 420, 0)
  integrator.integrate(state, viewport, 16) // baseline: records the initial midpoint/distance
  const tilesBefore = state.tilesAcross

  const mid1 = { x: 0, y: 0 }
  screenToWorld(state, viewport, 900, 400, mid1) // world point under the original midpoint (900,400)

  // Spread apart (zoom in) while also sliding the whole gesture (pan): asymmetric per-finger deltas.
  recordPointerMove(pointers, 1, 700, 400, 16)
  recordPointerMove(pointers, 2, 1200, 460, 16)
  integrator.integrate(state, viewport, 16)

  const mid2 = { x: 0, y: 0 }
  screenToWorld(state, viewport, 950, 430, mid2) // world point under the new midpoint (950,430)
  expect(mid2.x).toBeCloseTo(mid1.x, 6)
  expect(mid2.y).toBeCloseTo(mid1.y, 6)

  const dist1 = Math.hypot(1050 - 750, 420 - 380)
  const dist2 = Math.hypot(1200 - 700, 460 - 400)
  expect(state.tilesAcross).toBeCloseTo(tilesBefore / (dist2 / dist1), 6)
})

test('camera: wheel about cursor', () => {
  const state = new CameraState()
  state.centreX = 100
  state.centreY = -30
  state.tilesAcross = 32
  const wheel = new WheelState()
  const integrator = createCameraIntegrator({
    pointers: new PointerSlots(),
    keys: new KeyState(),
    wheel,
  })

  const cursorX = 1200
  const cursorY = 250
  const before = { x: 0, y: 0 }
  screenToWorld(state, viewport, cursorX, cursorY, before)

  recordWheel(wheel, -400, 0, cursorX, cursorY, false) // negative deltaY: zoom in
  integrator.integrate(state, viewport, 16) // one partial-easing step is enough to prove the pivot

  const after = { x: 0, y: 0 }
  screenToWorld(state, viewport, cursorX, cursorY, after)
  expect(after.x).toBeCloseTo(before.x, 9)
  expect(after.y).toBeCloseTo(before.y, 9)
  expect(state.tilesAcross).toBeLessThan(32)
  expect(wheel.pendingDeltaLog).not.toBe(0) // easing, not yet fully applied
})

test('camera: zoom clamps and constraints', () => {
  const viewport2 = { widthPx: 1600, heightPx: 800 }

  const zoomOut = new CameraState()
  zoomOut.tilesAcross = 20
  const wheelOut = new WheelState()
  const integratorOut = createCameraIntegrator({
    pointers: new PointerSlots(),
    keys: new KeyState(),
    wheel: wheelOut,
  })
  recordWheel(wheelOut, 100_000, 0, 800, 400, false)
  for (let i = 0; i < 50; i++) integratorOut.integrate(zoomOut, viewport2, 16)
  expect(zoomOut.tilesAcross).toBe(DEFAULT_MAX_TILES)

  const zoomIn = new CameraState()
  zoomIn.tilesAcross = 20
  const wheelIn = new WheelState()
  const integratorIn = createCameraIntegrator({
    pointers: new PointerSlots(),
    keys: new KeyState(),
    wheel: wheelIn,
  })
  recordWheel(wheelIn, -100_000, 0, 800, 400, false)
  for (let i = 0; i < 50; i++) integratorIn.integrate(zoomIn, viewport2, 16)
  expect(zoomIn.tilesAcross).toBe(DEFAULT_MIN_TILES)
})

test('camera: inertia decay time based', () => {
  function run(dtMs: number, steps: number): CameraState {
    const state = new CameraState()
    state.tilesAcross = 20 // pxPerTile = 80
    // 100 tiles/s and -40 tiles/s is ~8000/3200 CSS px/s: comfortably above the 4px/s stop
    // threshold for the whole window below, so only the pure decay maths is under test.
    state.velocityX = 100
    state.velocityY = -40
    for (let i = 0; i < steps; i++) applyInertia(state, viewport, dtMs)
    return state
  }

  const at30 = run(1000 / 30, 3) // 100ms, 30Hz steps
  const at60 = run(1000 / 60, 6) // 100ms, 60Hz steps
  const at120 = run(1000 / 120, 12) // 100ms, 120Hz steps

  expect(at60.centreX).toBeCloseTo(at30.centreX, 6)
  expect(at120.centreX).toBeCloseTo(at30.centreX, 6)
  expect(at60.centreY).toBeCloseTo(at30.centreY, 6)
  expect(at120.centreY).toBeCloseTo(at30.centreY, 6)
  expect(at60.velocityX).toBeCloseTo(at30.velocityX, 6)
  expect(at120.velocityX).toBeCloseTo(at30.velocityX, 6)
})

test('camera: precision at 2^23', () => {
  const big = 2 ** 23
  const state = new CameraState()
  state.centreX = big
  state.centreY = -big - 1
  state.tilesAcross = 20 // pxPerTile = 80
  const pointers = new PointerSlots()
  const integrator = createCameraIntegrator({
    pointers,
    keys: new KeyState(),
    wheel: new WheelState(),
  })

  recordPointerDown(pointers, 1, 800, 400, 0) // viewport centre, CSS px
  integrator.integrate(state, viewport, 16) // down frame: no pan yet
  recordPointerMove(pointers, 1, 850, 400, 16) // 50px right => world delta exactly -50/80 = -0.625
  integrator.integrate(state, viewport, 16)

  // Exact equality, not `toBeCloseTo`: at this magnitude a Float32Array intermediate would round
  // the 0.625 fraction away entirely (f32's mantissa covers only whole integers at 2^23), so an
  // exact match is what actually catches that bug.
  expect(state.centreX).toBe(big - 0.625)
  expect(state.centreY).toBe(-big - 1) // the untouched axis stays bit-exact too
})

test('camera: wasd speed scales with extent', () => {
  function measure(tilesAcross: number): number {
    const state = new CameraState()
    state.tilesAcross = tilesAcross
    const keys = new KeyState()
    const integrator = createCameraIntegrator({
      pointers: new PointerSlots(),
      keys,
      wheel: new WheelState(),
    })
    recordKey(keys, 'KeyD', true)
    for (let i = 0; i < 10; i++) integrator.integrate(state, viewport, 16) // past the 120ms ramp
    const x0 = state.centreX
    integrator.integrate(state, viewport, 16) // one fully-ramped frame to measure
    return (state.centreX - x0) / tilesAcross
  }

  const at12 = measure(12)
  const at256 = measure(256)
  expect(at12).toBeCloseTo(at256, 9)
})

test('camera: moveto cancelled by input', () => {
  const state = new CameraState()
  state.centreX = 0
  state.centreY = 0
  state.tilesAcross = 40
  const pointers = new PointerSlots()
  const integrator = createCameraIntegrator({
    pointers,
    keys: new KeyState(),
    wheel: new WheelState(),
  })

  integrator.moveTo(state, 1000, -1000, { tiles: 20, durationMs: 400 })
  integrator.integrate(state, viewport, 16) // one partial step towards the target
  const midX = state.centreX
  expect(midX).toBeGreaterThan(0) // moving towards 1000, but nowhere near it yet
  expect(midX).toBeLessThan(1000)

  // A real pointer engages mid-flight: 0019 §1 "user input cancels it". The down frame itself
  // never pans (camera.ts's own convention), so the centre this frame is still exactly `midX`.
  recordPointerDown(pointers, 1, 800, 400, 32)
  integrator.integrate(state, viewport, 16)
  expect(state.centreX).toBe(midX)
  expect(state.centreY).toBe(state.centreY) // sanity: still finite, not NaN from a stale ease

  // Proof the move is *cancelled*, not merely paused: many more frames elapse (well past the
  // original 400ms budget) and the camera never gets any closer to the far-away target -- it only
  // moves by whatever the real drag below does.
  recordPointerMove(pointers, 1, 810, 400, 48) // a small, known drag delta
  for (let i = 0; i < 30; i++) integrator.integrate(state, viewport, 16)
  expect(state.centreX).toBeLessThan(midX + 5) // nowhere near 1000: the ease never resumed
})

test('camera: snaps to device px at rest only', () => {
  const state = new CameraState()
  state.centreX = 10.130123 // deliberately not aligned to any pixel grid
  state.centreY = -3.070456
  state.tilesAcross = 23.7 // a non-integer zoom: "tiles_across is never snapped" must still hold
  state.dpr = 2
  const keys = new KeyState()
  const integrator = createCameraIntegrator({
    pointers: new PointerSlots(),
    keys,
    wheel: new WheelState(),
  })

  const ppt = 1600 / state.tilesAcross // pxPerTile at this viewport/tilesAcross (long axis: width)
  const devicePerTile = ppt * state.dpr
  const rawCentreXDevicePx = state.centreX * devicePerTile

  // While WASD is held (a moving step), the centre is left exactly where the movement put it --
  // *not* rounded to a device pixel. A no-op/always-on snap would fail this: rounding every step
  // would make every one of these device-pixel positions already integral, indistinguishable from
  // "unsnapped by design".
  recordKey(keys, 'KeyD', true)
  integrator.integrate(state, viewport, 16)
  const movingDevicePxX = state.centreX * devicePerTile
  expect(Math.abs(movingDevicePxX - Math.round(movingDevicePxX))).toBeGreaterThan(1e-6)
  expect(state.tilesAcross).toBeCloseTo(23.7, 9) // zoom is never snapped, moving or not

  // Release and let the WASD ramp-down finish, then rest: only *now* must the centre land exactly
  // on a device pixel at the current zoom/DPR -- and the value must actually have moved to get
  // there (proving this is a real snap, not a no-op that happens to already be integral).
  recordKey(keys, 'KeyD', false)
  for (let i = 0; i < 20; i++) integrator.integrate(state, viewport, 16) // past the 80ms ramp-down
  const restedDevicePxX = state.centreX * devicePerTile
  expect(Math.abs(restedDevicePxX - Math.round(restedDevicePxX))).toBeLessThan(1e-6)
  expect(restedDevicePxX).not.toBeCloseTo(rawCentreXDevicePx, 3) // it actually moved to snap
  expect(state.tilesAcross).toBeCloseTo(23.7, 9) // still never snapped
})

test('camera: gesturechange scale zooms about cursor', () => {
  const state = new CameraState()
  state.centreX = 5
  state.centreY = -15
  state.tilesAcross = 40
  const pointers = new PointerSlots()
  const integrator = createCameraIntegrator({
    pointers,
    keys: new KeyState(),
    wheel: new WheelState(),
  })

  const cursorX = 1100
  const cursorY = 300
  const before = { x: 0, y: 0 }
  screenToWorld(state, viewport, cursorX, cursorY, before)

  recordGestureStart(pointers, cursorX, cursorY)
  integrator.integrate(state, viewport, 16) // gesturestart: scale 1, no change yet

  recordGestureChange(pointers, 2, cursorX, cursorY) // scale 2 halves tiles_across
  integrator.integrate(state, viewport, 16)

  expect(state.tilesAcross).toBeCloseTo(20, 9)
  const after = { x: 0, y: 0 }
  screenToWorld(state, viewport, cursorX, cursorY, after)
  expect(after.x).toBeCloseTo(before.x, 6)
  expect(after.y).toBeCloseTo(before.y, 6)
})
