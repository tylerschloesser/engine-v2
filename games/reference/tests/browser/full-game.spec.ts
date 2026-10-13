// `reference_full_game_single` (M34b Tests added): the
// whole reference game, once, through the real DOM: spawn on land, mine to the unlock, craft, place,
// pick the empty furnace up and place it two tiles over, fetch iron and coal, deposit, smelt, take;
// a last pick-up is refused because fuel is left; then (M52) a belt line with a curve and a side-load,
// one belt turned and one picked up, and the furnace panel opened again. `Ui` is asserted after every phase (the script's
// `expectUi` steps), and the final state hash must equal the headless run's: the golden
// (`tests/golden/full-game.json`, written by `pnpm --filter reference golden:record` from the same
// script on the headless driver), so the UI adds nothing the actions do not say. Stepped ticks and
// frames only; every wait is on a real `Ui` condition.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { openGame, uiState } from '../helpers/game.js'
import { domDriver, FURNACE_B, fullGame, runScript } from '../helpers/script.js'

const GOLDEN = fileURLToPath(new URL('../golden/full-game.json', import.meta.url))

test('reference_full_game_single', async ({ page }) => {
  // The script runs about 70 real-click steps (M52-M55's belt passages included): 5.8 s inside the
  // suite on Tyler's Mac, 7 s alone. The CI runner (4 vCPUs, software adapter) reads about 15x the
  // Mac's browser-suite time, so the spec reached the project's 30 s ceiling at step 67 on commit
  // 169af23a after passing on 24176ddc. CI only (`ENGINE_GPU=swiftshader`), as the `gc` project's
  // 180 s is (`playwright.config.ts`): a hang ceiling, not a budget; locally the 30 s stands so a
  // genuine hang still fails fast. 180 s, not 120 s, since 2026-10-13 (the slow tier swings about
  // 1.4x run to run; the gc project's note).
  test.setTimeout(process.env.ENGINE_GPU === 'swiftshader' ? 180_000 : 30_000)
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
    checkpoints: Array<{ tick: number; hash: string }>
  }
  const want = golden.checkpoints.at(-1)
  if (!want) throw new Error('full-game.json has no checkpoints')

  await openGame(page, { path: '/test.html' })
  await uiState(page) // primes the `lastUi` subscription
  await runScript(fullGame(), await domDriver(page))

  // What only the DOM shows: the panel of the last furnace still open on it, holding the fuel left.
  const ui = await uiState(page)
  expect(ui?.furnace).toMatchObject({
    at: FURNACE_B,
    iron_in: 0,
    coal: 0,
    burn_left: 9,
    ingots_out: 0,
  })
  await expect(page.locator('[data-count="burn_left"]')).toHaveAttribute('data-value', '9')
  await expect(page.locator('[data-furnace-pickup]')).toBeDisabled()

  // The run ended quiescent: the sim's state hash is the headless run's (a tick later is no change).
  await page.evaluate(() => window.__stepTick?.(1))
  expect(await page.evaluate(() => window.__worldHash?.()), 'state hash vs the golden run').toBe(
    want.hash,
  )
})
