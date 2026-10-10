// `reference_full_game_single` (M34b Tests added): the
// whole reference game, once, through the real DOM: spawn on land, mine to the unlock, craft, place,
// pick the empty furnace up and place it two tiles over, fetch iron and coal, deposit, smelt, take;
// a last pick-up is refused because fuel is left. `Ui` is asserted after every phase (the script's
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
