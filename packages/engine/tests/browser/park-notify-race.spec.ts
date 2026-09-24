// M19b step 3 (docs/plan/19b-sim-park-while-armed.md): `armedLoop`'s own doc comment
// (`src/test/harness-worker.ts`) now waits on `Wake`, a word every park/step signal always bumps,
// closing the residual race fix round 3 (M17c) left open -- a park signal landing in the gap
// between the loop's own `Yield` check and the moment its `Atomics.wait` call actually registers as
// a waiter. Constructed directly (`park-notify-race.ts`, `park-notify-race-worker.ts`), the same
// "smallest browser test" shape `armed-loop-race.spec.ts` uses for the *other* gap: a plain Node
// unit test cannot drive `armedLoop` (it needs a real worker thread to construct real, cross-thread
// timing), and a still-broken `Atomics.wait` has no timeout of its own to bound from inside.
import { expect, test } from '@playwright/test'
import { openPage } from './support/page.ts'

// `park-notify-race.ts` (its own compiled program) declares the same augmentation.
declare global {
  interface Window {
    __testParkNotifySurvivesWaitRegistrationGap?: (
      spinMs: number,
      timeoutMs: number,
    ) => Promise<'returned' | 'timed-out'>
  }
}

test('harness-worker.armed_loop_survives_a_park_notify_in_the_wait_registration_gap', async ({
  page,
}) => {
  await openPage(page, '/park-notify-race.html')
  const result = await page.evaluate(
    ({ spinMs, timeoutMs }) =>
      window.__testParkNotifySurvivesWaitRegistrationGap?.(spinMs, timeoutMs),
    { spinMs: 150, timeoutMs: 3000 },
  )
  expect(result).toBe('returned')
})
