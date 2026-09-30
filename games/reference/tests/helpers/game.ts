// `tests/helpers/game.ts::openGame(page, opts)` (docs/plan/20-reference-game-v0.md Provides):
// the reference game's own page contract, mirroring `packages/engine/tests/browser/support/
// page.ts::openPage` (navigate, assert cross-origin isolation, fail the test on any page error or
// console error) -- duplicated in full rather than imported across the package boundary (this
// package depends only on `engine`, `reference_package_depends_only_on_engine`), waiting on the
// same `window.__pageReady` convention `src/main.ts` sets.
import { expect, type Page } from '@playwright/test'

declare global {
  interface Window {
    __pageReady?: true
  }
}

export type OpenGameOptions = {
  /** Default `/index.html`. */
  path?: string
}

/** `Ui`'s own shape, as `window.__uiState` (`test-entry.ts`) hands it back -- kept as a loose
 * structural type here (Seams, Provides) rather than importing `../../src/bindings/RefUi.js`: a
 * test helper file, unlike a page script, has no build step of its own to keep bindings in sync
 * with, and every field this helper's own callers need is listed below. */
export type RefUiState = {
  me: number
  /** Counts by item slot: stone, iron, wood, coal, furnace, ingot (`content::ItemId`). */
  inventory: number[]
  collecting: { tile: { x: number; y: number }; done_at: number } | null
  in_range: Array<{
    tile: { x: number; y: number }
    resource: number
    from: { x: number; y: number }
  }>
  spawn: { x: number; y: number }
  unlocks: number
  crafting: { recipe: number; done_at: number } | null
  recipes: Array<{ recipe: number; cost: number[]; secs: number; affordable: boolean }>
  /** Construction mode is on (client-local). */
  placing: boolean
  /** The inventory holds a furnace item. */
  can_build: boolean
  /** The open furnace's state (`Ui.furnace`), `null` when no panel is open. */
  furnace: {
    at: { x: number; y: number }
    iron_in: number
    coal: number
    wood: number
    burn_left: number
    ingots_out: number
    smelt_done_at: number | null
  } | null
}

/** A furnace sprite (`kind` 0) or the placement ghost (`kind` 6) from the newest DrawList. */
export type DrawRec = {
  kind: number
  x: number
  y: number
  w: number
  h: number
  flags: number
  color: number
  param: number
  pickId: number
}

declare global {
  interface Window {
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    __stepFrame?: (dtMs: number) => Promise<void>
    __stepTick?: (n: number) => Promise<void>
    __uiState?: () => RefUiState | null
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
    __tickCamera?: (dtMs: number) => void
    __draws?: () => DrawRec[]
    __cursorTile?: () => { x: number; y: number; valid: boolean }
    __injectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      x: number,
      y: number,
      tMs: number,
      kind?: 'mouse' | 'touch',
    ) => void
    __dispatchPlaceFurnace?: (x: number, y: number) => number
  }
}

/**
 * `panTo(page, tile)` (Seams, Provides): settles the camera (and the spring it drives, M20b step 1)
 * on `tile`'s own centre, then steps enough sim ticks for the host to have actually downlinked that
 * tile into the client's own replica -- `Ui.in_range`/`world.tile()` need a real tick, not just
 * `stepFrame` (`games/reference/CLAUDE.md`, found live by `ui-smoke.spec.ts`). Stepped frames only
 * (`engine/test`'s own manual-clock contract): the caller's page must be `/test.html`.
 *
 * First waits for the page's first `Ui` (gate round 3): `game.ts` moves the camera to `Ui.spawn`
 * once, on that first `Ui`, so a `Ui` landing after this function's `__setCamera` snapped the camera
 * back to spawn and the panned-to tiles never came into range (found by `reference_several_buttons`
 * under the full suite: one collect button, for the spawn tile). `test-entry.ts` primes `lastUi`
 * before any frame, so a non-null `uiState` means that first `Ui` has been handled.
 */
export async function panTo(
  page: Page,
  tile: { x: number; y: number },
  opts: { tilesAcross?: number } = {},
): Promise<void> {
  const tilesAcross = opts.tilesAcross ?? 20
  await pumpUntil(page, (ui) => ui !== null)
  await page.evaluate(([x, y, t]) => window.__setCamera?.(x, y, t), [
    tile.x,
    tile.y,
    tilesAcross,
  ] as const)
  // ~1s of stepped frames: enough for the critically damped spring (`SPRING_OMEGA = 6 rad/s`) to
  // settle near the new target (`player.spec.ts`'s own precedent, 128 x 16ms).
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.__stepFrame?.(50))
  }
  await page.evaluate((n) => window.__stepTick?.(n), 5)
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.__stepFrame?.(50))
  }
}

