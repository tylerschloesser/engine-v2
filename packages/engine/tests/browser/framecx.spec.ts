// docs/plan/18-picking-and-overlay.md Tests added (this cut's own share, steps 4-6): `framecx.
// tap_visible_in_frame`, `framecx.emit_visible_in_frame`. Drives `framecx.html` (`fixtures/overlay`'s
// real WASM `ClientSide::frame`, module doc comment of `pages/src/framecx.ts`): the one thing steps
// 1-3's own hand-filled-SAB precedent (`real-camera.html`, no WASM) cannot prove -- that an event
// written into `inputRing` is actually visible inside a real `frame()` call's own `FrameCx::input()`.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.ts'

type OverlayUi = {
  count: number
  last_kind: number
  last_pick_id: number
  last_tile_x: number
  last_tile_y: number
}

declare global {
  interface Window {
    __ready?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __stepFrame?: (dtMs: number) => void
    __injectRawInput?: (kind: number, tileX: number, tileY: number, pickId: number) => boolean
    __emit?: (code: number, a?: number, b?: number) => boolean
    __lastUi?: () => OverlayUi | undefined
  }
}

async function createReady(page: Parameters<typeof openPage>[0]): Promise<void> {
  await openPage(page, '/framecx.html')
  const r = await page.evaluate(() => window.__ready?.())
  expect(r?.ok, JSON.stringify(r)).toBe(true)
}

/** Two `stepFrame` calls: `body()` (`worker/client.ts`) runs `frame()` *before* `inputPump.pump()`
 * drains a wake's own new `inputRing` records into `InputQueue` (module doc comment of
 * `game_instance.rs`'s `frame()`, "the same one-wake-old staleness ... already accepted elsewhere in
 * this file") -- a record written before the first `stepFrame` call is only visible to the *second*
 * real `frame()` call's own `cx.input()`. */
async function stepFrameTwice(page: Parameters<typeof openPage>[0]): Promise<void> {
  await page.evaluate((dt: number) => window.__stepFrame?.(dt), 16)
  await page.evaluate((dt: number) => window.__stepFrame?.(dt), 16)
}

/** `client.onUi` is delivered from `resultsFrame`'s own independent real-`requestAnimationFrame`
 * poll of `uiRing` (`src/client.ts`), a separate schedule from `stepFrame`'s synchronous worker
 * lockstep above -- `window.__lastUi?.().count` only becomes truthy once a real rAF has actually
 * run since the record landed, so this polls (`page.waitForFunction`) rather than reading once
 * right after `stepFrameTwice`. */
async function waitForUi(page: Parameters<typeof openPage>[0]): Promise<void> {
  await page.waitForFunction(() => (window.__lastUi?.()?.count ?? 0) > 0, undefined, {
    timeout: 5000,
  })
}

test('framecx.tap_visible_in_frame', async ({ page }) => {
  await createReady(page)

  const wrote = await page.evaluate(() => window.__injectRawInput?.(1, 5, -2, 77))
  expect(wrote).toBe(true)
  await stepFrameTwice(page)
  await waitForUi(page)

  const ui = await page.evaluate(() => window.__lastUi?.())
  expect(ui?.count).toBeGreaterThan(0)
  expect(ui?.last_kind).toBe(1) // kind::TAP
  expect(ui?.last_pick_id).toBe(77)
  expect(ui?.last_tile_x).toBe(5)
  expect(ui?.last_tile_y).toBe(-2)
})

test('framecx.emit_visible_in_frame', async ({ page }) => {
  await createReady(page)

  const wrote = await page.evaluate(() => window.__emit?.(3, 1, 2))
  expect(wrote).toBe(true)
  await stepFrameTwice(page)
  await waitForUi(page)

  const ui = await page.evaluate(() => window.__lastUi?.())
  expect(ui?.last_kind).toBe(7) // kind::GAME
  expect(ui?.last_pick_id).toBe(3) // code
  expect(ui?.last_tile_x).toBe(1) // a
  expect(ui?.last_tile_y).toBe(2) // b
})
