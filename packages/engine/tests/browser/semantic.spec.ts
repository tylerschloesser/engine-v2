// `input: events reach wasm` (docs/plan/11-camera-and-input.md, Tests added): the whole
// `client.input.recognize` -> `inputRing` -> client worker drain -> `on_input` -> `InputQueue` path
// against a real `fx-terrain` client (`semantic.html`/`semantic.ts`). The test export is `on_input`
// itself, called with `len=0` through the parked-only `test-call` channel: nothing new to decode,
// but it still reports the queue's *current* length and last tile as a side effect (the same
// "whichever export ran last owns `Result`'s content" idiom as `gen_take`/`client_gen_stats`).
import { expect, type Page, test } from '@playwright/test'
import { openPage } from './support/page.js'

type InputStats = { queueLen: number; tileX: number; tileY: number }
type InputEventType = 'tap' | 'hover' | 'longpress' | 'dragstart' | 'drag' | 'dragend'

declare global {
  interface Window {
    __semCreateClient?: () => void
    __semReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __semSetup?: (viewport: { widthPx: number; heightPx: number }) => void
    __semInjectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
      pointerType?: 'mouse' | 'touch' | 'pen',
    ) => void
    __semRecognize?: (dtMs: number) => void
    __semStepFrame?: (dtMs: number) => void
    __semReadInputStats?: () => Promise<InputStats>
    __rcCreate?: (opts?: { cameraKey?: string; overlayMode?: 'properties' | 'translate' }) => void
    __rcReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __rcRead?: () => { centreX: number; centreY: number; tilesAcross: number }
    __rcTick?: (dtMs: number) => void
    __rcSuspend?: () => void
    __rcResume?: () => void
    __rcCount?: (type: InputEventType) => number
    __rcInjectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
    ) => void
    __rcKeysMask?: () => number
    __rcMountWidget?: (x: number, y: number, w: number, h: number) => void
  }
}

// Shared by every `real-camera.html` test below (docs/plan/11-camera-and-input.md, Order of work
// step 6: `input.suspend_resume`, `input.keyboard_focus_rules`, `input.dom_path_pan_and_tap`,
// `input.widget_blocks_canvas`, `input.drag_survives_passing_under_widget`).
async function createReal(page: Page): Promise<void> {
  await openPage(page, '/real-camera.html')
  await page.evaluate(() => window.__rcCreate?.())
  const r = await page.evaluate(() => window.__rcReady?.())
  expect(r?.ok, JSON.stringify(r)).toBe(true)
}
function tick(page: Page, dtMs: number): Promise<void> {
  return page.evaluate((dt) => window.__rcTick?.(dt), dtMs)
}
type CameraRead = { centreX: number; centreY: number; tilesAcross: number }
function read(page: Page): Promise<CameraRead> {
  return page.evaluate(() => window.__rcRead?.()) as Promise<CameraRead>
}
function count(page: Page, type: InputEventType): Promise<number> {
  return page.evaluate((t) => window.__rcCount?.(t), type) as Promise<number>
}
function keysMask(page: Page): Promise<number> {
  return page.evaluate(() => window.__rcKeysMask?.()) as Promise<number>
}

test('input: events reach wasm', async ({ page }) => {
  await openPage(page, '/semantic.html')
  await page.evaluate(() => window.__semCreateClient?.())
  const ready = await page.evaluate(() => window.__semReady?.())
  expect(ready?.ok, JSON.stringify(ready)).toBe(true)

  // 200x200 viewport, default `CameraState` (centre (0,0), tilesAcross 12): pxPerTile = 200/12,
  // so a tap at the viewport centre lands on tile (0, 0) and a tap 64px right of it lands on tile
  // (3, 0) -- a predictable, nonzero *last* tile, not just a nonzero count.
  await page.evaluate(() => window.__semSetup?.({ widthPx: 200, heightPx: 200 }))

  // Touch, not mouse (the default): a mouse tap also emits `hover` (0019 §4: "mouse only"), which
  // would make this test's own event count depend on that separate feature instead of proving the
  // ring -> `Rx` -> `on_input` path with a stable count.
  //
  // Tap 1: down then up within the tap radius/time -- recognized on the very next `recognize()`
  // call (no `stepFrame` between them, so nothing is drained/decoded until both taps are queued).
  await page.evaluate(() => window.__semInjectPointer?.('down', 1, 100, 100, 0, 'touch'))
  await page.evaluate(() => window.__semRecognize?.(16))
  await page.evaluate(() => window.__semInjectPointer?.('up', 1, 100, 100, 16, 'touch'))
  await page.evaluate(() => window.__semRecognize?.(16))

  // Tap 2, at a different tile.
  await page.evaluate(() => window.__semInjectPointer?.('down', 2, 164, 100, 32, 'touch'))
  await page.evaluate(() => window.__semRecognize?.(16))
  await page.evaluate(() => window.__semInjectPointer?.('up', 2, 164, 100, 48, 'touch'))
  await page.evaluate(() => window.__semRecognize?.(16))

  // One wake: the client worker's own `body()` drains both records from `inputRing` into `Rx` and
  // calls `on_input` once, decoding both into `InputQueue` before anything clears it.
  await page.evaluate(() => window.__semStepFrame?.(16))

  const stats = await page.evaluate(() => window.__semReadInputStats?.())
  expect(stats?.queueLen).toBe(2)
  expect(stats?.tileX).toBe(3)
  expect(stats?.tileY).toBe(0)
})

