// ADR 0075 (0064 §16's missing end-to-end test): the server restarts on the same address with another
// world. The page's link redials, the new `Welcome` names another world (`WorldMismatch`), and the
// reference page reloads once, comes back online and shows the new world.
import { expect, test } from '@playwright/test'
import { openGame, pumpUntil } from '../helpers/game.js'
import { type ReferenceServer, startReferenceServer, untilConfigured } from '../helpers/server.js'

/** Ticks `server` until the page reports `state` (the handshake and redials need host ticks). */
async function untilLink(
  page: import('@playwright/test').Page,
  server: ReferenceServer,
  state: string,
): Promise<void> {
  const timer = setInterval(() => server.stepTick(), 5)
  try {
    await page.waitForFunction((s) => window.__linkState?.() === s, state, { timeout: 30_000 })
  } finally {
    clearInterval(timer)
  }
}

test('reference_world_mismatch_reloads_once_onto_the_new_world', async ({ page }) => {
  const first = await startReferenceServer({ manualTimer: true })
  const port = Number(new URL(first.url).port)
  let second: ReferenceServer | undefined
  try {
    await openGame(page, { invite: { server: first } })
    await untilConfigured(first, [page])
    await untilLink(page, first, 'online')
    // The resource tiles in range of the player at the spawn: the seed's own scatter, so the two
    // worlds tell apart (`Ui.spawn` alone does not: (0, 0) is land under both seeds).
    const inRange = async () => {
      const ui = await pumpUntil(page, (u) => (u?.in_range.length ?? 0) > 0)
      return (ui?.in_range ?? []).map((e) => `${e.tile.x},${e.tile.y}:${e.resource}`).sort()
    }
    const before = await inRange()

    let loads = 0
    page.on('load', () => loads++)
    await first.stop()
    second = await startReferenceServer({ manualTimer: true, seed: '12345', port })
    // The reload happens while the second server is ticking: the redial's `Welcome` is refused as
    // another world, the page reloads, and the fresh page configures from the new `Welcome`.
    const server = second
    await expect
      .poll(
        async () => {
          server.stepTick()
          return loads
        },
        { timeout: 30_000 },
      )
      .toBe(1)
    await page.waitForFunction(() => window.__pageReady === true)
    await untilConfigured(server, [page])
    await untilLink(page, server, 'online')
    expect(await inRange(), 'the new world').not.toEqual(before)
    expect(loads, 'one reload, no loop').toBe(1)
    expect(
      await page.evaluate(() => sessionStorage.getItem('reference.worldMismatchReload')),
      'the guard is cleared once online',
    ).toBeNull()
  } finally {
    await second?.stop()
    await first.stop().catch(() => {})
  }
})
