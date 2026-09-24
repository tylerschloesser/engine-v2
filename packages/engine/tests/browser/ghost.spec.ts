// docs/plan/18-picking-and-overlay.md Tests added (steps 7-8): `ghost.mouse_tracks_cursor_tile`,
// `ghost.touch_tap_then_confirm`. Drives `ghost.html` (a real, connected `fx-overlay` client: real
// camera/picking/overlay plus a real WASM `extract()` drawing the cursor-anchored ghost, 0019
// "Cursor tile and ghost").
//
// Canvas 400x300, `tilesAcross` 12 (`CameraState`'s own default), centre `(0, 0)` -- the same
// `pick.spec.ts`/`follow.spec.ts` convention: `pxPerTile = max(400, 300) / 12 = 33.333`, so screen
// `(200, 150)` (dead centre) is world tile `(0, 0)` and screen `(280, 150)` (+80px = +2.4 tiles) is
// world tile `(2, 0)`.
import { expect, type Page, test } from '@playwright/test'
import { ANCHOR_CURSOR_TILE } from '../../src/render/drawables.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __ready?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __injectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
      kind?: 'mouse' | 'touch',
    ) => void
    __injectHover?: (cssX: number, cssY: number) => void
    __driveFrame?: (dtMs: number) => void
    __cursorTile?: () => { x: number; y: number; valid: boolean }
    __ghostRecord?: () => { pos: [number, number]; flags: number } | undefined
    __lastTap?: () => { tileX: number; tileY: number } | undefined
    __confirmVisible?: () => boolean
    __lastDispatchSeq?: () => number | undefined
  }
}

async function createReady(page: Page): Promise<void> {
  await openPage(page, '/ghost.html')
  const r = await page.evaluate(() => window.__ready?.())
  expect(r?.ok, JSON.stringify(r)).toBe(true)
}

test('ghost.mouse_tracks_cursor_tile', async ({ page }) => {
  await createReady(page)

  // No pointer yet: `view.cursor_tile()` is `None`, `extract()` draws no `KIND_GHOST` record.
  await page.evaluate(() => window.__driveFrame?.(16))
  const before = await page.evaluate(() => window.__ghostRecord?.())
  expect(before).toBeUndefined()

  // Idle mouse hover -- no button held (`input/pointers.ts`'s own `recordMouseHover`, 0019 §4's
  // "mouse: tile under the pointer" path; unlike a held-and-moved pointer, this never pans the
  // camera, so "screen position -> world tile" stays the plain, unpanned conversion) -- at world
  // tile (0, 0).
  await page.evaluate(() => window.__injectHover?.(200, 150))
  await page.evaluate(() => window.__driveFrame?.(16))
  const cursor1 = await page.evaluate(() => window.__cursorTile?.())
  expect(cursor1).toEqual({ x: 0, y: 0, valid: true })
  const ghost1 = await page.evaluate(() => window.__ghostRecord?.())
  expect(ghost1).toBeDefined()
  expect(ghost1?.pos).toEqual([0, 0]) // Deviations: always zero -- the shader places it, not `pos`
  expect(((ghost1?.flags ?? 0) & ANCHOR_CURSOR_TILE) !== 0).toBe(true)

  // Moving the pointer moves the cursor tile the ghost is anchored to; the `KIND_GHOST` record
  // itself is unchanged (same shape, same `ANCHOR_CURSOR_TILE` flag) -- exactly what "tracks the
  // cursor" means for a record whose *screen* position is resolved by the GPU uniform, not by any
  // field this record carries (Deviations).
  await page.evaluate(() => window.__injectHover?.(280, 150))
  await page.evaluate(() => window.__driveFrame?.(16))
  const cursor2 = await page.evaluate(() => window.__cursorTile?.())
  expect(cursor2).toEqual({ x: 2, y: 0, valid: true })
  const ghost2 = await page.evaluate(() => window.__ghostRecord?.())
  expect(ghost2).toBeDefined()
  expect(((ghost2?.flags ?? 0) & ANCHOR_CURSOR_TILE) !== 0).toBe(true)
})

test('ghost.touch_tap_then_confirm', async ({ page }) => {
  await createReady(page)

  // A touch tap at world tile (2, 0): down then up inside `TAP_MAX_MS`, no movement past threshold.
  await page.evaluate(() => window.__injectPointer?.('down', 1, 280, 150, 0, 'touch'))
  await page.evaluate(() => window.__driveFrame?.(0))
  await page.evaluate(() => window.__injectPointer?.('up', 1, 280, 150, 10, 'touch'))
  await page.evaluate(() => window.__driveFrame?.(10))

  // "touch: tile of the last tap" (0019 "Cursor tile and ghost", `input/semantic.ts`'s own fix,
  // this cut): the tap itself sets the cursor tile, with no hover ever involved.
  const tap = await page.evaluate(() => window.__lastTap?.())
  expect(tap).toEqual({ tileX: 2, tileY: 0 })
  const cursor = await page.evaluate(() => window.__cursorTile?.())
  expect(cursor).toEqual({ x: 2, y: 0, valid: true })

  // The ghost appears there, drawn by the same `stepFrame` that carried the tap into `cx.input()`.
  const ghost = await page.evaluate(() => window.__ghostRecord?.())
  expect(ghost).toBeDefined()
  expect(ghost?.pos).toEqual([0, 0])
  expect(((ghost?.flags ?? 0) & ANCHOR_CURSOR_TILE) !== 0).toBe(true)

  // The page (acting as "the game", Planning decisions: `FrameCx` has no `dispatch`) shows a real
  // DOM confirm button anchored to that tile.
  const visible = await page.evaluate(() => window.__confirmVisible?.())
  expect(visible).toBe(true)
  await expect(page.locator('#ghost-confirm')).toBeVisible()

  // A real click dispatches the action.
  await page.click('#ghost-confirm')
  await page.waitForFunction(() => (window.__lastDispatchSeq?.() ?? -1) >= 0)
  const seq = await page.evaluate(() => window.__lastDispatchSeq?.())
  expect(seq).toBeGreaterThanOrEqual(0)
  const goneVisible = await page.evaluate(() => window.__confirmVisible?.())
  expect(goneVisible).toBe(false)
})
