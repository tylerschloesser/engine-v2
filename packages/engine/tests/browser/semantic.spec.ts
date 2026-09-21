// `input: events reach wasm` (docs/plan/11-camera-and-input.md, Tests added): the whole
// `client.input.recognize` -> `inputRing` -> client worker drain -> `on_input` -> `InputQueue` path
// against a real `fx-terrain` client (`semantic.html`/`semantic.ts`). The test export is `on_input`
// itself, called with `len=0` through the parked-only `test-call` channel: nothing new to decode,
// but it still reports the queue's *current* length and last tile as a side effect (the same
// "whichever export ran last owns `Result`'s content" idiom as `gen_take`/`client_gen_stats`).
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'

type InputStats = { queueLen: number; tileX: number; tileY: number }

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
  }
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
