// `script.ts` (docs/plan/34b-reference-scripted-single-player.md): one fluent description of a play
// of the reference game, run by one of two drivers: `headlessDriver` (a `HeadlessClient` on the
// netcode harness, what `golden:record` and M34c use) and `domDriver` (a Playwright page on
// `/test.html`: real clicks, real mouse taps). Both run the same `Script`, so the DOM run proves the
// UI path adds nothing the actions do not say (same final state hash, `reference_full_game_single`).
//
// Runtime-light on purpose: `golden:record` (plain Node, type stripping) imports this file, so it has
// no runtime imports other than `landmarks.json`; `domDriver` loads `game.ts` (Playwright) lazily.

import type { Page } from '@playwright/test'
import type { HeadlessClient } from 'engine/test'
import landmarks from '../fixtures/landmarks.json' with { type: 'json' }
import type { RefUiState } from './game.js'

export type Tile = { x: number; y: number }
export type Resource = 'stone' | 'iron' | 'wood' | 'coal'
export type DepositItem = 'iron' | 'coal' | 'wood'

/** `Ui.inventory` slot of each item (`content::ItemId`); `tests/helpers/game.ts::ITEM` has the same. */
const SLOT = { stone: 0, iron: 1, wood: 2, coal: 3, furnace: 4, ingot: 5 } as const
const WIRE_ITEM = { iron: 1, wood: 2, coal: 3 } as const

/** Where each resource is (`tests/fixtures/landmarks.json`, checked against worldgen by
 * `landmarks_fixture_current`). */
export const LANDMARKS = landmarks as {
  seed: string
  land: Tile
  resources: Record<Resource, Tile>
}

/** Two free 2x2 origins of land, two tiles apart (a rejected `PlaceFurnace` fails the script). Both
 * footprints sit inside chunk (-1, 0)'s rows 1 to 4: a furnace straddling a chunk boundary (origin
 * y = -1, say) leaves the client's replica hash different from the host's region hash (found by
 * this script's `assertConverged`, reported in M34b Deviations). */
export const FURNACE_A: Tile = { x: -4, y: 1 }
export const FURNACE_B: Tile = { x: -4, y: 3 }

export type Step =
  | { op: 'panTo'; tile: Tile }
  | { op: 'collect'; resource: Resource; n: number }
  | { op: 'craft'; recipe: number }
  | { op: 'place'; origin: Tile }
  | { op: 'openFurnace'; at: Tile }
  | { op: 'pickUp'; at: Tile; refused: boolean }
  | { op: 'deposit'; at: Tile; item: DepositItem; n: 1 | 5 | 'all' }
  | { op: 'takeAll'; at: Tile }
  | { op: 'waitTicks'; n: number }
  | { op: 'expectUi'; partial: unknown }

export class Script {
  readonly steps: Step[] = []
  private add(step: Step): this {
    this.steps.push(step)
    return this
  }
  /** Stands the player (camera) on `tile`. */
  panTo(tile: Tile): this {
    return this.add({ op: 'panTo', tile })
  }
  /** Pans to the resource's landmark and collects it `n` times, waiting for each to land. */
  collect(resource: Resource, n: number): this {
    return this.add({ op: 'collect', resource, n })
  }
  /** Starts recipe `recipe` and waits for the output. */
  craft(recipe: number): this {
    return this.add({ op: 'craft', recipe })
  }
  /** Places a furnace with its origin at `origin`; waits for the host's ack. */
  place(origin: Tile): this {
    return this.add({ op: 'place', origin })
  }
  /** Opens the furnace panel on the furnace at `at` (the DOM driver taps it). */
  openFurnace(at: Tile): this {
    return this.add({ op: 'openFurnace', at })
  }
  /** Picks the furnace up; `{ refused: true }` expects the furnace to refuse (something is inside). */
  pickUp(at: Tile, opts: { refused?: boolean } = {}): this {
    return this.add({ op: 'pickUp', at, refused: opts.refused ?? false })
  }
  deposit(at: Tile, item: DepositItem, n: 1 | 5 | 'all'): this {
    return this.add({ op: 'deposit', at, item, n })
  }
  takeAll(at: Tile): this {
    return this.add({ op: 'takeAll', at })
  }
  /** `n` sim ticks, nothing else. */
  waitTicks(n: number): this {
    return this.add({ op: 'waitTicks', n })
  }
  /** `Ui` must contain `partial`: every key named is equal, arrays element by element. */
  expectUi(partial: unknown): this {
    return this.add({ op: 'expectUi', partial })
  }
}

