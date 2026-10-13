// M51b: the belt tools in construction mode (`src/ui/build.ts`). Real Playwright mouse, keyboard and
// button input on the real page; touch pointers injected (`__injectPointer`); stepped ticks and
// frames only (0020 §4). Belt records are told apart by sprite id (`BELT`), the ghost by its
// `ANCHOR_CURSOR_TILE` flag (`beltDraws`).
import { expect, type Page, test } from '@playwright/test'
import {
  BELT,
  BELT_TILE,
  beltDraws,
  beltSprite,
  craftFurnace,
  type Dir,
  type DrawRec,
  FLAG,
  frame,
  GHOST,
  openFurnace,
  openGame,
  PLACE,
  panTo,
  pickTool,
  pickUpBelt,
  placeBelt,
  placeFurnace,
  pumpUntil,
  rotateBelt,
  tileToScreen,
  uiState,
} from '../helpers/game.js'
import { BELT_SCRIPT_HASH, beltScript, domDriver, runScript } from '../helpers/script.js'

/** A provisional entity id has bit 31 set (0022 section 5). */
const PROVISIONAL_BIT = 2 ** 31
/** Water under `TEST_SEED` (`browser_fixture_tiles_hold`: the shore-water footprint's wet tile). */
const WATER = { x: 3, y: 0 } as const
/** A wood resource out of collect range from (0, 0), so no collect button covers it. */
const WOOD = { x: -4, y: -2 } as const

const isPredicted = (r: DrawRec | undefined) => ((r?.flags ?? 0) & FLAG.predicted) !== 0
const facing = (r: DrawRec | undefined) => ({
  spriteId: r?.spriteId,
  flipX: ((r?.flags ?? 0) & FLAG.flipX) !== 0,
})

async function open(page: Page): Promise<void> {
  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription
  await panTo(page, { x: 0, y: 0 })
}

/** Hovers the mouse over `tile`'s centre and returns the belt ghost records of the next frame. */
async function hover(page: Page, tile: { x: number; y: number }): Promise<DrawRec[]> {
  const p = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  return (await beltDraws(page)).ghost
}

/** Steps until `Ui.tool.dir` is `dir` (a rotate's local intent drains in a frame). */
async function untilDir(page: Page, dir: Dir): Promise<void> {
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (ui) => ui?.tool?.dir === dir)
}

/** Steps a tick and a frame at a time across the host's ack: every frame draws exactly one placed
 * belt, the same tile throughout, until it is the real one. Returns that record. */
async function untilReal(page: Page, first: DrawRec | undefined): Promise<DrawRec | undefined> {
  await frame(page, 60) // the uplink is paced at 50 ms
  for (let i = 0; i < 40; i++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    await frame(page)
    const { placed } = await beltDraws(page)
    expect(placed.length, `frame ${i}: exactly one placed belt`).toBe(1)
    expect([placed[0]?.x, placed[0]?.y], 'same tile across the swap').toEqual([first?.x, first?.y])
    if (!isPredicted(placed[0])) return placed[0]
  }
  throw new Error('the ack never replaced the predicted belt')
}

test('reference_belt_place_rotate_pickup', async ({ page }) => {
  await open(page)
  const rotate = page.locator('[data-build-rotate]')
  await expect(rotate).toBeHidden()
  expect((await pickTool(page, 'belt'))?.tool).toEqual({ tool: { Belt: 'Belt' }, dir: 'East' })
  await expect(rotate).toBeVisible()

  // Rotate twice: East -> South -> West, on the button's `data-dir` too.
  await rotate.click()
  await untilDir(page, 'South')
  await rotate.click()
  await untilDir(page, 'West')
  await frame(page)
  await expect(rotate).toHaveAttribute('data-dir', 'West')

  // A mouse tap places a belt facing West: the east sprite mirrored.
  const ghost = await hover(page, BELT_TILE.free)
  expect(ghost.map(facing)).toEqual([beltSprite(BELT.straight, 'West')])
  const p = await tileToScreen(page, BELT_TILE.free.x + 0.5, BELT_TILE.free.y + 0.5)
  await page.mouse.click(p.x, p.y)
  await frame(page)
  await frame(page)
  const predicted = (await beltDraws(page)).placed
  expect(predicted.length, 'predicted belt appears without a tick').toBe(1)
  const real = await untilReal(page, predicted[0])
  expect(facing(real)).toEqual(beltSprite(BELT.straight, 'West'))
  expect(real?.pickId, 'real id after the ack').toBeLessThan(PROVISIONAL_BIT)
  // The belt tool is free: construction mode stays on after a placement.
  expect((await uiState(page))?.placing).toBe(true)

  // Escape ends construction mode; then the placed belt turns clockwise (West -> North) and goes.
  await page.keyboard.press('Escape')
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (ui) => ui?.placing === false)
  await expect(rotate).toBeHidden()
  const turned = await rotateBelt(page, BELT_TILE.free)
  expect(turned.map(facing)).toEqual([beltSprite(BELT.straight, 'North')])
  expect(await pickUpBelt(page, BELT_TILE.free)).toEqual([])
})

