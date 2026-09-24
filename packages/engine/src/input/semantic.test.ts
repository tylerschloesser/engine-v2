import { expect, test } from 'vitest'
import { CameraState } from '../camera/state.js'
import { createRing } from '../sab/ring.js'
import { KeyState } from './keys.js'
import {
  PointerSlots,
  recordMouseHover,
  recordPointerDown,
  recordPointerMove,
  recordPointerUp,
} from './pointers.js'
import { INPUT_RECORD_BYTES } from './record.js'
import { createSemanticRecognizer, type InputEventTs } from './semantic.js'
import { WheelState } from './wheel.js'

// Same wide, non-square viewport `camera.test.ts` uses, for the same reason (docs/plan/
// 11-camera-and-input.md's own warning against a probe point where a swapped axis or a halved/
// doubled formula would still agree): `pxPerTile = 1600 / 20 = 80`.
const viewport = { widthPx: 1600, heightPx: 800 }

function newRecognizer(pick?: Parameters<typeof createSemanticRecognizer>[1]) {
  return createSemanticRecognizer(createRing(INPUT_RECORD_BYTES + 8, 64), pick)
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

// Gate round 1 (M18): a real, pre-M18 defect (`input/pointers.ts`'s `PointerSlot.active`,
// `input/semantic.ts`'s `recognize` -- both from M11) -- a press *and* release landing between two
// `recognize()` calls was never observed as an `active` transition at all, so no tap ever fired.
// A macOS trackpad tap-to-click and a fast phone tap both release well within one ~16ms rAF gap.
test('semantic: press and release inside one frame still taps', () => {
  const state = new CameraState()
  state.tilesAcross = 20
  // `pick_id` from the *down* position, not the up position (a coordinator ruling): the up
  // position here (803) deliberately picks a different id than the down position (800) would, so
  // this assertion fails if the quick-tap path ever reads the wrong one.
  const recognizer = newRecognizer({ at: (x) => (x === 800 ? 77 : 0) })
  const bundle = newBundle()

  const taps: InputEventTs[] = []
  recognizer.on('tap', (e) => taps.push({ ...e }))

  // Down then up, both *before* the recognizer's first `recognize()` call for this press -- it
  // never observes `active === true`.
  recordPointerDown(bundle.pointers, 1, 800, 400, 0)
  recordPointerUp(bundle.pointers, 1, 803, 400, 10) // 3px away, under the 8px tap radius
  recognizer.recognize(bundle, state, viewport, 16)

  expect(taps.length).toBe(1)
  expect(taps[0]?.tileX).toBe(0) // 800px, dead centre of the 1600px-wide viewport -> world tile 0
  expect(taps[0]?.tileY).toBe(0)
  expect(taps[0]?.pickId).toBe(77) // from the down position (800), not the up position (803)

  // A second full press+release on the same slot, also inside one frame gap, before the next
  // `recognize()` call: overwrites the latch: one tap surfaces (the second cycle's own data), not
  // two (`PointerSlot.quickTap`'s own doc comment: "documented, acceptable").
  recordPointerDown(bundle.pointers, 1, 900, 400, 20)
  recordPointerUp(bundle.pointers, 1, 900, 400, 30)
  recordPointerDown(bundle.pointers, 1, 950, 400, 40)
  recordPointerUp(bundle.pointers, 1, 950, 400, 50)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(taps.length).toBe(2) // one more, not two more
  expect(taps[1]?.pickId).toBe(0) // the second cycle's own down position (950), not in the pick map

  // A press that moves past the tap radius before releasing, all inside one frame gap: no tap (the
  // same "moved past threshold" rule a normal tap already follows).
  recordPointerDown(bundle.pointers, 1, 800, 400, 60)
  recordPointerUp(bundle.pointers, 1, 820, 400, 70) // 20px, over the 8px radius
  recognizer.recognize(bundle, state, viewport, 16)
  expect(taps.length).toBe(2) // unchanged

  // A press that reaches the recognizer normally (observed active before it releases) is
  // unaffected by any of this -- the ordinary multi-call path, still a single tap.
  recordPointerDown(bundle.pointers, 1, 800, 400, 80)
  recognizer.recognize(bundle, state, viewport, 16)
  recordPointerUp(bundle.pointers, 1, 800, 400, 96)
  recognizer.recognize(bundle, state, viewport, 16)
  expect(taps.length).toBe(3)
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

test('semantic: hover from an idle mouse move, no press (mandatory gap #2)', () => {
  // A real desktop mouse that only moves, never presses -- `recordPointerDown` is never called at
  // all, so no `PointerSlot` is ever active for it; before M11 step 6 this produced zero hover
  // events and never touched `cameraState.cursorTile*` (Deviations of the 4-5 range's own "real
  // gap"). `recordMouseHover` is what a real `installPointerListeners`'s `onMove` now calls
  // unconditionally for a mouse-kind event, active slot or not.
  const state = new CameraState()
  state.tilesAcross = 20
  const recognizer = newRecognizer()
  const bundle = newBundle()

  let hovers = 0
  recognizer.on('hover', () => {
    hovers++
  })

  expect(state.cursorValid).toBe(false) // nothing has moved yet

  recordMouseHover(bundle.pointers, 820, 400) // worldX = 0.25 -> tile 0
  recognizer.recognize(bundle, state, viewport, 16)
  expect(hovers).toBe(1)
  expect(state.cursorValid).toBe(true)
  expect(state.cursorTileX).toBe(0)

  recordMouseHover(bundle.pointers, 900, 400) // worldX = 1.25 -> tile 1
  recognizer.recognize(bundle, state, viewport, 16)
  expect(hovers).toBe(2)
  expect(state.cursorTileX).toBe(1)

  // Never activates a `PointerSlot` (camera.ts's own pan logic never sees this): a bare mouse move
  // must not be mistaken for a drag.
  expect(bundle.pointers.slots[0].active).toBe(false)
  expect(bundle.pointers.slots[1].active).toBe(false)
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
