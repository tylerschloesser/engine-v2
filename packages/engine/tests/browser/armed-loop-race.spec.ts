// M17c step 3, fix round 3 (docs/plan/17c-client-park-stall.md): `armedLoop`'s own doc comment
// (`src/test/harness-worker.ts`) checks `Yield` before every wait, including its first, so a park
// request whose own `Yield = 1` store (and, in the real protocol, `Atomics.notify(Req)` without
// changing `Req`, `harness.ts`'s `parkOne`) lands before that loop's own first wait is caught
// immediately rather than blocking `Atomics.wait` forever. Constructed directly (`armed-loop-race.ts`,
// `armed-loop-race-worker.ts`), not timed through a real `parkOne` round trip: this is the "smallest
// browser test" fallback (a plain Node unit test cannot drive `armedLoop`, which needs a real worker
// -- `self`/`postMessage` do not exist under Vitest's `node` environment -- and cannot safely bound a
// still-broken, timeout-less `Atomics.wait` from the same thread it runs on).
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.js'

// `armed-loop-race.ts` (its own compiled program) declares the same augmentation.
declare global {
  interface Window {
    __testArmedLoopChecksYieldFirst?: (timeoutMs: number) => Promise<'returned' | 'timed-out'>
  }
}

test('harness-worker.armed_loop_checks_yield_before_its_first_wait', async ({ page }) => {
  await openPage(page, '/armed-loop-race.html')
  const result = await page.evaluate((ms) => window.__testArmedLoopChecksYieldFirst?.(ms), 3000)
  expect(result).toBe('returned')
})