/** `uiState(page)` (Seams, Provides): the current `Ui` this page's own client has last observed
 * (`window.__uiState`, `test-entry.ts`), or `null` before the first one arrives. */
export function uiState(page: Page): Promise<RefUiState | null> {
  return page.evaluate(() => window.__uiState?.() ?? null)
}

/**
 * `readUi(page)` (33e): the current `Ui`, waiting for the first one. `onUi` rides the real rAF, so
 * `uiState` is `null` until it lands (`test-entry.ts`'s `?lateUi=n` makes that deterministic). Any
 * helper or spec that reads a field of `Ui` before it has stepped anything reads through this.
 */
export async function readUi(page: Page): Promise<RefUiState> {
  const ui = await pumpUntil(page, (u) => u !== null)
  if (ui === null) throw new Error('readUi: no Ui')
  return ui
}

/**
 * Steps one sim tick plus one 16ms frame at a time (Seams, Provides), checking `predicate` against
 * `uiState(page)` after each round, until it holds or `maxSteps` is exhausted (throws by name in
 * that case). A fixed tick/frame count is brittle against exactly how many ticks a given
 * dispatch-to-effect round trip needs (`ui-smoke.spec.ts`'s own hand-picked counts turned out to be
 * this milestone's own source of flakiness under load, found live in this cut) -- polling the real
 * condition instead of guessing a number is the fix.
 */
export async function pumpUntil(
  page: Page,
  predicate: (ui: RefUiState | null) => boolean,
  opts: { maxSteps?: number } = {},
): Promise<RefUiState | null> {
  const maxSteps = opts.maxSteps ?? 80
  for (let i = 0; i < maxSteps; i++) {
    const ui = await uiState(page)
    if (predicate(ui)) return ui
    await page.evaluate((n) => window.__stepTick?.(n), 1)
    await page.evaluate((dtMs) => window.__stepFrame?.(dtMs), 16)
  }
  throw new Error(`pumpUntil: condition not met after ${maxSteps} tick+frame rounds`)
}

/**
 * A collect button is created when the `Ui` reaches the main thread, but the anchor layer only
 * positions it on the next *stepped* frame; until then every new button sits at the same default
 * spot and one intercepts the others' clicks, and a `Ui` that lands after the last stepped frame
 * leaves nothing on the page at all (gate rounds 1-2). Steps one frame per poll until a button
 * exists for every tile in `tiles` (at least one when `tiles` is empty) and no two collect buttons
 * overlap. Bounded by the poll timeout; not a retry of a flaky step.
 * A timeout reports the page's button tiles, rects, `--z` and layer transform (gate round 3).
 */
export async function settleCollectButtons(
  page: Page,
  tiles: { x: number; y: number }[] = [],
): Promise<void> {
  const wanted = tiles.map((t) => `${t.x},${t.y}`)
  await expect
    .poll(
      () =>
        page.evaluate(async (want) => {
          await window.__stepFrame?.(50)
          const buttons = [...document.querySelectorAll('.collect-button')]
          const rects = buttons.map((b) => b.getBoundingClientRect())
          const overlaps = rects.some((a, i) =>
            rects.some(
              (b, j) =>
                i < j &&
                a.left < b.right &&
                b.left < a.right &&
                a.top < b.bottom &&
                b.top < a.bottom,
            ),
          )
          const have = new Set(buttons.map((b) => b.getAttribute('data-collect-tile')))
          const ok = buttons.length > 0 && want.every((w) => have.has(w)) && !overlaps
          if (ok) return 'ok'
          // Otherwise the state itself, so a timeout's message says which clause failed.
          const layer = buttons[0]?.parentElement
          return JSON.stringify({
            tiles: [...have],
            rects: rects.map((r) => [r.left, r.top, r.width, r.height].map(Math.round).join(' ')),
            z: layer?.style.getPropertyValue('--z'),
            layer: layer?.style.transform,
          })
        }, wanted),
      { timeout: 5_000 },
    )
    .toBe('ok')
}