// `input: suspend resume` (docs/plan/11-camera-and-input.md, Tests added): `client.input.suspend()`
// stops recognition entirely (`semantic.ts`'s own `recognize()`: `if (suspended) return`, before any
// bookkeeping is even touched), not just event delivery -- a down/up cycle injected while suspended
// must leave no trace for `resume()` to pick up later.
test('input: suspend resume', async ({ page }) => {
  await createReal(page)

  await page.evaluate(() => window.__rcInjectPointer?.('down', 1, 50, 50, 0))
  await tick(page, 16)
  await page.evaluate(() => window.__rcInjectPointer?.('up', 1, 50, 50, 16))
  await tick(page, 16)
  expect(await count(page, 'tap')).toBe(1)

  await page.evaluate(() => window.__rcSuspend?.())
  await page.evaluate(() => window.__rcInjectPointer?.('down', 2, 60, 60, 32))
  await tick(page, 16)
  await page.evaluate(() => window.__rcInjectPointer?.('up', 2, 60, 60, 48))
  await tick(page, 16)
  expect(await count(page, 'tap')).toBe(1) // unchanged while suspended

  await page.evaluate(() => window.__rcResume?.())
  await page.evaluate(() => window.__rcInjectPointer?.('down', 3, 70, 70, 64))
  await tick(page, 16)
  await page.evaluate(() => window.__rcInjectPointer?.('up', 3, 70, 70, 80))
  await tick(page, 16)
  expect(await count(page, 'tap')).toBe(2) // resumed: the down/up cycle suspend() swallowed is gone
})

// `input: keyboard focus rules` (docs/plan/11-camera-and-input.md, Tests added; 0019 §4): a real
// `<input>` on the page (`real-camera.html`), real `page.keyboard` dispatch (not injection -- the
// filter lives in the DOM listener itself, `input/keys.ts`'s `shouldIgnoreKeyDown`), and a real
// `blur` event.
test('input: keyboard focus rules', async ({ page }) => {
  await createReal(page)

  await page.locator('#text-field').focus()
  await page.keyboard.down('KeyW')
  expect(await keysMask(page)).toBe(0) // ignored: the event's target is a real <input>
  await page.keyboard.up('KeyW')
  expect(await keysMask(page)).toBe(0)

  // Focus leaves the text field (no other element takes it: keyboard events now target `body`,
  // per spec) -- the same physical key is now recorded.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.down('KeyW')
  expect(await keysMask(page)).toBe(1) // KeyBit.W

  // A real `blur` on `window` (0019 §4: "cleared on blur") clears it even though the key is, from
  // the OS's perspective, still physically held.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  expect(await keysMask(page)).toBe(0)

  await page.keyboard.up('KeyW') // release the real key so it doesn't leak into another test
})

// `input: dom path pan and tap` (docs/plan/11-camera-and-input.md, Tests added): the one real-DOM-
// path test -- real `PointerEvent`s via Playwright's `page.mouse`, through the client's own
// automatically-installed `installPointerListeners` (`src/client.ts`), not `engine/test` injection.
test('input: dom path pan and tap', async ({ page }) => {
  await createReal(page)

  const before = await read(page)
  await page.mouse.move(100, 100)
  await page.mouse.down()
  await tick(page, 16) // the down frame itself never pans (camera.ts's own convention)
  await page.mouse.move(140, 100, { steps: 4 })
  await tick(page, 16)
  await page.mouse.up()
  await tick(page, 16)
  const afterDrag = await read(page)
  expect(afterDrag.centreX).not.toBe(before.centreX) // a real drag really panned

  await page.mouse.move(220, 160)
  await page.mouse.down()
  await tick(page, 16)
  await page.mouse.up()
  await tick(page, 16)
  expect(await count(page, 'tap')).toBe(1)
})

// `input: widget blocks canvas` (docs/plan/11-camera-and-input.md, Tests added; 0019 §4 "Input over
// DOM UI"): a sibling element with `pointer-events: auto` above the canvas keeps the browser's own
// hit-testing from ever delivering the click to the canvas at all -- the engine "listens nowhere
// else for pointers" (0019 §4), so a widget click must produce neither a pan nor a tap.
test('input: widget blocks canvas', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() => window.__rcMountWidget?.(150, 100, 100, 100))

  const before = await read(page)
  await page.mouse.move(200, 150) // inside the widget's own rect
  await page.mouse.down()
  await tick(page, 16)
  await page.mouse.move(260, 150, { steps: 4 })
  await tick(page, 16)
  await page.mouse.up()
  await tick(page, 16)
  const after = await read(page)
  expect(after.centreX).toBe(before.centreX) // never reached the canvas: no pan
  expect(await count(page, 'tap')).toBe(0) // never reached the canvas: no tap either
})

// `input: drag survives passing under widget` (docs/plan/11-camera-and-input.md, Tests added; 0019
// §3/§4: "Pointer capture keeps a world drag alive when it passes under a widget"): the drag starts
// on bare canvas (real `setPointerCapture` on that `pointerdown`), so every later `pointermove` --
// even while the cursor is visually over the widget -- is still routed to the canvas by the browser.
test('input: drag survives passing under widget', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() => window.__rcMountWidget?.(150, 100, 100, 100)) // x in [150,250]

  const before = await read(page)
  await page.mouse.move(50, 150) // left of the widget, on bare canvas
  await page.mouse.down()
  await tick(page, 16)
  await page.mouse.move(200, 150, { steps: 8 }) // straight through the widget's own rect
  await tick(page, 16)
  await page.mouse.move(350, 150, { steps: 8 }) // out the other side
  await tick(page, 16)
  await page.mouse.up()
  await tick(page, 16)
  const after = await read(page)
  expect(after.centreX).not.toBe(before.centreX) // panned the whole way, widget notwithstanding
})
