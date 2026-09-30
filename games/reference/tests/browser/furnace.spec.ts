// `reference_furnace_flow`, `reference_furnace_panel_survives_swap`, `reference_furnace_pick_up`
// (docs/plan/33b-reference-furnace-operation.md Tests added). Real mouse taps on the real canvas and
// real clicks on the panel's buttons; stepped ticks and frames only (a smelt is 100 ticks, never 5 s
// of waiting). The visuals are read back as pixels on the production page (`window.__pixelAt`,
// compared with the drawables pass off) as well as from the DrawList.
import { expect, type Page, test } from '@playwright/test'
import {
  collectN,
  craftFurnace,
  deposit,
  draws,
  frame,
  ITEM,
  KIND,
  openFurnace,
  openGame,
  PLACE,
  panTo,
  pickUp,
  placeFurnace,
  pumpUntil,
  takeAll,
  tileToScreen,
  uiState,
} from '../helpers/game.js'

type Rgba = [number, number, number, number]
declare global {
  interface Window {
    __pickAt?: (x: number, y: number) => number
    __pixelAt?: (x: number, y: number) => Promise<{ on: Rgba; off: Rgba }>
  }
}

const PROVISIONAL_BIT = 2 ** 31
const O = PLACE.free

async function pixel(page: Page, x: number, y: number): Promise<{ on: Rgba; off: Rgba }> {
  const px = await page.evaluate(([a, b]) => window.__pixelAt?.(a, b), [x, y] as const)
  if (!px) throw new Error('no __pixelAt')
  return px
}

/** Sum of absolute RGB differences between the pass on and off at a world point. */
async function delta(page: Page, x: number, y: number): Promise<number> {
  const { on, off } = await pixel(page, x, y)
  return [0, 1, 2].reduce((a, i) => a + Math.abs((on[i] as number) - (off[i] as number)), 0)
}

const VISIBLE = 40

/** The open-furnace outline: visible `rect`s (the transparent pick rect has colour 0). */
const outline = (r: { kind: number; color: number }) => r.kind === KIND.rect && r.color !== 0

/** A craftable, placed furnace with `iron` iron and one wood in the inventory (panel not open). */
async function stocked(page: Page, iron: number, wood: number): Promise<void> {
  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription
  await craftFurnace(page)
  if (iron > 0) await collectN(page, 'iron', iron)
  if (wood > 0) await collectN(page, 'wood', wood)
  // Stand five tiles west, out of collect range of every resource, so no collect button sits over
  // the panel (`.collect-button` would intercept its clicks).
  await panTo(page, { x: O.x - 5, y: O.y })
  await placeFurnace(page, O)
  await frame(page)
}