export const script = (): Script => new Script()

/** What a driver does. A driver throws on anything unexpected (a rejected action, a wait that never
 * ends); it never sleeps: a headless driver advances ticks, a DOM driver steps the manual clock. */
export interface ScriptDriver {
  panTo(tile: Tile): Promise<void>
  collect(resource: Resource, tile: Tile, n: number): Promise<void>
  craft(recipe: number): Promise<void>
  place(origin: Tile): Promise<void>
  openFurnace(at: Tile): Promise<void>
  pickUp(at: Tile, refused: boolean): Promise<void>
  deposit(at: Tile, item: DepositItem, n: 1 | 5 | 'all'): Promise<void>
  takeAll(at: Tile): Promise<void>
  waitTicks(n: number): Promise<void>
  ui(): Promise<RefUiState>
}

/** `partial` is contained in `actual`; returns the path of the first difference, or `null`. */
export function subsetDiff(actual: unknown, partial: unknown, path = 'ui'): string | null {
  if (partial === null || typeof partial !== 'object') {
    return actual === partial
      ? null
      : `${path}: expected ${JSON.stringify(partial)}, got ${JSON.stringify(actual)}`
  }
  if (actual === null || typeof actual !== 'object') {
    return `${path}: expected an object, got ${JSON.stringify(actual)}`
  }
  if (Array.isArray(partial)) {
    if (!Array.isArray(actual) || actual.length !== partial.length) {
      return `${path}: expected ${partial.length} elements, got ${JSON.stringify(actual)}`
    }
    for (let i = 0; i < partial.length; i++) {
      const d = subsetDiff(actual[i], partial[i], `${path}[${i}]`)
      if (d !== null) return d
    }
    return null
  }
  for (const [k, v] of Object.entries(partial)) {
    const d = subsetDiff((actual as Record<string, unknown>)[k], v, `${path}.${k}`)
    if (d !== null) return d
  }
  return null
}

