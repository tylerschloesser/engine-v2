// M53b: the spawner panel and items on belts on the real reference page. Real mouse taps and button
// clicks for the panel; `SetSpawner` through the test hook for the flow; stepped ticks and frames
// only (0020 §4), every wait on observable state. Items are told apart by sprite id
// (`ITEM_SPRITE_FIRST + ItemId`); pixels compare the drawables pass on and off (`__pixelAt`), never
// an exact GPU colour.
import { expect, type Page, test } from '@playwright/test'
import {
  BELT,
  beltDraws,
  frame,
  ITEM,
  ITEM_SPRITE_FIRST,
  itemDraws,
  openGame,
  panTo,
  pickUpBelt,
  placeBelt,
  pumpUntil,
  type RefUiState,
  SPAWN_RATE,
  setSpawner,
  tileToScreen,
  uiState,
} from '../helpers/game.js'
import { SPAWNER_RUN, SPAWNER_STAND } from '../helpers/script.js'

type Rgba = [number, number, number, number]
declare global {
  interface Window {
    __pixelAt?: (x: number, y: number) => Promise<{ on: Rgba; off: Rgba }>
  }
}

const S = SPAWNER_RUN
const at = (dx: number) => ({ x: S.x + dx, y: S.y })
/** Lane centres across an east belt (`topology::LANE_INSET`, 68/256 from the tile's edges): lane 0
 * (the left, north) and lane 1, from the tile's top. */
const LANE_DY = [68 / 256, 1 - 68 / 256] as const

async function open(page: Page): Promise<void> {
  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription
  await panTo(page, SPAWNER_STAND)
}

/** A real mouse tap on `tile`'s centre; waits until its popover is open (`Ui.belt`). */
async function openBelt(page: Page, tile: { x: number; y: number }): Promise<RefUiState | null> {
  const p = await tileToScreen(page, tile.x + 0.5, tile.y + 0.5)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  await page.mouse.click(p.x, p.y)
  await frame(page)
  return pumpUntil(page, (u) => u?.belt?.at.x === tile.x && u.belt.at.y === tile.y)
}

/** Clicks `selector`, flushes the uplink, steps three ticks and waits until lane `lane` of the open
 * belt shows `want`. */
async function click(
  page: Page,
  selector: string,
  lane: 0 | 1,
  want: { item: number; rate: number } | null,
): Promise<RefUiState | null> {
  await page.locator(selector).click()
  await frame(page, 60) // the uplink is paced at 50 ms
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  return pumpUntil(page, (u) => {
    const got = u?.belt?.spawn[lane]
    return want === null ? got === null : got?.item === want.item && got?.rate === want.rate
  })
}

async function pixel(page: Page, x: number, y: number): Promise<{ on: Rgba; off: Rgba }> {
  const px = await page.evaluate(([a, b]) => window.__pixelAt?.(a, b), [x, y] as const)
  if (!px) throw new Error('no __pixelAt')
  return px
}
const diff = (a: Rgba, b: Rgba) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
const VISIBLE = 40

test('reference_belt_panel', async ({ page }) => {
  await open(page)
  await placeBelt(page, S, 'East', 'Spawner')
  await placeBelt(page, at(1), 'East', 'Belt')

  // A plain belt's popover has no spawner panel.
  await openBelt(page, at(1))
  await expect(page.locator('.belt-spawn')).toBeHidden()

  const ui = await openBelt(page, S)
  expect(ui?.belt?.kind).toBe('Spawner')
  expect(ui?.belt?.spawn, 'a placed spawner makes nothing').toEqual([null, null])
  const lane0 = '[data-spawn-lane="0"]'
  const lane1 = '[data-spawn-lane="1"]'
  await expect(page.locator('.belt-spawn')).toBeVisible()
  await expect(page.locator(`${lane0} [data-spawn-item="off"]`)).toHaveClass(/is-on/)
  await expect(page.locator(`${lane0} [data-spawn-rate="0"]`), 'no rate while off').toBeDisabled()

  // An item on an unset lane runs it at the belt's saturation; a rate button then changes the rate.
  await click(page, `${lane0} [data-spawn-item="${ITEM.iron}"]`, 0, {
    item: ITEM.iron,
    rate: SPAWN_RATE.saturation,
  })
  await click(page, `${lane0} [data-spawn-rate="${SPAWN_RATE.two}"]`, 0, {
    item: ITEM.iron,
    rate: SPAWN_RATE.two,
  })
  const both = await click(page, `${lane1} [data-spawn-item="${ITEM.coal}"]`, 1, {
    item: ITEM.coal,
    rate: SPAWN_RATE.saturation,
  })
  expect(both?.belt?.spawn).toEqual([
    { item: ITEM.iron, rate: SPAWN_RATE.two },
    { item: ITEM.coal, rate: SPAWN_RATE.saturation },
  ])
  await frame(page)
  await expect(page.locator(`${lane0} [data-spawn-item="${ITEM.iron}"]`)).toHaveClass(/is-on/)
  await expect(page.locator(`${lane0} [data-spawn-rate="${SPAWN_RATE.two}"]`)).toHaveClass(/is-on/)
  await expect(page.locator(`${lane0} [data-spawn-rate="${SPAWN_RATE.two}"]`)).toBeEnabled()

  // Off clears the lane; the other lane keeps its configuration.
  const off = await click(page, `${lane0} [data-spawn-item="off"]`, 0, null)
  expect(off?.belt?.spawn).toEqual([null, { item: ITEM.coal, rate: SPAWN_RATE.saturation }])
  await frame(page)
  await expect(page.locator(`${lane0} [data-spawn-rate="0"]`)).toBeDisabled()
})

