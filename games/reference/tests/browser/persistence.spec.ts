// The persistence tests of docs/plan/34b-reference-scripted-single-player.md (Scope, "Persistence
// through the game"): `reference_reload_resumes`, `reference_offscreen_furnace_keeps_smelting`,
// `reference_world_busy_second_tab`, `reference_export_import_roundtrip`. The page is `/test.html`
// with `?persist`: the same world in OPFS as the production page, driven by the manual clock (stepped
// ticks and frames, every wait on a `Ui` condition). Each test has its own browser context, so its own
// storage. The clean boundary before a reload is `client.exportWorld()` (it pauses the sim worker,
// snapshots if dirty and flushes), the one awaitable "it is on disk" the engine offers a page.
import { expect, type Page, test } from '@playwright/test'
import { draws, ITEM, KIND, openGame, pumpUntil, readUi, uiState } from '../helpers/game.js'
import { domDriver, FURNACE_A, LANDMARKS, runScript, script, type Tile } from '../helpers/script.js'

const PERSIST = '/test.html?persist'
const A = FURNACE_A
/** Five tiles west of a furnace: out of range of every resource and clear of its panel. */
const standBy = (o: Tile): Tile => ({ x: o.x - 5, y: o.y })

/** Stone to craft with (and two left over), a placed furnace, wood in the pocket, iron and coal
 * deposited: a furnace smelting, an inventory that is not empty, depleted tiles behind it. */
const PLAY = script()
  .collect('stone', 7)
  .craft(0)
  .panTo(standBy(A))
  .place(A)
  .collect('wood', 2)
  .collect('iron', 1)
  .collect('coal', 1)
  .panTo(standBy(A))
  .openFurnace(A)
  .deposit(A, 'iron', 1)
  .deposit(A, 'coal', 1)

async function start(page: Page, path = PERSIST): Promise<void> {
  await openGame(page, { path })
  await uiState(page) // primes the `lastUi` subscription
}

/** The sim instance's state hash; `stepTick(0)` parks the workers, which `worldHash` needs. */
const hash = async (page: Page) => {
  await page.evaluate(() => window.__stepTick?.(0))
  return page.evaluate(() => window.__worldHash?.())
}
const camera = (page: Page) => page.evaluate(() => window.__cameraState?.())
/** Ticks the sim has run; `stepTick(0)` parks the workers, which the read needs. */
const tick = async (page: Page) => {
  await page.evaluate(() => window.__stepTick?.(0))
  return page.evaluate(() => window.__simTick?.())
}

/** Waits until no `world:*` Web Lock is held, asked from a probe tab of the same origin (a static
 * file: no game, no console errors that `openGame` would fail on). */
async function waitForWorldLocksFree(page: Page): Promise<void> {
  const probe = await page.context().newPage()
  try {
    await probe.goto('/tiles.json')
    await probe.waitForFunction(async () => {
      const { held } = await navigator.locks.query()
      return !(held ?? []).some((l) => l.name?.startsWith('world:'))
    })
  } finally {
    await probe.close()
  }
}

/**
 * Leaves the page and opens `path` again once the world's Web Lock is free. A reload races the old
 * document's sim worker giving its lock up (`worker/sim.ts` retries for 200 ms, which a parked worker
 * can overrun), so the wait is on the condition itself: a same-origin static document to ask
 * `navigator.locks.query()`, then the page.
 */
async function reopen(page: Page, path = PERSIST): Promise<void> {
  await page.goto('about:blank')
  await waitForWorldLocksFree(page)
  await page.goto(path)
  await page.waitForFunction(() => window.__pageReady === true)
  await uiState(page)
}

test('reference_reload_resumes', async ({ page }) => {
  await start(page)
  await runScript(PLAY, await domDriver(page))
  const before = { ui: await readUi(page), camera: await camera(page), tick: await tick(page) }
  expect(before.ui.inventory[ITEM.stone]).toBe(2)
  expect(before.ui.inventory[ITEM.wood]).toBe(2)
  expect(before.ui.furnace?.smelt_done_at).not.toBeNull()

  await page.evaluate(() => window.__exportWorld?.()) // the clean boundary: on disk
  await reopen(page)
  expect(await page.evaluate(() => window.__startError?.())).toBeUndefined()

  // Inventory, camera and the tick it was left at (a fresh world would start at about zero).
  const ui = await readUi(page)
  expect(ui.inventory).toEqual(before.ui.inventory)
  expect(await camera(page)).toEqual(before.camera)
  expect(await tick(page)).toBeGreaterThanOrEqual(before.tick ?? 0)

  // The furnace kept its contents and its timer ...
  const driver = await domDriver(page)
  await driver.panTo(standBy(A)) // where the camera was left: settles frames and ticks for the DrawList
  await driver.openFurnace(A)
  const furnace = (await readUi(page)).furnace
  expect(furnace).toMatchObject(before.ui.furnace ?? {})
  // ... the stone tile its three remaining stones (seven of ten were taken before the reload) ...
  const stone = LANDMARKS.resources.stone
  const left = () =>
    page.evaluate(
      ([x, y]) =>
        window.__uiState?.()?.in_range.some((e) => e.tile.x === x && e.tile.y === y) ?? false,
      [stone.x, stone.y] as const,
    )
  await driver.collect('stone', stone, 3)
  await pumpUntil(
    page,
    (u) => u?.in_range.every((e) => e.tile.x !== stone.x || e.tile.y !== stone.y) ?? false,
  )
  expect(await left()).toBe(false)
  expect((await readUi(page)).inventory[ITEM.stone]).toBe(5)

  // ... and the smelt finishes: the ingot is ours.
  await driver.panTo(standBy(A))
  await driver.openFurnace(A)
  await pumpUntil(page, (u) => (u?.furnace?.ingots_out ?? 0) > 0, { maxSteps: 200 })
  await driver.takeAll(A)
  expect((await readUi(page)).inventory[ITEM.ingot]).toBe(1)
})