/** Runs `s` on `driver`, step by step. An `expectUi` mismatch throws with the step's index. */
export async function runScript(
  s: Script,
  driver: ScriptDriver,
  hooks: { onStep?: (index: number, step: Step) => void } = {},
): Promise<void> {
  for (const [i, step] of s.steps.entries()) {
    hooks.onStep?.(i, step)
    try {
      switch (step.op) {
        case 'panTo':
          await driver.panTo(step.tile)
          break
        case 'collect':
          await driver.collect(step.resource, LANDMARKS.resources[step.resource], step.n)
          break
        case 'craft':
          await driver.craft(step.recipe)
          break
        case 'place':
          await driver.place(step.origin)
          break
        case 'openFurnace':
          await driver.openFurnace(step.at)
          break
        case 'pickUp':
          await driver.pickUp(step.at, step.refused)
          break
        case 'deposit':
          await driver.deposit(step.at, step.item, step.n)
          break
        case 'takeAll':
          await driver.takeAll(step.at)
          break
        case 'waitTicks':
          await driver.waitTicks(step.n)
          break
        case 'expectUi': {
          const diff = subsetDiff(await driver.ui(), step.partial)
          if (diff !== null) throw new Error(diff)
          break
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`script step ${i} (${JSON.stringify(step)}): ${msg}`)
    }
  }
}

/** The whole reference game, once: spawn, mine to the unlock, craft, place, pick the empty furnace
 * up and place it two tiles over, fetch iron and coal, deposit, smelt, take; a last pick-up is
 * refused because fuel is left (`0003` Consequences' coverage list, M34b Scope). Ends quiescent: no
 * timer, no craft, no collect, so the state hash does not depend on how many ticks the run took. */
export function fullGame(): Script {
  const [A, B] = [FURNACE_A, FURNACE_B]
  // Stand five tiles west of a furnace: out of range of every resource, so no collect button sits
  // over the panel or the tile the mouse taps.
  const standBy = (o: Tile): Tile => ({ x: o.x - 5, y: o.y })
  const inv = (
    stone: number,
    iron: number,
    wood: number,
    coal: number,
    furnace: number,
    ingot: number,
  ) => [stone, iron, wood, coal, furnace, ingot]
  return script()
    .expectUi({
      spawn: LANDMARKS.land,
      inventory: inv(0, 0, 0, 0, 0, 0),
      unlocks: 0,
      collecting: null,
      crafting: null,
      roster: [{ id: 1, online: true, me: true }],
    })
    .collect('stone', 5)
    .expectUi({ inventory: inv(5, 0, 0, 0, 0, 0), unlocks: 1, collecting: null })
    .craft(0)
    .expectUi({ inventory: inv(0, 0, 0, 0, 1, 0), crafting: null, can_build: true })
    .panTo(standBy(A))
    .place(A)
    .expectUi({ inventory: inv(0, 0, 0, 0, 0, 0) })
    .openFurnace(A)
    .pickUp(A)
    .expectUi({ inventory: inv(0, 0, 0, 0, 1, 0), furnace: null })
    .panTo(standBy(B))
    .place(B)
    .expectUi({ inventory: inv(0, 0, 0, 0, 0, 0) })
    .collect('iron', 1)
    .collect('coal', 1)
    .expectUi({ inventory: inv(0, 1, 0, 1, 0, 0) })
    .panTo(standBy(B))
    .openFurnace(B)
    .deposit(B, 'iron', 1)
    .deposit(B, 'coal', 1)
    .expectUi({ inventory: inv(0, 0, 0, 0, 0, 0) })
    .waitTicks(110)
    .takeAll(B)
    .expectUi({ inventory: inv(0, 0, 0, 0, 0, 1) })
    .pickUp(B, { refused: true })
    .expectUi({ inventory: inv(0, 0, 0, 0, 0, 1) })
}

// ---------------------------------------------------------------------------------------------
// Headless driver

/** Most ticks any wait below may take (a craft is 100, a collect 40): a wait past it is a bug. */
const MAX_WAIT_TICKS = 300
/** Camera settle: the critically damped spring (`SPRING_OMEGA = 6 rad/s`) in ticks (20 Hz). */
const SETTLE_TICKS = 25

/**
 * `headlessDriver(client, advance)`: `client` is an M27 `HeadlessClient` joined to a world, `advance`
 * runs `n` host ticks (and the client's frames): `createNetHarness(...).advanceTicks`. `client.ui()`
 * is read after every advance; an action's verdict arrives through `onActionResult`.
 */
export function headlessDriver(
  client: HeadlessClient,
  advance: (ticks: number) => Promise<void>,
): ScriptDriver & {
  /** Every verdict seen so far, by seq. */
  results: Map<number, unknown>
} {
  const results = new Map<number, unknown>()
  client.onActionResult((seq, result) => {
    // `NotPredictable` is the client declining to predict, at dispatch; the host's verdict follows.
    if (result !== 'NotPredictable') results.set(seq, result)
  })
  const ui = (): RefUiState => {
    const u = client.ui() as RefUiState | null
    if (u === null) throw new Error('headlessDriver: no Ui yet')
    return u
  }
  const until = async (what: string, done: () => boolean): Promise<void> => {
    for (let i = 0; i < MAX_WAIT_TICKS; i++) {
      if (done()) return
      await advance(1)
    }
    if (!done())
      throw new Error(`headlessDriver: ${what} did not happen in ${MAX_WAIT_TICKS} ticks`)
  }
  /** Dispatches and waits for the host's verdict. */
  const act = async (action: unknown): Promise<unknown> => {
    const seq = client.dispatch(action)
    await until(`verdict for seq ${seq}`, () => results.has(seq))
    return results.get(seq)
  }
  const accepted = async (what: string, action: unknown): Promise<void> => {
    const r = await act(action)
    if (r !== 'Confirmed') throw new Error(`headlessDriver: ${what} was ${JSON.stringify(r)}`)
  }

  return {
    results,
    async panTo(tile) {
      client.setCamera({ x: tile.x, y: tile.y, tilesAcross: 20 })
      await advance(SETTLE_TICKS)
    },
    async collect(resource, tile, n) {
      // Stand on the tile, as the DOM driver's `panTo` does.
      client.setCamera({ x: tile.x, y: tile.y, tilesAcross: 20 })
      await advance(SETTLE_TICKS)
      const slot = SLOT[resource]
      for (let i = 0; i < n; i++) {
        let entry = ui().in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)
        await until(`${resource} tile ${tile.x},${tile.y} in range`, () => {
          entry = ui().in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)
          return entry !== undefined
        })
        if (!entry) throw new Error('unreachable')
        const before = ui().inventory[slot] ?? 0
        await accepted(`StartCollect ${resource}`, {
          StartCollect: {
            tile: { x: tile.x, y: tile.y },
            from: { x: entry.from.x, y: entry.from.y },
          },
        })
        await until(`${resource} collected`, () => {
          const u = ui()
          return u.collecting === null && (u.inventory[slot] ?? 0) > before
        })
      }
    },
    async craft(recipe) {
      const before = ui().inventory[SLOT.furnace] ?? 0
      await accepted('StartCraft', { StartCraft: { recipe } })
      await until('craft done', () => {
        const u = ui()
        return u.crafting === null && (u.inventory[SLOT.furnace] ?? 0) > before
      })
    },
    async place(origin) {
      const before = ui().inventory[SLOT.furnace] ?? 0
      await accepted('PlaceFurnace', { PlaceFurnace: { origin: { x: origin.x, y: origin.y } } })
      await until('furnace spent', () => (ui().inventory[SLOT.furnace] ?? before) < before)
    },
    async openFurnace() {
      // Client-local state (`RefClient.open`): nothing the host hears, nothing in the hash.
    },
    async pickUp(at, refused) {
      const before = ui().inventory[SLOT.furnace] ?? 0
      const r = await act({ FurnacePickUp: { at: { x: at.x, y: at.y } } })
      if (refused) {
        if (r === 'Confirmed') throw new Error('headlessDriver: FurnacePickUp was not refused')
        return
      }
      if (r !== 'Confirmed')
        throw new Error(`headlessDriver: FurnacePickUp was ${JSON.stringify(r)}`)
      await until('furnace back', () => (ui().inventory[SLOT.furnace] ?? 0) > before)
    },
    async deposit(at, item, n) {
      const slot = SLOT[item]
      const before = ui().inventory[slot] ?? 0
      const count = n === 'all' ? before : n
      await accepted(`FurnaceDeposit ${item}`, {
        FurnaceDeposit: { at: { x: at.x, y: at.y }, item: WIRE_ITEM[item], count },
      })
      await until('deposit landed', () => (ui().inventory[slot] ?? 0) === before - count)
    },
    async takeAll(at) {
      const before = ui().inventory[SLOT.ingot] ?? 0
      await accepted('FurnaceTake', { FurnaceTake: { at: { x: at.x, y: at.y } } })
      await until('ingots taken', () => (ui().inventory[SLOT.ingot] ?? 0) > before)
    },
    waitTicks: (n) => advance(n),
    async ui() {
      return ui()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// DOM driver

/**
 * `domDriver(page)`: `page` is `/test.html` opened by `openGame` with its `Ui` primed. Real pointer
 * input and button clicks; stepped ticks and frames only (the manual clock), every wait on a real
 * `Ui` condition through `pumpUntil`.
 */
export async function domDriver(page: Page): Promise<ScriptDriver> {
  const g = await import('./game.js')
  const { expect } = await import('@playwright/test')
  const stepTicks = (n: number) => page.evaluate((k) => window.__stepTick?.(k), n)
  const slotOf = (item: DepositItem): number => SLOT[item]
  return {
    panTo: (tile) => g.panTo(page, tile),
    async collect(resource, tile, n) {
      await g.panTo(page, tile)
      await g.pumpUntil(
        page,
        (u) => u?.in_range.some((e) => e.tile.x === tile.x && e.tile.y === tile.y) === true,
      )
      const slot = SLOT[resource]
      for (let i = 0; i < n; i++) {
        const before = (await g.uiState(page))?.inventory[slot] ?? 0
        await g.clickCollect(page, tile)
        await stepTicks(g.COLLECT_TICKS)
        await g.pumpUntil(page, (u) => u?.collecting === null && (u?.inventory[slot] ?? 0) > before)
      }
    },
    async craft(recipe) {
      const before = (await g.uiState(page))?.inventory[SLOT.furnace] ?? 0
      await page.locator(`[data-craft-recipe="${recipe}"]`).click()
      await page.evaluate((d) => window.__stepFrame?.(d), 16)
      await g.pumpUntil(page, (u) => u?.crafting !== null && u?.crafting !== undefined)
      await stepTicks(101)
      await g.pumpUntil(
        page,
        (u) => u?.crafting === null && (u?.inventory[SLOT.furnace] ?? 0) > before,
      )
    },
    async place(origin) {
      const before = (await g.uiState(page))?.inventory[SLOT.furnace] ?? 0
      await page.locator('.build-button').click()
      await page.evaluate((d) => window.__stepFrame?.(d), 16)
      await g.pumpUntil(page, (u) => u?.placing === true)
      const p = await g.tileToScreen(page, origin.x + 0.5, origin.y + 0.5)
      await page.mouse.move(p.x, p.y)
      await g.frame(page)
      await page.mouse.click(p.x, p.y)
      await g.frame(page, 60) // the uplink is paced at 50 ms
      await stepTicks(3)
      await g.pumpUntil(page, (u) => (u?.inventory[SLOT.furnace] ?? before) < before)
      await g.frame(page)
    },
    async openFurnace(at) {
      await g.openFurnace(page, at)
    },
    async pickUp(at, refused) {
      if (refused) {
        // The panel disables Pick up while anything is inside, so the UI never sends it: the action
        // goes through `client.dispatch` (as the headless driver's does) and the sim refuses it.
        await expect(page.locator('[data-furnace-pickup]')).toBeDisabled()
        const before = (await g.uiState(page))?.inventory[SLOT.furnace] ?? 0
        await page.evaluate(([x, y]) => window.__dispatchFurnacePickUp?.(x, y), [
          at.x,
          at.y,
        ] as const)
        await page.evaluate((d) => window.__stepFrame?.(d), 60) // the uplink is paced at 50 ms
        await stepTicks(3)
        await g.frame(page)
        expect((await g.uiState(page))?.inventory[SLOT.furnace]).toBe(before)
        return
      }
      const before = (await g.uiState(page))?.inventory[SLOT.furnace] ?? 0
      await g.pickUp(page)
      await g.pumpUntil(page, (u) => (u?.inventory[SLOT.furnace] ?? 0) > before)
    },
    async deposit(_at, item, n) {
      const slot = slotOf(item)
      const before = (await g.uiState(page))?.inventory[slot] ?? 0
      await g.deposit(page, item, n)
      await g.pumpUntil(page, (u) => (u?.inventory[slot] ?? 0) < before)
    },
    async takeAll() {
      const before = (await g.uiState(page))?.inventory[SLOT.ingot] ?? 0
      await g.takeAll(page)
      await g.pumpUntil(page, (u) => (u?.inventory[SLOT.ingot] ?? 0) > before)
    },
    async waitTicks(n) {
      await stepTicks(n)
      await g.frame(page)
    },
    ui: () => g.readUi(page),
  }
}
