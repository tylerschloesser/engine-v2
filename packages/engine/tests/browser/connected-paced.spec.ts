// `connected-paced.html`'s tests (docs/plan/15b-ring-connection-and-replica-rendering.md,
// Orchestrator ruling 3): the ADR 0030 `AtomicsTimer.poll()` fix, landed inert in steps 1-3 and
// made live by this milestone's own step 4 (a linked client's uplink push is the first thing that
// ever wakes the sim worker from outside its own pacing timer). "A correctness fix nothing
// exercises is this repo's most-repeated defect" (this milestone's own brief): this file is what
// fails if `worker/sim.ts`'s `wokenBy === lastWokenBy` comparison (or the fix it guards) is ever
// removed. Chromium only: real-time pacing, not a GPU/renderer concern.
//
// docs/plan/15e-paced-tick-measurement.md: `SimHostCounters.ticksRun` is cumulative from
// `simHost.start()` (called at the end of `worker/sim.ts`'s own `setup()`), not reset per read, so
// the assertion below is over the *delta* between a reading taken right before the poke and one
// taken right after -- the ticks the sim ran during the poke window -- not the lifetime total,
// which also counts every tick the sim ran while the page was still loading and instantiating
// WASM (page load, `openPage`'s own wait, is unpaced wall time before this test starts poking).
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

  // Before-poke reading. `__simCounters` parks the workers to read through the parked-only
  // `test-call` channel, then resumes them (`src/test/client.ts`'s `parkWorkers`/`resumeWorkers`,
  // 15e brief Scope) so real-time pacing keeps running for the poke that follows -- that resume's
  // own re-entry into `runBlockingLoop` fires exactly one `poll()` on its first `body()` pass (wake
  // word unchanged from the park), one extra tick folded into the window below. Well inside the
  // margin the bounds already carry for real scheduling jitter.
  const before = await page.evaluate(() => window.__simCounters?.())
  const ticksBefore = before?.ticksRun ?? 0

  const pokeMs = 1500
  const pokeIntervalMs = 15 // well under `client_poll_uplink`'s own 50 ms rate limit (0010
  // "Rates"): most pokes are throttled away, but this still forces a real uplink push --
  // and hence a real external wake of the sim worker -- roughly every 50 ms, interleaved
  // with (not synchronised to) the sim's own ~50 ms pacing timer.
  await page.evaluate(({ ms, interval }) => window.__pokeFor?.(ms, interval), {
    ms: pokeMs,
    interval: pokeIntervalMs,
  })
  const after = await page.evaluate(() => window.__simCounters?.())
  const ticksRun = (after?.ticksRun ?? 0) - ticksBefore

  const expectedTicks = pokeMs / TICK_MS // ~30 at 20 Hz
  // A correct `wokenBy` guard: `ticksRun` tracks *elapsed time*, not wake count, so this delta
  // stays near `expectedTicks` regardless of how many external wakes this test forced (generous
  // margin for real scheduling jitter, including under load, plus the +1 noted above). A reverted
  // guard fires `poll()` -- and hence one extra tick -- on very nearly every external wake too,
  // roughly doubling it: this bound sits well below that, so it fails loudly instead of by a hair.
  expect(ticksRun).toBeGreaterThan(expectedTicks * 0.5)
  expect(ticksRun).toBeLessThan(expectedTicks * 1.35)
})

// docs/plan/16d-sim-pacing-under-external-wakes.md, step 1: a producer waking the sim worker more
// often than once per tick interval (a linked client's uplink every frame, later presence and
// actions) must not starve its pacing timer. `__wakeSimFor` wakes `WORKER_HOST` directly at ~60 Hz
// -- three wakes per 50 ms tick -- and records the sim's own `ticksRun` (`CB_SIM_TICKS_RUN`,
// readable without parking, so sampling never perturbs what it measures) at every wake.
const WAKE_MS = 2000
const WAKE_INTERVAL_MS = 16
/** Every ~250 ms sample: ticks run since the first sample may differ from elapsed time x tick rate
 * by at most this many ticks (200 ms: half of one `RESYNC_TICKS` window, the longest a correct
 * host can fall behind before `resync()` catches it up). */
const SAMPLE_MS = 250
const TOLERANCE_TICKS = 4
/** Longest real interval over which `ticksRun` may stay flat: two tick intervals, plus one wake
 * interval for the sampling grid itself (a change is only observed at the next wake). */
const MAX_FLAT_MS = 2 * TICK_MS + WAKE_INTERVAL_MS + 4

test('sim_ticks_steadily_under_external_wakes', async ({ page }) => {
  await openPage(page, '/connected-paced.html')
  const run = await page.evaluate(({ ms, interval }) => window.__wakeSimFor?.(ms, interval), {
    ms: WAKE_MS,
    interval: WAKE_INTERVAL_MS,
  })
  if (!run) throw new Error('sim_ticks_steadily_under_external_wakes: __wakeSimFor missing')
  const { t, ticks } = run
  const t0 = t[0] as number
  const k0 = ticks[0] as number

  const samples: string[] = []
  let worstDrift = 0
  let nextSample = SAMPLE_MS
  for (let i = 0; i < t.length; i++) {
    const elapsed = (t[i] as number) - t0
    if (elapsed < nextSample) continue
    nextSample += SAMPLE_MS
    const ran = (ticks[i] as number) - k0
    const drift = ran - elapsed / TICK_MS
    samples.push(`${Math.round(elapsed)}ms:${ran}`)
    if (Math.abs(drift) > Math.abs(worstDrift)) worstDrift = drift
  }

  let longestFlat = 0
  let lastChange = t0
  for (let i = 1; i < t.length; i++) {
    if (ticks[i] !== ticks[i - 1]) {
      longestFlat = Math.max(longestFlat, (t[i] as number) - lastChange)
      lastChange = t[i] as number
    }
  }
  longestFlat = Math.max(longestFlat, (t[t.length - 1] as number) - lastChange)

  const detail = `samples ${samples.join(' ')}; worst drift ${worstDrift.toFixed(1)} ticks; longest flat ${Math.round(longestFlat)} ms`
  expect(Math.abs(worstDrift), detail).toBeLessThanOrEqual(TOLERANCE_TICKS)
  expect(longestFlat, detail).toBeLessThanOrEqual(MAX_FLAT_MS)
})
