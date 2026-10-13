// M54: the splitter tool in construction mode (`src/ui/build.ts`) and its popover (`src/ui/belt.ts`):
// a 2x1 ghost at the cursor tile tinted by the placement rule over the whole footprint, a placement
// drawn as one sprite (east `BELT.splitter`, west the same mirrored), Rotate from the popover turning
// it 180 degrees in place, Pick up emptying both tiles, and the touch Confirm under the footprint for
// both axes. Real Playwright mouse and keyboard input, touch pointers injected, stepped ticks and
// frames only (0020 §4).
import { expect, type Page, test } from '@playwright/test'
import {
  BELT,
  BELT_TILE,
  beltDraws,
  beltSprite,
  type DrawRec,
  FLAG,
  frame,
  GHOST,
  openGame,
  panTo,
  pickTool,
  pumpUntil,
  tileToScreen,
  uiState,
} from '../helpers/game.js'

/** Free land under `TEST_SEED` for a splitter either way from `BELT_TILE.free` (the furnace's free
 * 2x2 origin): facing east it covers (-4, -1) and (-4, 0), facing south (-4, -1) and (-3, -1). */
const AT = BELT_TILE.free
/** Land at (3, -1) with water south of it (`WATER` of `belt-construction.spec.ts`): a splitter
 * facing east from here has its second tile on water. */
const SHORE = { x: 3, y: -1 } as const

const isPredicted = (r: DrawRec | undefined) => ((r?.flags ?? 0) & FLAG.predicted) !== 0
const facing = (r: DrawRec | undefined) => ({
  spriteId: r?.spriteId,
  flipX: ((r?.flags ?? 0) & FLAG.flipX) !== 0,
})

async function open(page: Page): Promise<void> {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await panTo(page, { x: 0, y: 0 })
}

async function hover(page: Page, tile: { x: number; y: number }): Promise<DrawRec[]> {
  const p = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  return (await beltDraws(page)).ghost
}

/** Steps ticks and frames until the placed records satisfy `done` and none is predicted. */
async function settle(page: Page, done: (placed: DrawRec[]) => boolean): Promise<DrawRec[]> {
  await frame(page, 60) // the uplink is paced at 50 ms
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  for (let i = 0; i < 40; i++) {
    await frame(page)
    const { placed } = await beltDraws(page)
    if (done(placed) && !placed.some(isPredicted)) return placed
    await page.evaluate((k) => window.__stepTick?.(k), 1)
  }
  throw new Error('settle: condition not met')
}

/** Taps `tile` with the mouse and waits until the popover names the splitter at `AT`. */
async function tapSplitter(page: Page, tile: { x: number; y: number }) {
  const p = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  await page.mouse.click(p.x, p.y)
  await frame(page)
  return pumpUntil(page, (ui) => ui?.belt?.at.x === AT.x && ui.belt.at.y === AT.y)
}

