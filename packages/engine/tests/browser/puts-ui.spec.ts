// `puts-ui.html`'s tests (docs/plan/16b-ui-observation-and-clock.md Tests added,
// `dom_counter_follows_global`/`progress_from_done_at_and_clock`): a real, connected
// `createClient()` topology over `fx-puts`'s own `PutsUi`, driven deterministically through
// `stepTick` (no real-time pacing). Chromium only: nothing here is renderer/GPU-specific.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __dispatchSetNote?: (n: number) => number
    __stepTick?: (n: number) => Promise<void>
    __resume?: () => Promise<void>
    __confirmed?: number
    __lastGlobalTicks?: () => number | null
  }
}

/** `connected.ts`'s own `__advance` shape: a `stepTick`-family call parks every worker as its own
 * postcondition (`untilQuiescent`'s trailing `parkWorkers`), so a *second* call needs an explicit
 * `resumeWorkers` first or the sim worker's own `Atomics.wait` never wakes for it
 * (`resumeWorkers`'s own doc comment: "calling resumeWorkers on an already-running client is safe
 * and cheap", so resuming before the very first call too costs nothing). */
async function advance(page: import('@playwright/test').Page, ticks: number): Promise<void> {
  await page.evaluate(() => window.__resume?.())
  await page.evaluate((n) => window.__stepTick?.(n), ticks)
}

test('dom_counter_follows_global', async ({ page }) => {
  await openPage(page, '/puts-ui.html')

  // Subscribes `lastUi` *before* the change that follows (Provides: "coalesced to the newest value
  // per rAF" -- a listener registered after a delivery simply never sees it, the same shape
  // `onActionResult` already has): the return value here is not itself meaningful.
  await page.evaluate(() => window.__lastGlobalTicks?.())
  await advance(page, 40)

  const domText = await page.locator('#global').textContent()
  // `__lastGlobalTicks` is this *same* subscription read again, not a read of `#global`'s own
  // text: comparing the two proves the DOM overlay actually reflects what `onUi` delivered to
  // every listener, not merely that the page can read its own state back.
  const lastGlobalTicks = await page.evaluate(() => window.__lastGlobalTicks?.())
  expect(lastGlobalTicks).not.toBeNull()
  expect(domText).toBe(String(lastGlobalTicks))
  // `Puts::tick` bumps `Global.day` once every 20 ticks (module doc comment): a real bump is
  // guaranteed somewhere inside any 40-tick window, whatever tick count `pumpUntilLive` itself
  // already reached before this test's own `advance(40)` call -- not pinned to an exact count,
  // since that starting point is not otherwise observable from this test.
  expect(lastGlobalTicks as number).toBeGreaterThan(0)
})

test('progress_from_done_at_and_clock', async ({ page }) => {
  await openPage(page, '/puts-ui.html')

  // No note set yet: zero remaining.
  await expect(page.locator('#progress')).toHaveText('0')

  await page.evaluate(() => window.__dispatchSetNote?.(7))
  // One tick at a time, with a real CDP round trip between each (`advance`'s own two separate
  // `page.evaluate` calls): the client worker's own action-ring drain and uplink push are a real,
  // separate OS thread racing this test's own `stepSimTickSync` calls, so a single big batch of
  // ticks can all run before that drain ever gets a turn -- unlike `stepFrame`'s own lockstep, a
  // dispatched action's admission has no synchronous acknowledgement this test can spin on.
  let confirmed = 0
  for (let i = 0; i < 20 && confirmed === 0; i++) {
    await advance(page, 1)
    confirmed = (await page.evaluate(() => window.__confirmed)) ?? 0
  }
  expect(confirmed).toBeGreaterThan(0)

  // `NOTE_TTL_SECS = 5` at the fixture's own 20 Hz tick rate = 100 ticks: right after the note
  // lands, the remaining-ticks value derived from `note_until` and `client.clock()` must be close
  // to that (a handful of ticks may already have elapsed by the time it was admitted and applied).
  const soonAfter = Number(await page.locator('#progress').textContent())
  expect(soonAfter).toBeGreaterThan(85)
  expect(soonAfter).toBeLessThanOrEqual(100)

  // Past the TTL: `Puts::tick` clears the note (`p.note = 0`), so `PutsClient::ui` reports
  // `note_until: 0` and the page's own "no note" convention reads back as zero remaining, not a
  // stale negative countdown.
  await advance(page, 110)
  await expect(page.locator('#progress')).toHaveText('0')
})