/**
 * `clickCollect(page, tile)` (Seams, Provides): clicks the one collect button anchored over `tile`
 * (`src/ui/collect.ts`'s own `data-collect-tile="x,y"` identity, Deviations) and flushes the
 * client's own action-ring uplink with one stepped frame (`depletion.spec.ts`/`ui-smoke.spec.ts`'s
 * own precedent: a dispatched action sits unflushed until `stepFrame` runs `client_poll_uplink`).
 */
export async function clickCollect(page: Page, tile: { x: number; y: number }): Promise<void> {
  await settleCollectButtons(page, [tile])
  await page.locator(`[data-collect-tile="${tile.x},${tile.y}"]`).click()
  await page.evaluate((dtMs) => window.__stepFrame?.(dtMs), 16)
}

export async function openGame(page: Page, opts: OpenGameOptions = {}): Promise<void> {
  const path = opts.path ?? '/index.html'
  page.on('pageerror', (error) => {
    expect(error.message, `${path}: page error`).toBe('')
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      expect(msg.text(), `${path}: console.error`).toBe('')
    }
  })

  await page.goto(path)
  await page.waitForFunction(() => window.__pageReady === true)
  const isolated = await page.evaluate(() => window.crossOriginIsolated)
  expect(isolated, `${path}: crossOriginIsolated`).toBe(true)
}

/** `Ui.inventory` slot of each item (`content::ItemId`). */
export const ITEM = { stone: 0, iron: 1, wood: 2, coal: 3, furnace: 4, ingot: 5 } as const

/** A known tile per collectable resource under `TEST_SEED` (`sim/tests/landmarks_fixture.rs`'s
 * fixture and the depletion/collect specs). Coal has no scouted tile yet. */
export const RESOURCE_TILE = {
  stone: { x: -1, y: 2 },
  iron: { x: 0, y: 0 },
  wood: { x: -4, y: -2 },
} as const

/** `content::COLLECT` (40 ticks at 20 Hz) plus the host's tick T+1 queuing (0004). */
export const COLLECT_TICKS = 41

/**
 * `collectN(page, resource, n)` (docs/plan/32-reference-crafting.md Provides): pans to the
 * resource's known tile, then `n` times clicks collect and steps ticks (never real time) until the
 * collect lands. Returns the last `Ui`. The page must be `/test.html` with the `Ui` primed
 * (`uiState` called once), as `panTo` needs.
 */
export async function collectN(
  page: Page,
  resource: keyof typeof RESOURCE_TILE,
  n: number,
): Promise<RefUiState | null> {
  const tile = RESOURCE_TILE[resource]
  await panTo(page, tile)
  await pumpUntil(
    page,
    (ui) => ui?.in_range.some((e) => e.tile.x === tile.x && e.tile.y === tile.y) === true,
  )
  let ui: RefUiState | null = null
  for (let i = 0; i < n; i++) {
    const before = (await uiState(page))?.inventory[ITEM[resource]] ?? 0
    await clickCollect(page, tile)
    await page.evaluate((k) => window.__stepTick?.(k), COLLECT_TICKS)
    ui = await pumpUntil(
      page,
      (u) => u?.collecting === null && (u?.inventory[ITEM[resource]] ?? 0) > before,
    )
  }
  return ui
}

/** Tiles under `TEST_SEED` that the placement specs rely on (`sim/tests/place.rs`,
 * `browser_fixture_tiles_hold`, checks them against worldgen): a free 2x2 of land, the last origin
 * whose footprint is all land on the shore row, the next origin over (one footprint tile is water),
 * and an origin covering the iron resource at (0, 0). */
export const PLACE = {
  free: { x: -4, y: -1 },
  shoreOk: { x: 1, y: -1 },
  shoreWater: { x: 2, y: -1 },
  overIron: { x: 0, y: -1 },
} as const

/** `ghost`/`sprite` colours and flags (`sim/src/client.rs`, `engine::client::drawlist`). */
export const GHOST = { valid: 0x9040ff40, invalid: 0x904040ff, unknown: 0x90c0c0c0 } as const
export const FLAG = { anchorCursorTile: 1 << 0, predicted: 1 << 2 } as const
export const KIND = { sprite: 0, rect: 3, bar: 4, ghost: 6 } as const

export async function draws(page: Page): Promise<DrawRec[]> {
  return page.evaluate(() => window.__draws?.() ?? [])
}