test('reference_splitter_place_rotate_pickup', async ({ page }) => {
  await open(page)
  expect((await pickTool(page, 'splitter'))?.tool).toEqual({
    tool: { Belt: 'Splitter' },
    dir: 'East',
  })
  // The 2x1 ghost: the east splitter sprite at the cursor tile, valid on free land, invalid when its
  // second tile is water though its first is land.
  const ok = await hover(page, AT)
  expect(ok.map(facing)).toEqual([beltSprite(BELT.splitter, 'East')])
  expect(ok[0]?.color).toBe(GHOST.valid)
  expect((await hover(page, SHORE))[0]?.color, 'the second tile on water').toBe(GHOST.invalid)

  // A mouse tap places it: predicted at once, then real; one record for both tiles.
  const ghost = await hover(page, AT)
  expect(ghost[0]?.color).toBe(GHOST.valid)
  const p = await tileToScreen(page, AT.x + 0.5, AT.y + 0.5)
  await page.mouse.click(p.x, p.y)
  await frame(page)
  await frame(page)
  const predicted = (await beltDraws(page)).placed
  expect(predicted.length).toBe(1)
  expect(isPredicted(predicted[0]), 'predicted without a tick').toBe(true)
  const real = await settle(page, (placed) => placed.length === 1)
  expect(real.map(facing)).toEqual([beltSprite(BELT.splitter, 'East')])
  // The second tile is taken now: the ghost there is invalid.
  expect((await hover(page, { x: AT.x, y: AT.y + 1 }))[0]?.color).toBe(GHOST.invalid)
  await page.keyboard.press('Escape')
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (ui) => ui?.placing === false)

  // A tap on its second (south) tile opens its popover, keyed by its anchor.
  const opened = await tapSplitter(page, { x: AT.x, y: AT.y + 1 })
  expect(opened?.belt).toEqual({ at: AT, dir: 'East', kind: 'Splitter', spawn: [null, null] })
  await frame(page)
  await expect(page.locator('.belt-popover')).toBeVisible()

  // Rotate: 180 degrees in place, the east sprite mirrored, at the same place.
  await page.locator('[data-belt-rotate]').click()
  const turned = await settle(
    page,
    (placed) => placed.length === 1 && ((placed[0]?.flags ?? 0) & FLAG.flipX) !== 0,
  )
  expect(turned.map(facing)).toEqual([beltSprite(BELT.splitter, 'West')])
  expect([turned[0]?.x, turned[0]?.y], 'the footprint did not move').toEqual([
    real[0]?.x,
    real[0]?.y,
  ])
  expect((await pumpUntil(page, (ui) => ui?.belt?.dir === 'West'))?.belt?.dir).toBe('West')

  // Pick up: nothing is drawn and both tiles take a splitter's ghost again.
  await page.locator('[data-belt-pickup]').click()
  expect(await settle(page, (placed) => placed.length === 0)).toEqual([])
  expect((await pumpUntil(page, (ui) => ui?.belt === null))?.belt).toBeNull()
  await pickTool(page, 'splitter')
  expect((await hover(page, AT))[0]?.color).toBe(GHOST.valid)
  expect((await hover(page, { x: AT.x, y: AT.y + 1 }))[0]?.color).toBe(GHOST.valid)
})

test('reference_splitter_touch_confirm', async ({ page }) => {
  await open(page)
  await pickTool(page, 'splitter')
  const confirm = page.locator('.build-confirm')
  const touch = async (tile: { x: number; y: number }) => {
    const at = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
    await page.evaluate(([x, y]) => window.__injectPointer?.('down', 1, x, y, 0, 'touch'), [
      at.x,
      at.y,
    ] as const)
    await frame(page, 16)
    await page.evaluate(([x, y]) => window.__injectPointer?.('up', 1, x, y, 40, 'touch'), [
      at.x,
      at.y,
    ] as const)
    await frame(page, 16)
    await frame(page, 16)
  }
  /** Confirm's top centre is the world point `(x, y)`, within 1 CSS px. */
  const confirmAt = async (x: number, y: number) => {
    await expect(confirm).toBeVisible()
    const box = await confirm.boundingBox()
    const want = await tileToScreen(page, x, y)
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - want.x)).toBeLessThanOrEqual(1)
    expect(Math.abs((box?.y ?? 0) - want.y)).toBeLessThanOrEqual(1)
  }

  // Facing east the footprint is 1 x 2: Confirm under it at (x + 0.5, y + 2).
  await touch(AT)
  const { ghost, placed } = await beltDraws(page)
  expect(ghost.map((r) => [facing(r), r.color])).toEqual([
    [beltSprite(BELT.splitter, 'East'), GHOST.valid],
  ])
  expect(placed, 'a touch tap alone places nothing').toEqual([])
  await confirmAt(AT.x + 0.5, AT.y + 2)

  // `R` turns the tool south: 2 x 1, Confirm follows to (x + 1, y + 1).
  await page.keyboard.press('KeyR')
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (ui) => ui?.tool?.dir === 'South')
  await frame(page)
  await confirmAt(AT.x + 1, AT.y + 1)
  expect((await beltDraws(page)).ghost.map(facing)).toEqual([beltSprite(BELT.splitter, 'South')])

  // Confirm places the south splitter.
  await confirm.click()
  await frame(page)
  await frame(page)
  expect((await beltDraws(page)).placed.length).toBe(1)
  const real = await settle(page, (p) => p.length === 1)
  expect(real.map(facing)).toEqual([beltSprite(BELT.splitter, 'South')])
})
