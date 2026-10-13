// M55: undergrounds on the real reference page. The pair is placed through the palette (the
// underground entrance and exit tools, real mouse taps), the spawner behind it and the despawner
// ahead through the test hooks; stepped ticks and frames only (0020 §4), every wait on observable
// state. Items are told apart by sprite id (`ITEM_SPRITE_FIRST + ItemId`); positions are DrawList
// records relative to the spawner's (pivot [0, 0], its tile's top-left corner).
import { expect, type Page, test } from '@playwright/test'
import {
  BELT,
  beltDraws,
  beltSprite,
  type DrawRec,
  FLAG,
  frame,
  ITEM,
  ITEM_SPRITE_FIRST,
  itemDraws,
  openGame,
  panTo,
  pickTool,
  placeBelt,
  pumpUntil,
  SPAWN_RATE,
  setSpawner,
  tileToScreen,
  uiState,
} from '../helpers/game.js'
import {
  UNDERGROUND_FEED,
  UNDERGROUND_IN_AT,
  UNDERGROUND_OUT_AT,
  UNDERGROUND_STAND,
} from '../helpers/script.js'

const F = UNDERGROUND_FEED
const IN = UNDERGROUND_IN_AT
const OUT = UNDERGROUND_OUT_AT
/** Lane centres across an east belt (`topology::LANE_INSET`, 68/256 from the tile's edges). */
const LANE_DY = [68 / 256, 1 - 68 / 256] as const
const isPredicted = (r: DrawRec) => (r.flags & FLAG.predicted) !== 0

async function open(page: Page): Promise<void> {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await panTo(page, UNDERGROUND_STAND)
}

/** Turns `tool` on, taps `tile` with the mouse, waits for one more real (acked) belt record, then
 * ends construction mode. */
async function placeWithTool(
  page: Page,
  tool: 'underground-in' | 'underground-out',
  tile: { x: number; y: number },
): Promise<void> {
  const ui = await pickTool(page, tool)
  expect(ui?.tool?.dir, 'the tool faces east').toBe('East')
  const before = (await beltDraws(page)).placed.length
  const p = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  await page.mouse.click(p.x, p.y)
  await frame(page, 60) // the uplink is paced at 50 ms
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  for (let i = 0; i < 40; i++) {
    await frame(page)
    const { placed } = await beltDraws(page)
    if (placed.length === before + 1 && !placed.some(isPredicted)) break
    await page.evaluate((k) => window.__stepTick?.(k), 1)
  }
  await page.keyboard.press('Escape')
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (u) => u?.placing === false)
}

test('reference_underground_place_and_items', async ({ page }) => {
  await open(page)
  // 10 tiles across (30 px a tile on the 300 px test canvas: above the items' 20), on the passage.
  await page.evaluate(([x, y, t]) => window.__setCamera?.(x, y, t), [
    F.x + 3,
    F.y + 0.5,
    10,
  ] as const)
  await frame(page)
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  await frame(page)
  await placeBelt(page, F, 'East', 'Spawner')
  await placeWithTool(page, 'underground-in', IN)
  await placeWithTool(page, 'underground-out', OUT)
  await placeBelt(page, { x: OUT.x + 1, y: OUT.y }, 'East', 'Despawner')

  // The ends draw their own sprites (east: entrance 25, exit 28) and the two gap tiles nothing.
  const placed = (await beltDraws(page)).placed
  const sp = placed.find((r) => r.spriteId === BELT.spawner)
  if (sp === undefined) throw new Error('the spawner is drawn')
  const tileOf = (r: DrawRec) => Math.round(r.x - sp.x) + F.x
  const sprites = new Map(placed.map((r) => [tileOf(r), r.spriteId]))
  expect(sprites.get(IN.x), 'the entrance').toBe(beltSprite(BELT.undergroundIn, 'East').spriteId)
  expect(sprites.get(OUT.x), 'the exit').toBe(beltSprite(BELT.undergroundOut, 'East').spriteId)
  for (let x = IN.x + 1; x < OUT.x; x++) expect(sprites.has(x), `gap tile ${x}`).toBe(false)
  expect(placed.length, 'four records').toBe(4)

  await setSpawner(page, F, 0, ITEM.iron, SPAWN_RATE.saturation)
  await setSpawner(page, F, 1, ITEM.coal, SPAWN_RATE.saturation)
  // Past the first item's trip to the despawner (6 tiles, 64 ticks): a steady flow through the
  // hidden lines (768 positions a lane, 12 items each at this rate, 32 ticks underground).
  await page.evaluate((k) => window.__stepTick?.(k), 100)
  // In tiles from the spawner's left edge: the entrance's visible back half is [1, 1.5], the exit's
  // visible front half [4.5, 5]; the hoods and the gap between are (1.5, 4.5).
  const hidden = [IN.x - F.x + 0.5, OUT.x - F.x + 0.5] as const
  for (let f = 0; f < 10; f++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    await frame(page)
    const items = await itemDraws(page)
    const rel = items.map((r) => ({ x: r.x - sp.x, y: r.y - sp.y, id: r.spriteId }))
    // Invariant: no item drawn over the hoods or the gap tiles (an item on a hidden line has no
    // geometry: the replica holds no hidden line).
    for (const r of rel) {
      expect(
        r.x <= hidden[0] + 1e-3 || r.x >= hidden[1] - 1e-3,
        `frame ${f}: an item at ${r.x.toFixed(3)} over the hidden stretch`,
      ).toBe(true)
    }
    // Items on both visible halves, each lane (iron on lane 0, coal on lane 1): with 32 ticks of
    // travel underground in between, the hidden lines hold items while both halves show some.
    for (const [lane, item] of [ITEM.iron, ITEM.coal].entries()) {
      const onLane = rel.filter(
        (r) => Math.abs(r.y - (LANE_DY[lane] ?? -1)) < 1e-3 && r.id === ITEM_SPRITE_FIRST + item,
      )
      const entrance = onLane.filter((r) => r.x >= IN.x - F.x && r.x <= hidden[0] + 1e-3)
      const exit = onLane.filter((r) => r.x >= hidden[1] - 1e-3 && r.x <= OUT.x - F.x + 1)
      expect(entrance.length, `frame ${f}: lane ${lane} on the entrance half`).toBeGreaterThan(0)
      expect(exit.length, `frame ${f}: lane ${lane} on the exit half`).toBeGreaterThan(0)
    }
  }
})

// M55 fix round 1: with the two underground tools the palette is wider than a phone; at the 390 px
// width of the iPhone 12 and the Pixel 5 it wraps, so every button (the six belt tools and Rotate,
// a belt tool on; no furnace, so no Build button) lies inside the viewport.
test('reference_underground_palette_fits_a_phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await pickTool(page, 'underground-in')
  const buttons = page.locator('.build-palette button:visible')
  await expect(buttons).toHaveCount(7)
  for (const b of await buttons.all()) {
    const box = await b.boundingBox()
    if (box === null) throw new Error('a visible button has a box')
    const text = await b.textContent()
    expect(box.x, `${text}: left edge`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${text}: right edge`).toBeLessThanOrEqual(390)
  }
})
