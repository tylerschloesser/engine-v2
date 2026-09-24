// docs/plan/18-picking-and-overlay.md Tests added (this cut's own share, steps 4-6): `follow.
// centres_in_same_frame_pan_ignored_zoom_works`. Drives `real-camera.html` (already the reused page
// for every real-DOM/injection input test, `semantic.spec.ts`'s own precedent): a real
// `createClient()`, a hand-filled DrawList header publish over the real `drawList` triple-buffer SAB
// (the same "hand-built slot" shape `pick.spec.ts`/`overlay.spec.ts` already use, this time for the
// header's own `follow_valid`/`follow` fields instead of picking/anchor ones) -- no WASM/Rust needed
// to prove the *main-thread* half of 0019 §1 ("the main thread centres on it in the frame that draws
// that DrawList ... pan input is ignored and zoom still works"), only a real `Client.camera.tick()`
// reading the acquired slot's own header before `integrate()` runs.
import { expect, type Page, test } from '@playwright/test'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __rcCreate?: (opts?: { cameraKey?: string; overlayMode?: 'properties' | 'translate' }) => void
    __rcReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __rcRead?: () => { centreX: number; centreY: number; tilesAcross: number }
    __rcMoveTo?: (x: number, y: number, opts?: { tiles?: number; durationMs?: number }) => void
    __rcTick?: (dtMs: number) => void
    __rcInjectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
    ) => void
    __rcPublishDrawList?: (
      records: Array<{
        posX: number
        posY: number
        sizeX: number
        sizeY: number
        kind: number
        layer: number
        flags?: number
        pickId: number
      }>,
      windowOriginX?: number,
      windowOriginY?: number,
      opts?: {
        follow?: { x: number; y: number }
        anchors?: Array<{ slot: number; x: number; y: number }>
      },
    ) => void
    __rcPickAcquire?: () => void
  }
}

async function createReal(page: Page): Promise<void> {
  await openPage(page, '/real-camera.html')
  await page.evaluate(() => window.__rcCreate?.())
  const r = await page.evaluate(() => window.__rcReady?.())
  expect(r?.ok, JSON.stringify(r)).toBe(true)
}

test('follow.centres_in_same_frame_pan_ignored_zoom_works', async ({ page }) => {
  await createReal(page)

  // A one-pointer drag already in progress: overriding the centre at the end of `integrate()` must
  // discard this frame's own pan delta, not merely never have applied one.
  await page.evaluate(() => window.__rcInjectPointer?.('down', 1, 200, 150, 0))
  await page.evaluate(() => window.__rcInjectPointer?.('move', 1, 260, 150, 16))

  await page.evaluate(() => window.__rcPublishDrawList?.([], 0, 0, { follow: { x: 7, y: -3 } }))
  await page.evaluate(() => window.__rcPickAcquire?.())
  await page.evaluate(() => window.__rcTick?.(16))

  const state = await page.evaluate(() => window.__rcRead?.())
  expect(state?.centreX).toBeCloseTo(7, 5)
  expect(state?.centreY).toBeCloseTo(-3, 5)

  await page.evaluate(() => window.__rcInjectPointer?.('up', 1, 260, 150, 32))

  // Zoom still works while a target is set: `moveTo`'s own zoom request lands, its pan request does
  // not -- the centre stays pinned to the follow target, never `moveTo`'s own `(999, 999)`. Loose
  // precision here (unlike the exact check above): with no pointer active this tick, 0018 §3's own
  // "camera snaps to device pixels at rest" also fires (a real, correct effect of overriding centre
  // *before* that snap runs), rounding the follow target to the nearest device pixel.
  await page.evaluate(() => window.__rcMoveTo?.(999, 999, { tiles: 24, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  const state2 = await page.evaluate(() => window.__rcRead?.())
  expect(state2?.tilesAcross).toBeCloseTo(24, 5)
  expect(state2?.centreX).toBeCloseTo(7, 1)
  expect(state2?.centreY).toBeCloseTo(-3, 1)

  // Returning control (`follow_valid = 0`, this same page's own no-`follow`-option publish path):
  // pan and zoom both work normally again.
  await page.evaluate(() => window.__rcPublishDrawList?.([], 0, 0, {}))
  await page.evaluate(() => window.__rcPickAcquire?.())
  await page.evaluate(() => window.__rcMoveTo?.(1, 1, { tiles: 12, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  const state3 = await page.evaluate(() => window.__rcRead?.())
  expect(state3?.centreX).toBeCloseTo(1, 1)
  expect(state3?.centreY).toBeCloseTo(1, 1)
})
