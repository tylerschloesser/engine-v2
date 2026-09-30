// `reference_roster_single_player` (docs/plan/34-reference-multiplayer.md Goal: "Single-player is
// unchanged and shows a one-dot roster"): the local host's one player appears in `Ui.roster` and as
// one own-marked `.roster-dot` that mirrors its `online` flag.
import { expect, test } from '@playwright/test'
import { openGame, readUi } from '../helpers/game.js'

test('reference_roster_single_player', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  const ui = await readUi(page)
  expect(ui.roster).toHaveLength(1)
  // `online` is not asserted: no engine code writes `Delta::Roster { online: true }` on
  // `Connected` yet (M34 Deviations), so every dot is hollow today. The DOM must still mirror it.
  expect(ui.roster[0]).toMatchObject({ id: ui.me, me: true })
  expect(ui.roster[0]?.colour).toHaveLength(3)

  const dots = page.locator('.roster .roster-dot')
  await expect(dots).toHaveCount(1)
  await expect(dots.first()).toHaveAttribute('data-me', 'true')
  await expect(dots.first()).toHaveAttribute('data-online', String(ui.roster[0]?.online))
})
