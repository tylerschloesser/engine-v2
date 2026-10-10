// `reference_roster_single_player` (M34 Goal: "Single-player is
// unchanged and shows a one-dot roster"): the local host's one player appears in `Ui.roster` and as
// one online, own-marked `.roster-dot`.
import { expect, test } from '@playwright/test'
import { openGame, readUi } from '../helpers/game.js'

test('reference_roster_single_player', async ({ page }) => {
  await openGame(page, { path: '/test.html' })
  const ui = await readUi(page)
  expect(ui.roster).toHaveLength(1)
  expect(ui.roster[0]).toMatchObject({ id: ui.me, online: true, me: true })
  expect(ui.roster[0]?.colour).toHaveLength(3)

  const dots = page.locator('.roster .roster-dot')
  await expect(dots).toHaveCount(1)
  await expect(dots.first()).toHaveAttribute('data-me', 'true')
  await expect(dots.first()).toHaveAttribute('data-online', 'true')
  await expect(dots.first()).not.toHaveClass(/offline/)
})
