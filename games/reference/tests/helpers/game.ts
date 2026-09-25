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
  inventory: { iron: number; wood: number; stone: number; coal: number }
  collecting: { tile: { x: number; y: number }; done_at: number } | null
  in_range: Array<{
    tile: { x: number; y: number }
    resource: number
    from: { x: number; y: number }
  }>
  spawn: { x: number; y: number }
}

declare global {
  interface Window {
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    __stepFrame?: (dtMs: number) => Promise<void>
    __stepTick?: (n: number) => Promise<void>
    __uiState?: () => RefUiState | null
  }
}

/**
 * `panTo(page, tile)` (Seams, Provides): settles the camera (and the spring it drives, M20b step 1)
 * on `tile`'s own centre, then steps enough sim ticks for the host to have actually downlinked that
 * tile into the client's own replica -- `Ui.in_range`/`world.tile()` need a real tick, not just
 * `stepFrame` (`games/reference/CLAUDE.md`, found live by `ui-smoke.spec.ts`). Stepped frames only
 * (`engine/test`'s own manual-clock contract): the caller's page must be `/test.html`.
 */
export async function panTo(
  page: Page,
  tile: { x: number; y: number },
  opts: { tilesAcross?: number } = {},
): Promise<void> {
  const tilesAcross = opts.tilesAcross ?? 20
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
 * `clickCollect(page, tile)` (Seams, Provides): clicks the one collect button anchored over `tile`
 * (`src/ui/collect.ts`'s own `data-collect-tile="x,y"` identity, Deviations) and flushes the
 * client's own action-ring uplink with one stepped frame (`depletion.spec.ts`/`ui-smoke.spec.ts`'s
 * own precedent: a dispatched action sits unflushed until `stepFrame` runs `client_poll_uplink`).
 */
export async function clickCollect(page: Page, tile: { x: number; y: number }): Promise<void> {
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
