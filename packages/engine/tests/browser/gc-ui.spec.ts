// `no_ui_change_no_main_allocation` (docs/plan/16b-ui-observation-and-clock.md Tests added): a
// real, connected `createClient()` topology (`gc-ui.ts`) whose `fx-puts` `Ui` never actually
// changes across the whole measured window, proving the Budgets claim "unchanged `Ui` adds 0 B/
// frame (main row)". No `post-message` control (production-topology page, same reasoning as
// `sim`/`topology`/`echo`/`gen`).
import { expect, test } from '@playwright/test'
import { zeroGcSuite } from './gc/suite.ts'
import { openPage } from './support/page.js'

zeroGcSuite({
  pageId: 'no_ui_change',
  path: '/gc-ui.html',
  controlKinds: ['object', 'burst'],
})

declare global {
  interface Window {
    __uiTestStats?: () => Promise<{
      rustCalls: number
      rustRecords: number
      recordsSeenMain: number
      onUiFiredMain: number
    }>
  }
}

// Coordinator gate: the `formula` string in `budgets.json`'s `no_ui_change` entry only *claims*
// "no `pollActionResults@client-*` entry" from a `byFn` reading -- nothing asserted it. This test
// drives the *same* 600-frame window `window.__gc.run` (`gc-page.ts`, the harness the real zero-GC
// measurement also drives) without any CDP tracing/heap-profiler overhead, then asserts the claim
// directly, as a *delta* over that one call: `ui` actually ran (`rustCalls` moved, otherwise
// "constant Ui" would be vacuous -- the window could pass this test for the wrong reason, e.g. a
// broken `mutations()` wiring that never calls `ui` at all) and zero kind-1 records were written or
// drained *during the window* (`rustRecords`/`recordsSeenMain`/`onUiFiredMain` unmoved) -- every
// counter is cumulative for the page's whole life, not window-scoped, so `pumpUntilLive`'s own
// pre-window tick (the real `Global.day` 0 -> 1 change `gc-ui.ts`'s own module doc comment names)
// already counts one real `ui` call and one real record *before* this test's own window starts;
// only the delta across `run()` proves anything about the window itself. Not itself a zero-GC test
// (no CDP/tracing), so it can freely allocate to read the counts back.
test('no_ui_change_asserts_ui_ran_and_wrote_nothing', async ({ page }) => {
  await openPage(page, '/gc-ui.html')
  // The client worker is already parked at this point (`gc-ui.ts` parks before `__pageReady`,
  // `packages/engine/CLAUDE.md`'s own production-topology-page convention), so `__uiTestStats`'s
  // own `client_ui_stats` call is reachable here too, before the window even starts.
  const before = await page.evaluate(() => window.__uiTestStats?.())
  await page.evaluate(() => window.__gc?.run(600, false))
  const after = await page.evaluate(() => window.__uiTestStats?.())

  expect((after?.rustCalls ?? 0) - (before?.rustCalls ?? 0)).toBeGreaterThan(0)
  expect(after?.rustRecords).toBe(before?.rustRecords)
  expect(after?.recordsSeenMain).toBe(before?.recordsSeenMain)
  expect(after?.onUiFiredMain).toBe(before?.onUiFiredMain)
})
