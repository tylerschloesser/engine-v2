import { expect, test } from 'vitest'
import { CameraState } from '../camera/state.js'
import { createRing } from '../sab/ring.js'
import { KeyState } from './keys.js'
import { PointerSlots, recordPointerDown, recordPointerMove, recordPointerUp } from './pointers.js'
import { INPUT_RECORD_BYTES } from './record.js'
import { createSemanticRecognizer, type InputEventTs } from './semantic.js'
import { WheelState } from './wheel.js'

// Same wide, non-square viewport `camera.test.ts` uses, for the same reason (docs/plan/
// 11-camera-and-input.md's own warning against a probe point where a swapped axis or a halved/
// doubled formula would still agree): `pxPerTile = 1600 / 20 = 80`.
const viewport = { widthPx: 1600, heightPx: 800 }

function newRecognizer() {
  return createSemanticRecognizer(createRing(INPUT_RECORD_BYTES + 8, 64))
}

function newBundle() {
  return { pointers: new PointerSlots(), keys: new KeyState(), wheel: new WheelState() }
}

test('semantic: tap vs drag thresholds', () => {
  const state = new CameraState()
  state.tilesAcross = 20
  const recognizer = newRecognizer()
  recognizer.setMode('tool') // so a drag has something to contrast against
  const bundle = newBundle()

  const taps: InputEventTs[] = []
  const drags: string[] = []
  recognizer.on('tap', (e) => taps.push({ ...e }))
  recognizer.on('dragstart', () => drags.push('start'))
  recognizer.on('drag', () => drags.push('drag'))
  recognizer.on('dragend', () => drags.push('end'))

  // Small movement (3px, under the 8px radius), quick release: a tap, no drag events.
  recordPointerDown(bundle.pointers, 1, 800, 400, 0)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerMove(bundle.pointers, 1, 803, 400, 16)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerUp(bundle.pointers, 1, 803, 400, 32)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(taps.length).toBe(1)
  expect(drags).toEqual([])

  // Large movement (12px, over the threshold): a drag, no tap.
  recordPointerDown(bundle.pointers, 2, 800, 400, 100)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerMove(bundle.pointers, 2, 812, 400, 116)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerMove(bundle.pointers, 2, 824, 400, 132)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerUp(bundle.pointers, 2, 824, 400, 148)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(taps.length).toBe(1) // unchanged
  expect(drags).toEqual(['start', 'drag', 'end'])
})

test('semantic: longpress', () => {
  const state = new CameraState()
  state.tilesAcross = 20
  const recognizer = newRecognizer()
  const bundle = newBundle()

  let longpresses = 0
  let taps = 0
  recognizer.on('longpress', () => {
    longpresses++
  })
  recognizer.on('tap', () => {
    taps++
  })

  recordPointerDown(bundle.pointers, 1, 800, 400, 0)
  recognizer.recognize(bundle, state, viewport, 16) // the down frame itself starts the timer at 0

  // Hold in place (no movement) until past the 500ms threshold.
  let elapsed = 0
  while (elapsed < 600) {
    recognizer.recognize(bundle, state, viewport, 50)
    elapsed += 50
  }
  expect(longpresses).toBe(1)

  // Continuing to hold doesn't fire it again.
  recognizer.recognize(bundle, state, viewport, 50)
  expect(longpresses).toBe(1)

  // Releasing afterwards is not also a tap: a longpress already fired for this press.
  recordPointerUp(bundle.pointers, 1, 800, 400, 700)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(taps).toBe(0)
})

test('semantic: hover only on change', () => {
  const state = new CameraState()
  state.tilesAcross = 20
  const recognizer = newRecognizer()
  const bundle = newBundle()

  let hovers = 0
  recognizer.on('hover', () => {
    hovers++
  })

  // 820 -> worldX = (820 - 800) / 80 = 0.25 -> tile 0 (an active mouse pointer, per this range's
  // own recognition model -- see semantic.ts's own doc comment on the real "idle hover" gap).
  recordPointerDown(bundle.pointers, 1, 820, 400, 0)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(hovers).toBe(1) // the first hover always fires (tile changes from "never set")

  // 830 -> worldX = 0.375 -> still tile 0: no new hover.
  recordPointerMove(bundle.pointers, 1, 830, 400, 16)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(hovers).toBe(1)

  // 900 -> worldX = 1.25 -> tile 1: a new hover.
  recordPointerMove(bundle.pointers, 1, 900, 400, 32)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(hovers).toBe(2)
  expect(state.cursorTileX).toBe(1)
  expect(state.cursorValid).toBe(true)
})

test('semantic: tool mode drag events', () => {
  const state = new CameraState()
  state.tilesAcross = 20
  const recognizer = newRecognizer()
  const bundle = newBundle()

  const drags: string[] = []
  recognizer.on('dragstart', () => drags.push('start'))
  recognizer.on('drag', () => drags.push('drag'))
  recognizer.on('dragend', () => drags.push('end'))

  recognizer.setMode('tool')

  // One-pointer drag: dragstart, drag, dragend.
  recordPointerDown(bundle.pointers, 1, 800, 400, 0)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerMove(bundle.pointers, 1, 812, 400, 16)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerMove(bundle.pointers, 1, 824, 400, 32)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerUp(bundle.pointers, 1, 824, 400, 48)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(drags).toEqual(['start', 'drag', 'end'])
  const centreAfterOnePointer = state.centreX

  // Two pointers (a real pinch/pan gesture, start to finish, each step the same simulated frame):
  // still pans and zooms -- that's `camera.ts`'s job, not tested here -- but no drag* events.
  drags.length = 0
  recordPointerDown(bundle.pointers, 2, 700, 400, 100)
  recordPointerDown(bundle.pointers, 3, 900, 400, 100)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerMove(bundle.pointers, 2, 680, 400, 116)
  recordPointerMove(bundle.pointers, 3, 920, 400, 116)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerUp(bundle.pointers, 2, 680, 400, 132)
  recordPointerUp(bundle.pointers, 3, 920, 400, 132)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(drags).toEqual([])

  // Back in camera mode: the same one-pointer drag emits nothing (leaves the centre where this
  // recognizer left it -- it never touches `centreX`/`centreY` itself, camera-mode or not).
  drags.length = 0
  recognizer.setMode('camera')
  recordPointerDown(bundle.pointers, 4, 800, 400, 200)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerMove(bundle.pointers, 4, 824, 400, 216)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerUp(bundle.pointers, 4, 824, 400, 232)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(drags).toEqual([])
  expect(state.centreX).toBe(centreAfterOnePointer)
})
