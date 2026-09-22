// `connected-paced.html`'s tests (docs/plan/15b-ring-connection-and-replica-rendering.md,
// Orchestrator ruling 3): the ADR 0030 `AtomicsTimer.poll()` fix, landed inert in steps 1-3 and
// made live by this milestone's own step 4 (a linked client's uplink push is the first thing that
// ever wakes the sim worker from outside its own pacing timer). "A correctness fix nothing
// exercises is this repo's most-repeated defect" (this milestone's own brief): this file is what
// fails if `worker/sim.ts`'s `wokenBy === lastWokenBy` comparison (or the fix it guards) is ever
// removed. Chromium only: real-time pacing, not a GPU/renderer concern.
import { expect, test } from '@playwright/test'
import type { SimHostCounters } from '../../src/server.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __pokeFor?: (ms: number, intervalMs: number) => Promise<void>
    __simCounters?: () => Promise<SimHostCounters>
  }
}

// docs/plan/13-sim-host-tick-loop.md / `server.ts`: `fx-puts`'s own `TICK_RATE` is the trait
// default (20 Hz), so a well-paced window ticks about once every 50 ms.
const TICK_MS = 50

test('poll_skips_a_spurious_tick_on_a_ring_wake', async ({ page }) => {
  await openPage(page, '/connected-paced.html')

  const pokeMs = 1500
  const pokeIntervalMs = 15 // well under `client_poll_uplink`'s own 50 ms rate limit (0010
  // "Rates"): most pokes are throttled away, but this still forces a real uplink push --
  // and hence a real external wake of the sim worker -- roughly every 50 ms, interleaved
  // with (not synchronised to) the sim's own ~50 ms pacing timer.
  await page.evaluate(({ ms, interval }) => window.__pokeFor?.(ms, interval), {
    ms: pokeMs,
    interval: pokeIntervalMs,
  })
  const counters = await page.evaluate(() => window.__simCounters?.())
  const ticksRun = counters?.ticksRun ?? 0

  const expectedTicks = pokeMs / TICK_MS // ~30 at 20 Hz
  // A correct `wokenBy` guard: `ticksRun` tracks *elapsed time*, not wake count, so it stays near
  // `expectedTicks` regardless of how many external wakes this test forced (generous margin for
  // real scheduling jitter, including under load). A reverted guard fires `poll()` -- and hence
  // one extra tick -- on very nearly every external wake too, roughly doubling it: this bound sits
  // well below that, so it fails loudly instead of by a hair.
  expect(ticksRun).toBeGreaterThan(expectedTicks * 0.5)
  expect(ticksRun).toBeLessThan(expectedTicks * 1.35)
})
