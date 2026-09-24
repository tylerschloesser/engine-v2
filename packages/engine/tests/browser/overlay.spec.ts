// docs/plan/18-picking-and-overlay.md Tests added (this cut's own share, step 3, static anchors
// only): `overlay.anchor_tracks_world_point`, `overlay.idle_writes_nothing`, `overlay.
// pan_one_write_zoom_two`, `overlay.rebase_beyond_50000px`, `overlay.offscreen_hidden_on_transition_
// only`, `overlay.widget_click_not_a_tap`. Drives `real-camera.html` (a real, document-attached
// canvas + `createClient`, `semantic.spec.ts`'s own precedent) -- no GPU needed: overlay anchoring
// is DOM + camera math only. Reading layout (`boundingBox()`) is allowed here, in a test, per
// Planning decisions ("reading layout is allowed in tests only") -- never in `src/overlay/`.
import { expect, type Page, test } from '@playwright/test'
import { openPage } from './support/page.ts'

type AnchorAlign = 'center' | 'top' | 'bottom'
type InputEventType = 'tap' | 'hover' | 'longpress' | 'dragstart' | 'drag' | 'dragend'

declare global {
  interface Window {
    __rcCreate?: (opts?: { cameraKey?: string }) => void
    __rcReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __rcTick?: (dtMs: number) => void
    __rcMoveTo?: (x: number, y: number, opts?: { tiles?: number; durationMs?: number }) => void
    __rcCount?: (type: InputEventType) => number
    __rcInjectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
    ) => void
    __rcOverlayAnchor?: (id: string, worldX: number, worldY: number, align?: AnchorAlign) => void
    __rcOverlaySet?: (id: string, worldX: number, worldY: number) => void
    __rcOverlayRemove?: (id: string) => void
    __rcOverlayUpdate?: () => void
    __rcOverlayStyleWrites?: () => number
    // docs/plan/18-picking-and-overlay.md steps 4-6: `overlay.anchorSlot`, and the hand-filled
    // header publish `follow.spec.ts`/`pick.spec.ts` also use.
    __rcOverlayAnchorSlot?: (id: string, slot: number) => void
    __rcOverlayAnchorSlotRemove?: (id: string) => void
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

async function styleWrites(page: Page): Promise<number> {
  return (await page.evaluate(() => window.__rcOverlayStyleWrites?.())) ?? 0
}

type Box = { x: number; y: number; width: number; height: number }

/** `page.locator(...).boundingBox()` types its result nullable; every call site here already
 * expects a real, visible element (Biome forbids `!`). */
function requireBox(box: Box | null): Box {
  expect(box).not.toBeNull()
  return box as Box
}

// `CameraState`'s own default `tilesAcross` (12), a 400x300 canvas: `pxPerTile = 400 / 12`.
function expectedScreen(worldX: number, worldY: number, centreX: number, centreY: number) {
  const ppt = 400 / 12
  return { x: 200 + (worldX - centreX) * ppt, y: 150 + (worldY - centreY) * ppt }
}

test('overlay.anchor_tracks_world_point', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() => window.__rcOverlayAnchor?.('a1', 3, -2))
  await page.evaluate(() => window.__rcOverlayUpdate?.())

  const box = requireBox(await page.locator('#a1').boundingBox())
  // `align: 'bottom'` (the default): the anchor's own bottom-centre sits on the world point.
  const expected = expectedScreen(3, -2, 0, 0)
  expect(box.x + box.width / 2).toBeCloseTo(expected.x, 0)
  expect(box.y + box.height).toBeCloseTo(expected.y, 0)

  // Pan the camera; the anchor follows within 0.5 px.
  await page.evaluate(() => window.__rcMoveTo?.(10, 4, { tiles: 12, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  const box2 = requireBox(await page.locator('#a1').boundingBox())
  const expected2 = expectedScreen(3, -2, 10, 4)
  expect(box2.x + box2.width / 2).toBeCloseTo(expected2.x, 0)
  expect(box2.y + box2.height).toBeCloseTo(expected2.y, 0)
})

test('overlay.idle_writes_nothing', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() => window.__rcOverlayAnchor?.('a1', 0, 0))
  await page.evaluate(() => window.__rcOverlayUpdate?.()) // the first update always writes (layer built)
  const before = await styleWrites(page)
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.__rcTick?.(16))
    await page.evaluate(() => window.__rcOverlayUpdate?.())
  }
  const after = await styleWrites(page)
  expect(after).toBe(before)
})

