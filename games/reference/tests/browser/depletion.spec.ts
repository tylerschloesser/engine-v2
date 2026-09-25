// `reference_depletion_visible` (docs/plan/20-reference-game-v0.md Tests added; moved onto the
// stepped test entry by docs/plan/20b-reference-player-and-collect-ui.md step 0): dispatches
// `StartCollect` through the production `client.dispatch` path (`window.__dispatchStartCollect`,
// `test-entry.ts`) and confirms the iron tile at `(0, 0)` (`tests/fixtures/landmarks.json`,
// `TEST_SEED`'s nearest resource to the origin) visibly depletes.
//
// One completed collect only removes one of `content::UNITS_PER_TILE` (10) units, staying inside
// the "full" depletion-stage bucket (7-10, docs/plan/20-reference-game-v0.md Planning decisions) --
// the *rendered* texel cannot show anything finer than the three stage buckets (`scripts/
// gen-assets.mjs` has exactly one flat colour per stage). Four collects (`content::COLLECT` = 40
// ticks each) bring `aux` from 10 to 6, crossing into "half" -- the fewest collects that cross any
// stage boundary at all from a fresh tile.
//
// M20's own version of this test ran in real time (the production page must never set
// `ClientOptions.test`, so it paced 20 Hz for real -- ~9 s total, `@slow`). The stepped test entry
// (`test.html`/`test-entry.ts`) sets `ClientOptions.test`, so `window.__stepTick` (`engine/test.
// stepTick`) advances the sim deterministically with no wall-clock wait at all -- back in the fast
// tier (Deviations has the measured time).
import { expect, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

declare global {
  interface Window {
    __probeTile?: (
      tileX: number,
      tileY: number,
    ) => Promise<{ r: number; g: number; b: number; a: number }>
    __dispatchStartCollect?: (tileX: number, tileY: number, fromX: number, fromY: number) => number
    __stepTick?: (n: number) => Promise<void>
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    __stepFrame?: (dtMs: number) => Promise<void>
  }
}

// `content::collect_ticks` at 20 Hz (`sim/src/content.rs`): `TICK_RATE.secs(2)` = 40 ticks. `+ 1`:
// unlike `RefScenario::dispatch` (native tests), which applies a record inside the same `Sim::step`
// call that carries it, the real host queues an admitted action for the tick *after* the one it
// arrived on (0004: "Host assigns tick T+1"). This test drives ticks and the client's own uplink
// flush as two separate steps, so an action's `done_at` is always one tick later than the tick it
// was dispatched at -- one extra stepped tick per round accounts for that, found live (a bare 40
// left every other round's dispatch rejected `Busy`, one tick short of the previous collect's own
// completion).
const COLLECT_TICKS = 40 + 1
const COLLECTS_TO_HALF = 4

test('reference_depletion_visible', async ({ page }) => {
  await openGame(page, { path: '/test.html' })

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

  // `admit`'s own witness check (0001 "Witness-carrying actions" step 1) rejects `StartCollect`
  // until the host has a presence sample for this player: settle the camera near the tile and step
  // enough frames for the spring's own presence sample to be produced and uplinked (M20b's own
  // `PlayerPresence`) before dispatching.
  await page.evaluate(() => window.__setCamera?.(0, 0, 20))
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.__stepFrame?.(50))
  }

  for (let i = 0; i < COLLECTS_TO_HALF; i++) {
    const seq = await page.evaluate(
      ([x, y, fx, fy]) => window.__dispatchStartCollect?.(x, y, fx, fy),
      [tile.x, tile.y, from.x, from.y] as const,
    )
    expect(seq, 'StartCollect dispatched').toBeGreaterThan(0)
    // A dispatched action sits in the client's own action ring until the client's uplink pump
    // flushes it to the host (`client_poll_uplink`, run from the client's own `frame()`) -- one
    // `stepFrame` call before stepping sim ticks, so this collect is admitted before the ticks
    // meant to complete it run.
    await page.evaluate((dtMs) => window.__stepFrame?.(dtMs), 16)
    await page.evaluate((n) => window.__stepTick?.(n), COLLECT_TICKS)
  }

  const half = await probe()
  // Iron, half stage (`RESOURCE_STAGE_HALF` offset 1): the tile visibly depleted.
  expect(half).toEqual({ r: 180, g: 110, b: 50, a: 255 })
  expect(half).not.toEqual(full)
})