test('reference_belt_items_flow', async ({ page }) => {
  await open(page)
  // The test page's canvas is 300 px wide: 10 tiles across is 30 px a tile, above the items' 20
  // (`content::ITEM_MIN_PX_PER_TILE`; at `panTo`'s 20 across nothing is drawn), centred on the run.
  await page.evaluate(([x, y, t]) => window.__setCamera?.(x, y, t), [
    S.x + 2,
    S.y + 0.5,
    10,
  ] as const)
  await frame(page)
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  await frame(page)
  await placeBelt(page, S, 'East', 'Spawner')
  await placeBelt(page, at(1), 'East', 'Belt')
  await placeBelt(page, at(2), 'East', 'Belt')
  await placeBelt(page, at(3), 'East', 'Despawner')
  await frame(page)
  expect(await itemDraws(page), 'no item before the spawner is configured').toEqual([])
  // DrawList positions are relative to the window origin: the spawner's record (pivot [0, 0]) is
  // the run's top-left corner there, `S` in the world.
  const sp = (await beltDraws(page)).placed.find((r) => r.spriteId === BELT.spawner)
  if (sp === undefined) throw new Error('the spawner is drawn')
  const LANE_Y = [sp.y + LANE_DY[0], sp.y + LANE_DY[1]] as const
  // The belt alone, where lane 0's items will pass (the reference for the item's pixel).
  const beltOnly = await pixel(page, S.x + 1.5, S.y + LANE_DY[0])

  await setSpawner(page, S, 0, ITEM.iron, SPAWN_RATE.saturation)
  await setSpawner(page, S, 1, ITEM.coal, SPAWN_RATE.saturation)
  // Past the first item's 4 tiles of travel (43 ticks): a steady flow.
  await page.evaluate((k) => window.__stepTick?.(k), 80)
  for (let f = 0; f < 10; f++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    await frame(page)
    const items = await itemDraws(page)
    // Both lanes saturated over the four tiles (1,024 positions a lane): an item every 683 / 256
    // ticks at 24 positions a tick, 64.03 positions apart, so 15 or 16 a lane by phase. A band, not
    // a mask: the count at a tick follows from the tick each schedule was set, and on this page the
    // dispatch-to-ack tick of `setSpawner` is not fixed (the uplink lands when the worker drains), so
    // the 10 sampled frames cover phases that cannot be named in advance; the exact per-tick counts
    // are pinned on the virtual clock by netcode `reference_belt_items_converge`.
    const lane = (y: number) => items.filter((r) => Math.abs(r.y - y) < 1e-3)
    const [l0, l1] = [lane(LANE_Y[0]), lane(LANE_Y[1])]
    expect(l0.length + l1.length, `frame ${f}: every item on a lane`).toBe(items.length)
    for (const [k, n] of [l0.length, l1.length].entries()) {
      expect([15, 16], `frame ${f}: lane ${k} holds ${n}`).toContain(n)
    }
    expect(new Set(l0.map((r) => r.spriteId)), 'lane 0 carries iron').toEqual(
      new Set([ITEM_SPRITE_FIRST + ITEM.iron]),
    )
    expect(new Set(l1.map((r) => r.spriteId)), 'lane 1 carries coal').toEqual(
      new Set([ITEM_SPRITE_FIRST + ITEM.coal]),
    )
    // Invariant, not a measured pin: items vanish at the despawner's front edge (none drawn past it)
    // and appear at the spawner's back (none behind it).
    for (const r of items) {
      expect(r.x, 'not past the despawner').toBeLessThanOrEqual(sp.x + 4)
      expect(r.x, 'not behind the spawner').toBeGreaterThanOrEqual(sp.x)
    }
  }

  // Invariant, not a measured pin: an iron item's centre differs from the belt drawn alone there and
  // from the terrain by more than `VISIBLE` (draws.spec.ts's threshold; no exact GPU colour).
  const items = await itemDraws(page)
  const iron = items.find((r) => r.spriteId === ITEM_SPRITE_FIRST + ITEM.iron)
  expect(iron, 'an iron item is drawn').toBeDefined()
  const it = iron as { x: number; y: number }
  const px = await pixel(page, it.x - sp.x + S.x, it.y - sp.y + S.y)
  expect(diff(px.on, beltOnly.on), 'the item over the belt').toBeGreaterThan(VISIBLE)
  expect(diff(px.on, px.off), 'the item over the terrain').toBeGreaterThan(VISIBLE)

  // The spawner picked up: the run drains into the despawner and nothing is drawn.
  await pickUpBelt(page, S)
  await page.evaluate((k) => window.__stepTick?.(k), 60)
  await frame(page)
  await frame(page)
  expect(await itemDraws(page), 'drained').toEqual([])
})