test('reference_furnace_flow', async ({ page }) => {
  await stocked(page, 1, 1)

  // Idle and closed: a dark mouth, no bar, no outline.
  const mouth = { x: O.x + 1, y: O.y + 1.25 }
  expect((await pixel(page, mouth.x, mouth.y)).on[0], 'cold mouth is dark').toBeLessThan(80)
  expect((await draws(page)).filter((r) => r.kind === KIND.bar || outline(r))).toEqual([])

  // M33d: the sprite table reaches the production picker only through `attachClientDrawables`
  // (`game.ts`, no test hook installs it): a point inside the 2 x 2 art, away from `pos` (the
  // origin corner, pivot [0, 0]), picks the furnace; one just outside it does not.
  const furnacePick = (await draws(page)).find((r) => r.kind === KIND.sprite)?.pickId
  expect(furnacePick, 'the furnace sprite carries a pick id').toBeGreaterThan(0)
  const inside = await tileToScreen(page, O.x + 1.5, O.y + 1.5)
  expect(
    await page.evaluate(([x, y]) => window.__pickAt?.(x, y), [inside.x, inside.y] as const),
    'a tap inside the furnace art picks it',
  ).toBe(furnacePick)
  const outside = await tileToScreen(page, O.x + 2.5, O.y + 1.5)
  expect(
    await page.evaluate(([x, y]) => window.__pickAt?.(x, y), [outside.x, outside.y] as const),
    'just outside the art picks nothing',
  ).toBe(0)

  // Tap the furnace: the panel opens, anchored above it, with an outline on the furnace.
  const ui = await openFurnace(page, O)
  expect(ui?.furnace).toMatchObject({ iron_in: 0, coal: 0, wood: 0, ingots_out: 0 })
  const panel = page.locator('.furnace-panel')
  await expect(panel).toBeVisible()
  await frame(page)
  const box = await panel.boundingBox()
  const anchor = await tileToScreen(page, O.x + 1, O.y)
  expect(box, 'panel has a box').toBeTruthy()
  if (box) {
    expect(box.x, 'panel centred on the furnace').toBeLessThan(anchor.x)
    expect(box.x + box.width).toBeGreaterThan(anchor.x)
    expect(box.y + box.height, 'panel sits above the furnace').toBeLessThanOrEqual(anchor.y + 2)
  }
  expect((await draws(page)).filter(outline).length, 'four edges').toBe(4)
  const edge = await pixel(page, O.x + 0.05, O.y + 1)
  expect(
    await delta(page, O.x + 0.05, O.y + 1),
    'outline pixel differs from terrain',
  ).toBeGreaterThan(VISIBLE)
  expect(edge.on[0] > 200 && edge.on[1] > 180 && edge.on[2] < 120, 'outline is yellow').toBe(true)

  // Deposit iron and wood from the panel; the smelt starts.
  await deposit(page, 'iron', 1)
  await deposit(page, 'wood', 1)
  const started = await pumpUntil(
    page,
    (u) => u?.furnace?.smelt_done_at !== null && u?.furnace?.smelt_done_at !== undefined,
  )
  expect(started?.furnace).toMatchObject({ iron_in: 1, wood: 0, burn_left: 2 })
  expect(started?.inventory[ITEM.iron]).toBe(0)
  await expect(page.locator('[data-count="iron_in"]')).toHaveAttribute('data-value', '1')
  await expect(page.locator('.furnace-progress')).toHaveClass(/is-smelting/)

  // Mid-smelt: the lit frame and the bar are in the DrawList and on screen.
  await page.evaluate((k) => window.__stepTick?.(k), 50)
  await frame(page)
  const recs = await draws(page)
  expect(recs.find((r) => r.kind === KIND.sprite)?.param, 'lit frame').toBe(1)
  const bars = recs.filter((r) => r.kind === KIND.bar)
  expect(bars.length).toBe(1)
  expect(bars[0]?.param, 'progress about half').toBeGreaterThan(0.3)
  expect(bars[0]?.param).toBeLessThan(0.7)
  const lit = await pixel(page, mouth.x, mouth.y)
  expect(lit.on[0], 'lit mouth glows').toBeGreaterThan(200)
  expect(await delta(page, O.x + 0.25, O.y - 0.11), 'filled part of the bar').toBeGreaterThan(
    VISIBLE,
  )
  expect(await delta(page, O.x + 1.85, O.y - 0.11), 'unfilled part shows terrain').toBeLessThan(10)

  // Zoomed far out the bar is skipped (a strip under 3 px), and drawn again on zooming back in.
  await page.evaluate(([x, y]) => window.__setCamera?.(x, y, 400), [O.x, O.y] as const)
  await frame(page)
  await frame(page)
  expect(
    (await draws(page)).filter((r) => r.kind === KIND.bar),
    'no bar when zoomed out',
  ).toEqual([])
  await page.evaluate(([x, y]) => window.__setCamera?.(x, y, 20), [O.x - 5, O.y] as const)
  await frame(page)
  await frame(page)
  expect((await draws(page)).filter((r) => r.kind === KIND.bar).length, 'bar is back').toBe(1)

  // Finish the smelt; take all; the ingot is in the inventory.
  await page.evaluate((k) => window.__stepTick?.(k), 55)
  await pumpUntil(page, (u) => u?.furnace?.ingots_out === 1)
  await takeAll(page)
  const taken = await pumpUntil(page, (u) => (u?.inventory[ITEM.ingot] ?? 0) === 1)
  expect(taken?.furnace?.ingots_out).toBe(0)

  // Close: the panel and the outline go.
  await page.locator('[data-furnace-close]').click()
  await frame(page)
  await pumpUntil(page, (u) => u?.furnace === null)
  await frame(page)
  await expect(panel).toBeHidden()
  expect((await draws(page)).filter(outline)).toEqual([])
  const gone = await pixel(page, O.x + 0.05, O.y + 1)
  expect(gone.on[0] > 200 && gone.on[1] > 180 && gone.on[2] < 120, 'no yellow left').toBe(false)
})

