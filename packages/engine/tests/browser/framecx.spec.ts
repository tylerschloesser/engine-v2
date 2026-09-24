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
  // `lastUi()` (`test/client.ts`) subscribes to `client.onUi` lazily, on its own first call, and
  // its own doc comment is explicit: "a call made after a value already arrived and was coalesced
  // away still sees every value from that point on" -- not any value delivered *before* the first
  // call. `resultsFrame`'s independent real-rAF poll (`src/client.ts`) can drain and coalesce this
  // page's one-and-only UI record before anything is listening if `lastUi()`'s first call comes
  // *after* the state-changing `stepFrame` below (gate round 2's actual root cause, `Deviations`;
  // `puts-ui.spec.ts`'s own comment names the same gotcha: "Subscribes `lastUi` *before* the change
  // that follows"). Subscribing here, before any input exists, makes that race impossible.
  await page.evaluate(() => window.__lastUi?.())
}

/** `client.onUi` is delivered from `resultsFrame`'s own independent real-`requestAnimationFrame`
 * poll of `uiRing` (`src/client.ts`), a separate schedule from `stepFrame`'s synchronous worker
 * lockstep -- `window.__lastUi?.().count` only becomes truthy once a real rAF has actually run
 * since the record landed, so this polls rather than reading once right after `stepFrame`. An
 * ordinary budget: with `createReady`'s own early subscription (above) closing the real race, nothing
 * here needs to absorb a lost delivery, only an ordinary handful of real rAF ticks. */
async function waitForUi(page: Parameters<typeof openPage>[0]): Promise<void> {
  await page.waitForFunction(() => (window.__lastUi?.()?.count ?? 0) > 0, undefined, {
    timeout: 5000,
  })
}

test('framecx.tap_visible_in_frame', async ({ page }) => {
  await createReady(page)

  const wrote = await page.evaluate(() => window.__injectRawInput?.(1, 5, -2, 77))
  expect(wrote).toBe(true)
  // One `stepFrame`, not two: `worker/client.ts`'s `body()` now drains `inputRing` into
  // `InputQueue` *before* calling `frame()`, in the same wake (gate round 1) -- a record written
  // before this call is visible to *this* call's own `cx.input()`, not the next one.
  await page.evaluate((dt: number) => window.__stepFrame?.(dt), 16)
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
  await page.evaluate((dt: number) => window.__stepFrame?.(dt), 16)
  await waitForUi(page)

  const ui = await page.evaluate(() => window.__lastUi?.())
  expect(ui?.last_kind).toBe(7) // kind::GAME
  expect(ui?.last_pick_id).toBe(3) // code
  expect(ui?.last_tile_x).toBe(1) // a
  expect(ui?.last_tile_y).toBe(2) // b
})
