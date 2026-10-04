// Found by the demonstration of the whole round (docs/plan/39f-device-auto-runner.md step 15): checks walked
// one after the other in one tab. A helper tab (a Private tab) left open after its check must not walk the
// next one, and the first tab must not treat the previous check's world page as the page of the next check
// because the two differ only in a knob a helper tab's link may change (`world=`). Before the fixes the second
// check (M23-export-import) never finished: the tab that should have exported "read the imported world" at once.
// All `@slow @webkit-gpu`.
import { expect, test } from '@playwright/test'
import { finalOf, start } from './support/walk-rig.js'

const lib = new URL('../../../../scripts/lib/device-walk/', import.meta.url).href

test('walk-seq: M23-private then M23-export-import, the Private tab left open: both finish, the second tab of the second check is the helper @slow @webkit-gpu', async ({
  page,
}) => {
  // Playwright's WebKit has no durable OPFS: there the first tab itself reads `durable: false` and measures
  // M23-private as if it were the Private tab (a flow the walk-life spec covers alone), so a second check after
  // it is not a meaningful sequence. Chromium has OPFS; the sequence is the point of this test.
  test.skip(test.info().project.name !== 'chromium', 'no durable OPFS in the WebKit test context')
  test.setTimeout(180_000)
  const person = (await import(`${lib}fake-person.mjs`)) as {
    personHandlers(o: Record<string, unknown>): never[]
  }
  const r = await start(
    ['M23-private', 'M23-export-import'],
    { leaveMs: 1500, playMs: 3000, actTimeoutMs: 40_000 },
    17600,
  )
  try {
    const handlers = person.personHandlers({ page, joinUrl: r.joinUrl, closeHelpers: false })
    await r.phone(page, { timeoutMs: 170_000, handlers })
    const strict = true
    for (const id of ['M23-private', 'M23-export-import']) {
      const e = finalOf(r, id)
      expect(['pass', 'fail'], id).toContain(e.result)
      if (strict) expect(e.result, JSON.stringify(e.criteria)).toBe('pass')
    }
    // One attempt each: the open Private tab did not start a second one beside the first tab.
    for (const id of ['M23-private', 'M23-export-import'])
      expect(
        r.events().filter((e) => e.type === 'attempt' && e.id === id && e.status === undefined),
        id,
      ).toHaveLength(1)
    // The imported world was read by the tab opened from the bar, not by the first tab.
    const imp = r.events().find((e) => e.type === 'reading' && e.key === 'import')
    expect(imp, 'the imported world was read').toBeTruthy()
    expect(String((imp?.src as { tab: string } | undefined)?.tab)).toMatch(/-h/)
  } finally {
    await r.stop()
  }
})