test('reference_furnace_panel_survives_swap', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  await uiState(page)
  await craftFurnace(page)
  await panTo(page, { x: O.x + 2, y: O.y + 1 })

  // Place and open the panel on the predicted furnace before the ack.
  await page.evaluate(([x, y]) => window.__dispatchPlaceFurnace?.(x, y), [O.x, O.y] as const)
  await frame(page)
  await frame(page)
  const predicted = (await draws(page)).find((r) => r.kind === KIND.sprite)
  expect(predicted?.pickId, 'predicted furnace').toBeGreaterThanOrEqual(PROVISIONAL_BIT)
  await openFurnace(page, O)
  await expect(page.locator('.furnace-panel')).toBeVisible()

  // Step across the ack: the furnace's id changes, the panel stays on the same tile.
  let real = false
  for (let i = 0; i < 40 && !real; i++) {
    await page.evaluate((k) => window.__stepTick?.(k), 1)
    await frame(page)
    const rec = (await draws(page)).find((r) => r.kind === KIND.sprite)
    real = rec !== undefined && rec.pickId < PROVISIONAL_BIT
    const ui = await uiState(page)
    expect(ui?.furnace?.at, `frame ${i}: panel still on the tile`).toEqual({ x: O.x, y: O.y })
  }
  expect(real, 'the ack replaced the prediction').toBe(true)
  await expect(page.locator('.furnace-panel')).toBeVisible()
  expect(await page.locator('.furnace-panel').getAttribute('data-furnace')).toBe(`${O.x},${O.y}`)
})

test('reference_furnace_pick_up', async ({ page }) => {
  await stocked(page, 2, 1)
  await openFurnace(page, O)
  const pick = page.locator('[data-furnace-pickup]')
  await expect(pick, 'empty furnace: enabled').toBeEnabled()

  // Anything inside disables it; after two smelts and a take-all it is empty again.
  await deposit(page, 'iron', 1)
  await deposit(page, 'iron', 1)
  await deposit(page, 'wood', 1)
  await pumpUntil(page, (u) => u?.furnace?.iron_in === 2)
  await expect(pick, 'ore and fuel inside').toBeDisabled()
  await page.evaluate((k) => window.__stepTick?.(k), 200)
  await pumpUntil(page, (u) => u?.furnace?.ingots_out === 2)
  await expect(pick, 'ingots inside').toBeDisabled()
  await takeAll(page)
  await pumpUntil(
    page,
    (u) => u?.furnace?.ingots_out === 0 && (u?.inventory[ITEM.ingot] ?? 0) === 2,
  )
  await expect(pick, 'nothing left: enabled').toBeEnabled()

  // Press: the record leaves the next published DrawList, the panel closes, the item is back.
  await pickUp(page)
  const ui = await pumpUntil(page, (u) => u?.furnace === null)
  expect(ui?.inventory[ITEM.furnace]).toBe(1)
  await frame(page)
  await expect(page.locator('.furnace-panel')).toBeHidden()
  expect((await draws(page)).filter((r) => r.kind === KIND.sprite)).toEqual([])
  expect((await draws(page)).filter(outline)).toEqual([])

  // The four tiles are buildable again: placing works.
  await placeFurnace(page, O)
  await frame(page)
  expect((await draws(page)).filter((r) => r.kind === KIND.sprite).length).toBe(1)
  expect(
    (await uiState(page))?.furnace,
    'the closed panel does not reopen on the new furnace',
  ).toBeNull()
})