test('reference_belt_ghost_predicted', async ({ page }) => {
  await open(page)
  await frame(page)
  expect((await beltDraws(page)).ghost, 'no ghost outside construction mode').toEqual([])
  await pickTool(page, 'spawner')

  // The ghost is the spawner sprite facing East at the cursor tile, tinted by the belt rule.
  const ok = await hover(page, BELT_TILE.free)
  expect(ok.length).toBe(1)
  expect(facing(ok[0])).toEqual(beltSprite(BELT.spawner, 'East'))
  expect(ok[0]?.color).toBe(GHOST.valid)
  expect(await page.evaluate(() => window.__cursorTile?.())).toEqual({
    ...BELT_TILE.free,
    valid: true,
  })
  expect((await hover(page, WATER))[0]?.color, 'water').toBe(GHOST.invalid)
  // No belt on a resource (README "Belts", Placement), unlike a furnace.
  expect((await hover(page, WOOD))[0]?.color, 'a resource').toBe(GHOST.invalid)
  expect((await hover(page, BELT_TILE.free))[0]?.color).toBe(GHOST.valid)

  // A tap draws the PREDICTED spawner at once, then the real one; the ghost stays.
  const p = await tileToScreen(page, BELT_TILE.free.x + 0.5, BELT_TILE.free.y + 0.5)
  await page.mouse.click(p.x, p.y)
  await frame(page)
  await frame(page)
  const { placed, ghost } = await beltDraws(page)
  expect(placed.length).toBe(1)
  expect(isPredicted(placed[0]), 'predicted spawner without a tick').toBe(true)
  expect(placed[0]?.pickId).toBeGreaterThanOrEqual(PROVISIONAL_BIT)
  expect(facing(placed[0])).toEqual(beltSprite(BELT.spawner, 'East'))
  expect(ghost.length, 'the ghost stays').toBe(1)
  const real = await untilReal(page, placed[0])
  expect(facing(real)).toEqual(beltSprite(BELT.spawner, 'East'))
  // The tile is taken: the ghost over it turns invalid, and a tap there is refused: the reason line
  // and the tool button's flash (a CSS class for 300 ms of real time, read right after each step).
  expect((await hover(page, BELT_TILE.free))[0]?.color, 'an occupied tile').toBe(GHOST.invalid)
  await page.mouse.click(p.x, p.y)
  await frame(page, 60)
  let flashed = ''
  for (let i = 0; i < 40 && flashed === ''; i++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    flashed = await page.evaluate(async () => {
      await window.__stepFrame?.(16)
      const cls = document.querySelector('[data-tool="spawner"]')?.className ?? ''
      return cls.includes('reject-') ? cls : ''
    })
  }
  expect(flashed, 'the spawner tool flashes the refusal').toContain('reject-notbuildable')
  await expect(page.locator('.build-reason')).toHaveAttribute('data-reason', 'NotBuildable')
})

