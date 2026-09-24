// docs/plan/18-picking-and-overlay.md Tests added (this cut's own share, steps 4-6): `framecx.
// tap_visible_in_frame`, `framecx.emit_visible_in_frame`. Drives `framecx.html` (`fixtures/overlay`'s
// real WASM `ClientSide::frame`, module doc comment of `pages/src/framecx.ts`): the one thing steps
// 1-3's own hand-filled-SAB precedent (`real-camera.html`, no WASM) cannot prove -- that an event
// written into `inputRing` is actually visible inside a real `frame()` call's own `FrameCx::input()`.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.ts'

// Both tests below proved, under repeated stress-testing (`Deviations`), that the input-delivery
// half of this page never fails: `uiDrainStats()` and the input ring's own producer counters always
// showed the record fully delivered (`popped: 1`, `recordsSeen: 1`, `onUi: 1`) by the time a
// `waitForUi` timeout fired. The remaining flakiness is `resultsFrame`'s own independent real-
// `requestAnimationFrame` poll (`src/client.ts`) occasionally landing several seconds late under
// heavy parallel-worker CPU contention -- not a delivery bug. Retries were tried and reverted: three
// independent attempts (fresh page each time) can all land in the same contention window, which
// only triples the worst-case wall time without improving reliability (`Deviations`).

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
    __debug?: () => {
      ringStats: { drops: number; pushed: number; popped: number }
      uiDrainStats: { recordsSeen: number; onUi: number }
    }
  }
}

async function createReady(page: Parameters<typeof openPage>[0]): Promise<void> {
  await openPage(page, '/framecx.html')
  const r = await page.evaluate(() => window.__ready?.())
  expect(r?.ok, JSON.stringify(r)).toBe(true)
}

/** `client.onUi` is delivered from `resultsFrame`'s own independent real-`requestAnimationFrame`
 * poll of `uiRing` (`src/client.ts`), a separate schedule from `stepFrame`'s synchronous worker
 * lockstep above -- `window.__lastUi?.().count` only becomes truthy once a real rAF has actually
 * run since the record landed, so this polls (`page.waitForFunction`) rather than reading once
 * right after `stepFrame`. Confirmed by instrumentation (not a delivery bug, `Deviations`):
 * `ClientTestHandle.uiDrainStats()` and the input ring's own producer counters both already showed
 * the record fully delivered (`popped: 1`, `recordsSeen: 1`, `onUi: 1`) on every timeout this
 * stress-testing caught -- `resultsFrame`'s own real-rAF cadence is just occasionally slow to reach
 * *this* page under heavy parallel-worker CPU contention, arriving a few hundred ms after a tighter
 * budget's own deadline. `polling: 100` (a plain interval, not the default `'raf'`) avoids stacking
 * this poll's own rAF dependency on top of `resultsFrame`'s; the generous timeout absorbs the rest. */
async function waitForUi(page: Parameters<typeof openPage>[0]): Promise<void> {
  await page.waitForFunction(() => (window.__lastUi?.()?.count ?? 0) > 0, undefined, {
    timeout: 20000,
    polling: 100,
  })
}

test('framecx.tap_visible_in_frame', async ({ page }) => {
  test.setTimeout(45000) // headroom over waitForUi's own 20s budget (see its own doc comment)
  await createReady(page)

  const wrote = await page.evaluate(() => window.__injectRawInput?.(1, 5, -2, 77))
  expect(wrote).toBe(true)
  // One `stepFrame`, not two: `worker/client.ts`'s `body()` now drains `inputRing` into
  // `InputQueue` *before* calling `frame()`, in the same wake (gate round 1) -- a record written
  // before this call is visible to *this* call's own `cx.input()`, not the next one.
  await page.evaluate((dt: number) => window.__stepFrame?.(dt), 16)
  try {
    await waitForUi(page)
  } catch (e) {
    const debug = await page.evaluate(() => window.__debug?.())
    throw new Error(`tap timed out; debug=${JSON.stringify(debug)}; original=${String(e)}`)
  }

  const ui = await page.evaluate(() => window.__lastUi?.())
  expect(ui?.count).toBeGreaterThan(0)
  expect(ui?.last_kind).toBe(1) // kind::TAP
  expect(ui?.last_pick_id).toBe(77)
  expect(ui?.last_tile_x).toBe(5)
  expect(ui?.last_tile_y).toBe(-2)
})

test('framecx.emit_visible_in_frame', async ({ page }) => {
  test.setTimeout(45000)
  await createReady(page)

  const wrote = await page.evaluate(() => window.__emit?.(3, 1, 2))
  expect(wrote).toBe(true)
  await page.evaluate((dt: number) => window.__stepFrame?.(dt), 16)
  try {
    await waitForUi(page)
  } catch (e) {
    const debug = await page.evaluate(() => window.__debug?.())
    throw new Error(`emit timed out; debug=${JSON.stringify(debug)}; original=${String(e)}`)
  }

  const ui = await page.evaluate(() => window.__lastUi?.())
  expect(ui?.last_kind).toBe(7) // kind::GAME
  expect(ui?.last_pick_id).toBe(3) // code
  expect(ui?.last_tile_x).toBe(1) // a
  expect(ui?.last_tile_y).toBe(2) // b
})