/** What the offscreen and export tests play: a furnace placed and set smelting (iron and coal in). */
const SMELTING = script()
  .collect('stone', 5)
  .craft(0)
  .panTo(standBy(A))
  .place(A)
  .collect('iron', 1)
  .collect('coal', 1)
  .panTo(standBy(A))
  .openFurnace(A)
  .deposit(A, 'iron', 1)
  .deposit(A, 'coal', 1)

const furnaceSprites = async (page: Page) =>
  (await draws(page)).filter((r) => r.kind === KIND.sprite)

test('reference_offscreen_furnace_keeps_smelting', async ({ page }) => {
  await start(page)
  const driver = await domDriver(page)
  await runScript(SMELTING, driver)
  expect((await readUi(page)).furnace?.smelt_done_at).not.toBeNull()
  expect(await furnaceSprites(page)).toHaveLength(1)

  // Far enough that the furnace's chunk leaves the view and is unsubscribed: no sprite of it is drawn
  // while a whole smelt (100 ticks) runs out.
  await driver.panTo({ x: 400, y: 400 })
  expect(await furnaceSprites(page)).toHaveLength(0)
  await driver.waitTicks(120)
  expect(await furnaceSprites(page)).toHaveLength(0)

  // Back: the chunk is sent again and the furnace has the ingot waiting.
  await driver.panTo(standBy(A))
  await pumpUntil(page, (u) => u?.furnace?.at.x === A.x && (u.furnace?.ingots_out ?? 0) > 0)
  expect(await furnaceSprites(page)).toHaveLength(1)
  await driver.takeAll(A)
  expect((await readUi(page)).inventory[ITEM.ingot]).toBe(1)
})

test('reference_world_busy_second_tab', async ({ page, context }) => {
  await start(page)
  await runScript(script().collect('stone', 1), await domDriver(page))

  const second = await context.newPage()
  await openGame(second, { path: PERSIST })
  expect(await second.evaluate(() => window.__startError?.())).toBe('world-busy')
  const screen = second.locator('.start-failure[data-code="world-busy"]')
  await expect(screen).toBeVisible()
  await expect(screen).toContainText('already open in another tab')
  // Export and Delete are for `SaveIncompatible` only (Q9 / R4 defaults).
  await expect(second.locator('[data-export-world], [data-delete-world]')).toHaveCount(0)

  // The first tab is untouched by the refusal.
  expect((await readUi(page)).inventory[ITEM.stone]).toBe(1)
  await page.evaluate(() => window.__stepTick?.(1))
  await second.close()
})

test('reference_export_import_roundtrip', async ({ page, context }) => {
  await start(page)
  await runScript(SMELTING, await domDriver(page))
  const bytes = await page.evaluate(() => window.__exportWorld?.())
  if (!bytes) throw new Error('no export')
  expect(bytes.length).toBeGreaterThan(0)

  // Under a new world id (the running world's own id is refused).
  const copy = 'reference-copy'
  await expect(
    page.evaluate((b) => window.__importWorld?.(b, 'reference'), bytes),
  ).rejects.toThrow()
  expect(await page.evaluate((b) => window.__importWorld?.(b, 'reference-copy'), bytes)).toBe(copy)

  // The copy, opened on its own: the same state. The copy starts a few ticks past the export (a page
  // pumps the sim to get its session live), so the original steps the same number before the hashes
  // are compared: nothing else may differ.
  const second = await context.newPage()
  await openGame(second, { path: `/test.html?persist=${copy}` })
  await uiState(second)
  expect(await second.evaluate(() => window.__startError?.())).toBeUndefined()
  const copyTick = (await tick(second)) ?? 0
  const copyHash = await hash(second)
  const ahead = copyTick - ((await tick(page)) ?? 0)
  expect(ahead).toBeGreaterThanOrEqual(0)
  await page.evaluate((n) => window.__stepTick?.(n), ahead)
  expect(await tick(page)).toBe(copyTick)
  expect(await hash(page)).toBe(copyHash)

  // And it is playable: the smelt finishes there too.
  const driver = await domDriver(second)
  await driver.panTo(standBy(A))
  await driver.openFurnace(A)
  await pumpUntil(second, (u) => (u?.furnace?.ingots_out ?? 0) > 0, { maxSteps: 200 })
  await driver.takeAll(A)
  expect((await readUi(second)).inventory[ITEM.ingot]).toBe(1)
})