test('reference_belt_touch_confirm', async ({ page }) => {
  await open(page)
  await pickTool(page, 'belt')
  const confirm = page.locator('.build-confirm')
  await expect(confirm).toBeHidden()

  // A touch tap moves the ghost (the cursor tile) and shows Confirm; it places nothing.
  const at = await tileToScreen(page, BELT_TILE.free.x + 0.5, BELT_TILE.free.y + 0.5)
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
  expect(await page.evaluate(() => window.__cursorTile?.())).toEqual({
    ...BELT_TILE.free,
    valid: true,
  })
  const { ghost, placed } = await beltDraws(page)
  expect(ghost.map((r) => r.color)).toEqual([GHOST.valid])
  expect(placed, 'a touch tap alone places nothing').toEqual([])

  // Confirm sits centred under the 1x1 ghost, within 1 CSS px: the world point (x + 0.5, y + 1).
  await expect(confirm).toBeVisible()
  await expect(confirm).toHaveAttribute(
    'data-build-confirm',
    `${BELT_TILE.free.x},${BELT_TILE.free.y}`,
  )
  const box = await confirm.boundingBox()
  const want = await tileToScreen(page, BELT_TILE.free.x + 0.5, BELT_TILE.free.y + 1)
  expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - want.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((box?.y ?? 0) - want.y)).toBeLessThanOrEqual(1)

  // Confirm places: predicted, then real.
  await confirm.click()
  await frame(page)
  await frame(page)
  const first = (await beltDraws(page)).placed
  expect(first.length).toBe(1)
  expect(isPredicted(first[0])).toBe(true)
  const real = await untilReal(page, first[0])
  expect(facing(real)).toEqual(beltSprite(BELT.straight, 'East'))
})

test('reference_belt_keyboard_rotate', async ({ page }) => {
  await open(page)
  // `R` outside a belt tool does nothing.
  await page.keyboard.press('KeyR')
  await pickTool(page, 'despawner')
  expect((await uiState(page))?.tool?.dir).toBe('East')
  expect((await hover(page, BELT_TILE.free)).map(facing)).toEqual([
    beltSprite(BELT.despawner, 'East'),
  ])

  const rotate = page.locator('[data-build-rotate]')
  const width0 = (await rotate.boundingBox())?.width
  await page.keyboard.press('KeyR')
  await untilDir(page, 'South')
  expect((await hover(page, BELT_TILE.free)).map(facing)).toEqual([
    beltSprite(BELT.despawner, 'South'),
  ])
  await expect(rotate).toHaveAttribute('data-dir', 'South')
  expect((await rotate.boundingBox())?.width, 'Rotate keeps its width').toBe(width0)
  await page.keyboard.press('KeyR')
  await untilDir(page, 'West')
  expect((await hover(page, BELT_TILE.free)).map(facing)).toEqual([
    beltSprite(BELT.despawner, 'West'),
  ])

  // Escape ends the mode and the ghost; the direction survives into the next tool.
  await page.keyboard.press('Escape')
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (ui) => ui?.placing === false)
  expect(await hover(page, BELT_TILE.free)).toEqual([])
  await page.keyboard.press('KeyR') // off: ignored
  expect((await pickTool(page, 'belt'))?.tool?.dir).toBe('West')

  // `R` then a tap before any frame: the page turned its own direction at the key, so the belt
  // faces North (what the ghost shows next), not the West of the last `Ui`.
  const p = await tileToScreen(page, BELT_TILE.free.x + 0.5, BELT_TILE.free.y + 0.5)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  await page.keyboard.press('KeyR')
  await page.mouse.click(p.x, p.y)
  await frame(page)
  await frame(page)
  const first = (await beltDraws(page)).placed
  expect(first.length).toBe(1)
  expect(facing(await untilReal(page, first[0]))).toEqual(beltSprite(BELT.straight, 'North'))
})

test('reference_belt_tool_palette', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await pumpUntil(page, (ui) => ui !== null)
  const furnaceTool = page.locator('.build-button')
  const tools = page.locator('.tool-button')

  // No furnace: the belt tools only.
  expect((await uiState(page))?.can_build).toBe(false)
  await expect(furnaceTool).toBeHidden()
  await expect(tools).toHaveText(['Belt', 'Spawner', 'Despawner', 'Splitter'])
  for (const t of await tools.all()) await expect(t).toBeVisible()

  // A tool button turns its tool on, another switches, the same one again turns it off.
  await pickTool(page, 'spawner')
  await expect(page.locator('[data-tool="spawner"]')).toHaveClass(/is-on/)
  await pickTool(page, 'despawner')
  await expect(page.locator('[data-tool="spawner"]')).not.toHaveClass(/is-on/)
  await page.locator('[data-tool="despawner"]').click()
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  expect((await pumpUntil(page, (ui) => ui?.placing === false))?.tool).toBeNull()

  // A furnace in the inventory adds the furnace tool; the belt tools stay.
  await craftFurnace(page)
  await expect(furnaceTool).toBeVisible()
  for (const t of await tools.all()) await expect(t).toBeVisible()
  await furnaceTool.click()
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  expect((await pumpUntil(page, (ui) => ui?.placing === true))?.tool?.tool).toBe('Furnace')
  await expect(page.locator('[data-build-rotate]')).toBeHidden()
})

