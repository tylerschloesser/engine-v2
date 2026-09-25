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

// Condition-based, not a fixed wait per collect (CI run after M20's `done`: a fixed 2,200 ms per
// collect left 200 ms of slack and read the full-stage colour on `ubuntu-latest`). Each round
// dispatches `StartCollect` (rejected `Busy` while one is running, so a surplus dispatch is
// harmless) and probes, until the tile shows the half stage or the deadline passes. The deadline
// is generous because this page paces real 20 Hz ticks; M20b's stepped test entry replaces it.
const ROUND_MS = 250
const DEADLINE_MS = 25_000

test('reference_depletion_visible @slow', async ({ page }) => {
  test.setTimeout(40_000)
  await openGame(page)

  const tile = { x: 0, y: 0 } // iron (`tests/fixtures/landmarks.json`)
  // The tile's own centre in Q24.8 raw units (`WorldPos::from_tile` + half a tile): always in
  // range regardless of `RANGE_Q8`'s exact value.
  const from = { x: 128, y: 128 }
  const probe = () =>
    page.evaluate(([x, y]) => window.__probeTile?.(x, y), [tile.x, tile.y] as const)

  const full = await probe()
  // Iron, full stage (`content::IRON` = 16, `RESOURCE_STAGE_FULL` offset 0): `scripts/
  // gen-assets.mjs`'s own committed colour (docs/plan/20-reference-game-v0.md Deviations).
  expect(full).toEqual({ r: 230, g: 140, b: 60, a: 255 })

  const HALF = { r: 180, g: 110, b: 50, a: 255 }
  const started = Date.now()
  let half = full
  while (Date.now() - started < DEADLINE_MS) {
    const seq = await page.evaluate(
      ([x, y, fx, fy]) => window.__dispatchStartCollect?.(x, y, fx, fy),
      [tile.x, tile.y, from.x, from.y] as const,
    )
    expect(seq, 'StartCollect dispatched').toBeGreaterThan(0)
    await page.waitForTimeout(ROUND_MS)
    half = await probe()
    if (half?.r === HALF.r && half.g === HALF.g && half.b === HALF.b) break
  }

  // Iron, half stage (`RESOURCE_STAGE_HALF` offset 1): the tile visibly depleted.
  expect(half).toEqual(HALF)
  expect(half).not.toEqual(full)
})