/** The one `kind` record, or `undefined` (throws when there are several: the specs never expect two). */
export async function only(page: Page, kind: number): Promise<DrawRec | undefined> {
  const found = (await draws(page)).filter((r) => r.kind === kind)
  if (found.length > 1)
    throw new Error(`expected at most one kind ${kind} record, saw ${found.length}`)
  return found[0]
}

/** CSS-pixel position of a world point (tiles) on the `#game` canvas, from the live camera
 * (`camera/transform.ts`: `pxPerTile = max(w, h) / tilesAcross`, the centre at the canvas centre). */
export async function tileToScreen(
  page: Page,
  wx: number,
  wy: number,
): Promise<{ x: number; y: number }> {
  const cam = await page.evaluate(() => window.__cameraState?.())
  const box = await page.locator('#game').boundingBox()
  if (!cam || !box) throw new Error('no camera state or canvas box')
  const ppt = Math.max(box.width, box.height) / cam.tilesAcross
  return {
    x: box.x + box.width / 2 + (wx - cam.x) * ppt,
    y: box.y + box.height / 2 + (wy - cam.y) * ppt,
  }
}

/** One camera integration (recognizes pointer gestures) then one stepped frame. */
export async function frame(page: Page, dtMs = 16): Promise<void> {
  await page.evaluate((d) => window.__tickCamera?.(d), dtMs)
  await page.evaluate((d) => window.__stepFrame?.(d), dtMs)
}

/** `craftFurnace(page)` (docs/plan/33-reference-furnace.md Provides): five stone and one craft,
 * stepped ticks only; returns the `Ui` holding one furnace. Needs `/test.html` with the `Ui` primed. */
export async function craftFurnace(page: Page): Promise<RefUiState | null> {
  await collectN(page, 'stone', 5)
  await page.locator('[data-craft-recipe="0"]').click()
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await pumpUntil(page, (ui) => ui?.crafting !== null && ui?.crafting !== undefined)
  await page.evaluate((k) => window.__stepTick?.(k), 101)
  return pumpUntil(page, (ui) => ui?.crafting === null && (ui?.inventory[ITEM.furnace] ?? 0) >= 1)
}

/** `placeFurnace(page, origin)` (Provides): dispatches `PlaceFurnace` at `origin` and steps ticks
 * until the item is spent on the host (the ack has landed). Returns the last `Ui`. */
export async function placeFurnace(
  page: Page,
  origin: { x: number; y: number },
): Promise<RefUiState | null> {
  const before = (await uiState(page))?.inventory[ITEM.furnace] ?? 0
  await page.evaluate(([x, y]) => window.__dispatchPlaceFurnace?.(x, y), [
    origin.x,
    origin.y,
  ] as const)
  await page.evaluate((d) => window.__stepFrame?.(d), 16)
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  return pumpUntil(page, (ui) => (ui?.inventory[ITEM.furnace] ?? before) < before)
}

/** `openFurnace(page, tile)` (docs/plan/33b-reference-furnace-operation.md Provides): a real mouse tap
 * on the furnace anchored at `tile`, then steps until `Ui.furnace` names it. Returns that `Ui`. */
export async function openFurnace(
  page: Page,
  tile: { x: number; y: number },
): Promise<RefUiState | null> {
  const p = await tileToScreen(page, tile.x + 1, tile.y + 1)
  await page.mouse.move(p.x, p.y)
  await frame(page)
  await page.mouse.click(p.x, p.y)
  await frame(page)
  return pumpUntil(page, (ui) => ui?.furnace?.at.x === tile.x && ui?.furnace?.at.y === tile.y)
}

/** Presses one panel button, then flushes the uplink (paced at 50 ms) and steps three ticks. */
async function press(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click()
  await frame(page, 60)
  await page.evaluate((k) => window.__stepTick?.(k), 3)
  await frame(page)
}

/** `deposit(page, item, n)` (Provides): presses the panel's `+n` / `all` button for `item`. */
export async function deposit(
  page: Page,
  item: 'iron' | 'coal' | 'wood',
  n: 1 | 5 | 'all',
): Promise<void> {
  await press(page, `[data-deposit="${item}"][data-amount="${n}"]`)
}

/** `takeAll(page)` (Provides): presses Take all. */
export async function takeAll(page: Page): Promise<void> {
  await press(page, '[data-furnace-take]')
}

/** `pickUp(page)` (Provides): presses Pick up. */
export async function pickUp(page: Page): Promise<void> {
  await press(page, '[data-furnace-pickup]')
}