test('overlay.pan_one_write_zoom_two', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() => window.__rcOverlayAnchor?.('a1', 20, 20)) // far from the origin tile (0,0)
  await page.evaluate(() => window.__rcOverlayUpdate?.())

  const beforePan = await styleWrites(page)
  await page.evaluate(() => window.__rcMoveTo?.(1, 0, { tiles: 12, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  const afterPan = await styleWrites(page)
  expect(afterPan).toBe(beforePan + 1) // transform only

  const beforeZoom = afterPan
  await page.evaluate(() => window.__rcMoveTo?.(1, 0, { tiles: 24, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  const afterZoom = await styleWrites(page)
  expect(afterZoom).toBe(beforeZoom + 2) // transform (origin's own screen pos moved too) and --z
})

test('overlay.rebase_beyond_50000px', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() => window.__rcOverlayAnchor?.('a1', 5, 5))
  await page.evaluate(() => window.__rcOverlayUpdate?.())

  // Move the camera far enough that the *origin* tile (still near 0,0) is over 50,000 CSS px away
  // -- `pxPerTile` is 400/12 ~= 33.3, so ~2,000 tiles clears the threshold comfortably. This alone
  // forces one re-base (`needsRebase`), and the anchor is far off-screen throughout, so no assertion
  // is made about its own position here.
  await page.evaluate(() => window.__rcMoveTo?.(3000, 0, { tiles: 12, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  await page.evaluate(() => window.__rcOverlayUpdate?.())

  // Move the camera back to the anchor's own world point -- a *second* re-base (the origin is now
  // ~3000 tiles from the live camera). The real invariant: however many re-bases happened along the
  // way, the anchor still tracks its own fixed world position exactly (`worldToScreen`, the same
  // formula `overlay.anchor_tracks_world_point` checks) -- not a comparison against an earlier,
  // different-camera measurement (which would be comparing two different screen positions, not the
  // same one before/after a re-base).
  await page.evaluate(() => window.__rcMoveTo?.(5, 5, { tiles: 12, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  const after = requireBox(await page.locator('#a1').boundingBox())

  const expected = expectedScreen(5, 5, 5, 5) // camera centred exactly on the anchor: screen centre
  expect(after.x + after.width / 2).toBeCloseTo(expected.x, 0)
  expect(after.y + after.height).toBeCloseTo(expected.y, 0)
})

test('overlay.offscreen_hidden_on_transition_only', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() => window.__rcOverlayAnchor?.('a1', 0, 0))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  await expect(page.locator('#a1')).toBeVisible()

  // Pan far enough that world (0, 0) leaves the 400x300 viewport plus margin.
  await page.evaluate(() => window.__rcMoveTo?.(100, 0, { tiles: 12, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  await expect(page.locator('#a1')).toBeHidden()

  const hiddenWrites = await styleWrites(page)
  // A further update with no camera change: no new transition, no extra write.
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  const stillHiddenWrites = await styleWrites(page)
  expect(stillHiddenWrites).toBe(hiddenWrites)

  // Pan back: visible again.
  await page.evaluate(() => window.__rcMoveTo?.(0, 0, { tiles: 12, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  await expect(page.locator('#a1')).toBeVisible()
})

test('overlay.slot_anchor_follows_rust', async ({ page }) => {
  await createReal(page)
  await page.evaluate(() =>
    window.__rcPublishDrawList?.([], 0, 0, { anchors: [{ slot: 5, x: 2, y: -1 }] }),
  )
  await page.evaluate(() => window.__rcPickAcquire?.())
  await page.evaluate(() => window.__rcOverlayAnchorSlot?.('s1', 5))
  await page.evaluate(() => window.__rcOverlayUpdate?.())

  const box = requireBox(await page.locator('#s1').boundingBox())
  const expected = expectedScreen(2, -1, 0, 0)
  expect(box.x + box.width / 2).toBeCloseTo(expected.x, 0)
  expect(box.y + box.height).toBeCloseTo(expected.y, 0)

  // A new publish moves the same slot: the anchor follows it, with no new `anchorSlot` call.
  await page.evaluate(() =>
    window.__rcPublishDrawList?.([], 0, 0, { anchors: [{ slot: 5, x: 5, y: 5 }] }),
  )
  await page.evaluate(() => window.__rcPickAcquire?.())
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  const box2 = requireBox(await page.locator('#s1').boundingBox())
  const expected2 = expectedScreen(5, 5, 0, 0)
  expect(box2.x + box2.width / 2).toBeCloseTo(expected2.x, 0)
  expect(box2.y + box2.height).toBeCloseTo(expected2.y, 0)

  // A publish that never touches slot 5 (its own `anchor_mask` bit unset): the anchor freezes at
  // its last known position rather than jumping to `(0, 0)` or hiding (Deviations: "frozen, not
  // hidden" is the TS reader's own policy).
  await page.evaluate(() => window.__rcPublishDrawList?.([], 0, 0, {}))
  await page.evaluate(() => window.__rcPickAcquire?.())
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  const box3 = requireBox(await page.locator('#s1').boundingBox())
  expect(box3.x).toBeCloseTo(box2.x, 0)
  expect(box3.y).toBeCloseTo(box2.y, 0)
})

test('overlay.widget_click_not_a_tap', async ({ page }) => {
  await createReal(page)
  // An anchored element sits above the canvas (`pointer-events: auto`, 0019 §4's own "Input over
  // DOM UI" shape -- `overlay/anchors.ts`'s static rule); a real click on it must never reach the
  // canvas as a `tap`.
  await page.evaluate(() => window.__rcOverlayAnchor?.('btn', 0, 0, 'center'))
  await page.evaluate(() => window.__rcOverlayUpdate?.())
  await page.locator('#btn').click()
  const tapCount = await page.evaluate(() => window.__rcCount?.('tap'))
  expect(tapCount ?? 0).toBe(0)
})
