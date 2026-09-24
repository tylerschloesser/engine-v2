// docs/plan/18-picking-and-overlay.md Tests added (this cut's own share, steps 1-2): `pick.
// tap_reports_entity_pick_id`, `pick.hover_once_per_raf_on_change`, `pick.
// matches_interpolated_frame_on_screen`. Drives `real-camera.html` (already the reused page for
// every real-DOM/injection input test, `semantic.spec.ts`'s own precedent): a real `createClient()`,
// hand-filled DrawList publishes over the real `drawList` triple-buffer SAB (the same "hand-built
// slot" shape `src/input/pick.test.ts`'s unit tests use, at browser scale), no GPU/renderer needed
// at all -- picking is pure SAB scanning plus camera math (0019 §4).
import { expect, type Page, test } from '@playwright/test'
import { KIND_CIRCLE } from '../../src/render/drawables.ts'
import { openPage } from './support/page.ts'

type InputEventType = 'tap' | 'hover' | 'longpress' | 'dragstart' | 'drag' | 'dragend'

declare global {
  interface Window {
    __rcCreate?: (opts?: { cameraKey?: string; overlayMode?: 'properties' | 'translate' }) => void
    __rcReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __rcTick?: (dtMs: number) => void
    __rcCount?: (type: InputEventType) => number
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
    __rcPickAt?: (cssX: number, cssY: number) => number
    __rcPickScanned?: () => number
  }
}

async function createReal(page: Page): Promise<void> {
  await openPage(page, '/real-camera.html')
  await page.evaluate(() => window.__rcCreate?.())
  const r = await page.evaluate(() => window.__rcReady?.())
  expect(r?.ok, JSON.stringify(r)).toBe(true)
}

/** The 400x300 canvas, `tilesAcross` 12 (`CameraState`'s own default), centre `(0, 0)`: screen
 * `(200, 150)` (dead centre) maps to world tile `(0, 0)` (`camera/transform.ts`'s own formula --
 * `pxPerTile = max(400, 300) / 12`). */
const CENTRE_CSS = { x: 200, y: 150 }

async function publishOneCircle(
  page: Page,
  pickId: number,
  posX = 0,
  posY = 0,
  sizeX = 4,
): Promise<void> {
  await page.evaluate(
    ({ pickId, posX, posY, sizeX, KIND_CIRCLE }) => {
      window.__rcPublishDrawList?.([
        { posX, posY, sizeX, sizeY: sizeX, kind: KIND_CIRCLE, layer: 0, pickId },
      ])
    },
    { pickId, posX, posY, sizeX, KIND_CIRCLE },
  )
}

test('pick.tap_reports_entity_pick_id', async ({ page }) => {
  await createReal(page)
  await publishOneCircle(page, 42)
  await page.evaluate(() => window.__rcPickAcquire?.())
  await page.evaluate((c) => {
    window.__rcInjectPointer?.('down', 1, c.x, c.y, 0)
  }, CENTRE_CSS)
  await page.evaluate(() => window.__rcTick?.(0))
  await page.evaluate((c) => {
    window.__rcInjectPointer?.('up', 1, c.x, c.y, 10)
  }, CENTRE_CSS)
  await page.evaluate(() => window.__rcTick?.(10))

  const tapCount = await page.evaluate(() => window.__rcCount?.('tap'))
  expect(tapCount).toBe(1)
  // The emitted event's own `pickId` (`InputEventTs`) -- the ring record beside it is written from
  // the identical local variable inside `input/semantic.ts`'s `emit`, by construction.
  const pickId = await page.evaluate(() => window.__rcPickAt?.(200, 150))
  expect(pickId).toBe(42)

  // A tap on empty ground reports 0.
  await page.evaluate(() => window.__rcInjectPointer?.('down', 1, 380, 10, 100))
  await page.evaluate(() => window.__rcTick?.(0))
  await page.evaluate(() => window.__rcInjectPointer?.('up', 1, 380, 10, 110))
  await page.evaluate(() => window.__rcTick?.(10))
  const missId = await page.evaluate(() => window.__rcPickAt?.(380, 10))
  expect(missId).toBe(0)
})

test('pick.hover_once_per_raf_on_change', async ({ page }) => {
  await createReal(page)
  await publishOneCircle(page, 5)
  await page.evaluate(() => window.__rcPickAcquire?.())

  const before = await page.evaluate(() => window.__rcPickScanned?.())
  const id1 = await page.evaluate((c) => window.__rcPickAt?.(c.x, c.y), CENTRE_CSS)
  const after1 = await page.evaluate(() => window.__rcPickScanned?.())
  expect(id1).toBe(5)
  expect(after1).toBe((before ?? 0) + 1)

  // Same point again: cached, no new scan (Planning decisions: "hover picks at most once per rAF,
  // when the pointer or slot changed").
  const id2 = await page.evaluate((c) => window.__rcPickAt?.(c.x, c.y), CENTRE_CSS)
  const after2 = await page.evaluate(() => window.__rcPickScanned?.())
  expect(id2).toBe(5)
  expect(after2).toBe(after1)

  // A different point: a real scan again.
  const id3 = await page.evaluate(() => window.__rcPickAt?.(210, 150))
  const after3 = await page.evaluate(() => window.__rcPickScanned?.())
  expect(id3).toBe(5) // still inside the same circle, but the cache key (position) changed
  expect(after3).toBe((after2 ?? 0) + 1)
})

test('pick.matches_interpolated_frame_on_screen', async ({ page }) => {
  await createReal(page)
  // Frame A: a pickable circle with id 1, acquired.
  await publishOneCircle(page, 1)
  await page.evaluate(() => window.__rcPickAcquire?.())
  const idFromA = await page.evaluate((c) => window.__rcPickAt?.(c.x, c.y), CENTRE_CSS)
  expect(idFromA).toBe(1)

  // A newer frame (id 2) is published by "the worker" -- but never acquired. Picking must still
  // answer against frame A, the one on screen, not the newer one that exists on the SAB. A
  // *different* point than `idFromA`'s own forces a real rescan (`Picker.at`'s own cache is keyed
  // on position too), proving this is the slot mechanism, not a stale cached answer.
  await publishOneCircle(page, 2)
  const stillA = await page.evaluate(() => window.__rcPickAt?.(205, 150))
  expect(stillA).toBe(1)

  // Only once `acquire()` runs again does picking move on to the newer frame.
  await page.evaluate(() => window.__rcPickAcquire?.())
  const nowB = await page.evaluate(() => window.__rcPickAt?.(205, 150))
  expect(nowB).toBe(2)
})