test('reference_belt_popover', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await craftFurnace(page)
  await panTo(page, { x: 0, y: 0 })
  await placeBelt(page, BELT_TILE.free, 'East')
  await placeFurnace(page, PLACE.shoreOk)
  const popover = page.locator('.belt-popover')
  const panel = page.locator('.furnace-panel')
  await expect(popover).toBeHidden()

  // A tap on the belt opens its popover (not the furnace panel).
  const tapBelt = async () => {
    const p = await tileToScreen(page, BELT_TILE.free.x + 0.5, BELT_TILE.free.y + 0.5)
    await page.mouse.move(p.x, p.y)
    await frame(page)
    await page.mouse.click(p.x, p.y)
    await frame(page)
    return pumpUntil(
      page,
      (ui) => ui?.belt?.at.x === BELT_TILE.free.x && ui.belt.at.y === BELT_TILE.free.y,
    )
  }
  const opened = await tapBelt()
  expect(opened?.belt).toEqual({
    at: BELT_TILE.free,
    dir: 'East',
    kind: 'Belt',
    spawn: [null, null],
  })
  expect(opened?.furnace).toBeNull()
  await frame(page)
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-belt', `${BELT_TILE.free.x},${BELT_TILE.free.y}`)
  await expect(panel).toBeHidden()

  // Rotate: the real sprite turns East -> South; the popover stays.
  await page.locator('[data-belt-rotate]').click()
  await frame(page, 60) // the uplink is paced at 50 ms
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  let turned: DrawRec | undefined
  for (let i = 0; i < 40; i++) {
    await frame(page)
    const { placed } = await beltDraws(page)
    turned = placed[0]
    if (placed.length === 1 && !isPredicted(turned) && turned?.spriteId === BELT.straight + 1) break
    await page.evaluate((k) => window.__stepTick?.(k), 1)
  }
  expect(facing(turned)).toEqual(beltSprite(BELT.straight, 'South'))
  expect(isPredicted(turned)).toBe(false)
  expect((await pumpUntil(page, (ui) => ui?.belt?.dir === 'South'))?.belt?.dir).toBe('South')
  await expect(popover).toBeVisible()

  // A tap on the furnace opens its panel and closes the popover: never both.
  const withFurnace = await openFurnace(page, PLACE.shoreOk)
  expect(withFurnace?.belt).toBeNull()
  await frame(page)
  await expect(panel).toBeVisible()
  await expect(popover).toBeHidden()

  // Back on the belt, Pick up: the tile empties and the popover closes.
  await tapBelt()
  await frame(page)
  await expect(panel).toBeHidden()
  await page.locator('[data-belt-pickup]').click()
  await frame(page, 60)
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  const closed = await pumpUntil(page, (ui) => ui?.belt === null)
  expect(closed?.belt).toBeNull()
  for (let i = 0; i < 40 && (await beltDraws(page)).placed.length > 0; i++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    await frame(page)
  }
  expect((await beltDraws(page)).placed, 'the tile is empty').toEqual([])
  await frame(page)
  await expect(popover).toBeHidden()
})

// The DOM driver runs the same belt steps through the palette and the popover and must end on the
// headless run's state hash (`reference_belt_script_headless` pins `BELT_SCRIPT_HASH`).
test('reference_belt_script_dom', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await runScript(beltScript(), await domDriver(page))
  await page.evaluate(() => window.__stepTick?.(1))
  expect(await page.evaluate(() => window.__worldHash?.()), 'state hash vs the headless run').toBe(
    BELT_SCRIPT_HASH,
  )
})
