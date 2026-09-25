// `reference_depletion_visible` (docs/plan/20-reference-game-v0.md Tests added): dispatches
// `StartCollect` through the production `client.dispatch` path (`window.__dispatchStartCollect`,
// `main.ts`) and confirms the iron tile at `(0, 0)` (`tests/fixtures/landmarks.json`, `TEST_SEED`'s
// nearest resource to the origin) visibly depletes.
//
// One completed collect only removes one of `content::UNITS_PER_TILE` (10) units, staying inside
// the "full" depletion-stage bucket (7-10, docs/plan/20-reference-game-v0.md Planning decisions) --
// the *rendered* texel cannot show anything finer than the three stage buckets (`scripts/
// gen-assets.mjs` has exactly one flat colour per stage). Four real, sequential collects (`content::
// COLLECT` = 40 ticks = 2 real seconds each at the real page's own 20 Hz pace, since a game must
// never set `ClientOptions.test` -- `packages/engine/src/client.ts`'s own "never set by a game")
// bring `aux` from 10 to 6, crossing into "half" -- the fewest collects that cross any stage
// boundary at all from a fresh tile. This is real wall-clock time (~9 s total), well past this
// package's own "browser test p95 <= 3s" budget note -- `@slow` in the title moves it out of the
// fast `browser` suite entirely (`pnpm test`'s own budget, 35 s, had no room left for it: adding
// it to the fast tier measured 173 tests/33s, against a 170/26s baseline), verified instead by
// `pnpm test:slow browser -t reference_depletion_visible`. Flagged in this milestone's Deviations
// rather than silently accepted in the fast tier or worked around by weakening the assertion.
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __probeTile?: (
      tileX: number,
      tileY: number,
    ) => Promise<{ r: number; g: number; b: number; a: number }>
    __dispatchStartCollect?: (tileX: number, tileY: number, fromX: number, fromY: number) => number
  }
}

// `content::COLLECT.0` (40) ticks at the real page's own 20 Hz = 2000 ms, plus margin for
// scheduling jitter.
const COLLECT_WAIT_MS = 2_200
const COLLECTS_TO_CROSS_A_STAGE = 4

test('reference_depletion_visible @slow', async ({ page }) => {
  test.setTimeout(30_000)
  await openGame(page)

  const tile = { x: 0, y: 0 } // iron (`tests/fixtures/landmarks.json`)
  // The tile's own centre in Q24.8 raw units (`WorldPos::from_tile` + half a tile): always in
  // range regardless of `RANGE_Q8`'s exact value.
  const from = { x: 128, y: 128 }

  const full = await page.evaluate(([x, y]) => window.__probeTile?.(x, y), [
    tile.x,
    tile.y,
  ] as const)
  // Iron, full stage (`content::IRON` = 16, `RESOURCE_STAGE_FULL` offset 0): `scripts/
  // gen-assets.mjs`'s own committed colour (docs/plan/20-reference-game-v0.md Deviations).
  expect(full).toEqual({ r: 230, g: 140, b: 60, a: 255 })

  for (let i = 0; i < COLLECTS_TO_CROSS_A_STAGE; i++) {
    const seq = await page.evaluate(
      ([x, y, fx, fy]) => window.__dispatchStartCollect?.(x, y, fx, fy),
      [tile.x, tile.y, from.x, from.y] as const,
    )
    expect(seq, `collect #${i + 1} dispatched`).toBeGreaterThan(0)
    await page.waitForTimeout(COLLECT_WAIT_MS)
  }

  const half = await page.evaluate(([x, y]) => window.__probeTile?.(x, y), [
    tile.x,
    tile.y,
  ] as const)
  // Iron, half stage (`RESOURCE_STAGE_HALF` offset 1): the tile visibly depleted.
  expect(half).toEqual({ r: 180, g: 110, b: 50, a: 255 })
  expect(half).not.toEqual(full)
})
