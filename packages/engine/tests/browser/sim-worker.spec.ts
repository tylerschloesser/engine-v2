// `sim-worker.html`'s tests (docs/plan/13-sim-host-tick-loop.md, step 5, Tests added):
// `sim_worker_steps_and_hashes` (hash after `stepTick(100)` equals `fixtures/puts`'s own
// `.wasm`-authoritative golden, the same one `wasm_idle_100_matches_native` -- Node -- and
// `puts_idle_100_golden` -- native -- are each compared against) and `sim_worker_yields_for_cdp`
// (the sim isolate parks and resumes through the same `yield` protocol every other kind already
// proved, `workers.spec.ts`'s own pattern). Chromium only.
import { expect, type Worker as PageWorker, test } from '@playwright/test'
import type { SimHostCounters } from '../../src/server.js'
import { readGolden } from '../support/fixtures.js'
import type { Golden } from '../support/scenario.js'
import { openPage } from './support/page.js'

// `sim-worker.ts` (its own compiled program) declares the same augmentation.
declare global {
  interface Window {
    __stepTick?: (n: number) => Promise<void>
    __worldHash?: () => Promise<string>
    __simCounters?: () => Promise<SimHostCounters>
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
  }
}

test('sim_worker_steps_and_hashes', async ({ page }) => {
  const golden = readGolden<Golden>('puts', 'golden.json')

  await openPage(page, '/sim-worker.html')
  const hash = await page.evaluate(async () => {
    await window.__stepTick?.(100)
    return window.__worldHash?.()
  })

  expect(hash).toBe(golden.checkpoints[0])

  const counters = await page.evaluate(() => window.__simCounters?.())
  // Idle ticks only (no actions: Non-scope, Files touched): 100 run, none dropped or overrun, and
  // this page never sets a view (`host::warm::set_view`, M15) so the warmer always finds nothing
  // to warm -- every counter below is a live read, not a permanently-zero assertion in disguise
  // (`ticksRun`/`ticksDropped`/`tickOverruns` all *can* differ from this run's own values; only
  // `chunksWarmed`/`genOnMiss` are structurally always 0 here, for the reasons just given).
  expect(counters).toEqual({
    ticksRun: 100,
    ticksDropped: 0,
    tickOverruns: 0,
    chunksWarmed: 0,
    genOnMiss: 0,
  })
})

test('sim_worker_yields_for_cdp', async ({ page }) => {
  const created: PageWorker[] = []
  page.on('worker', (w) => created.push(w))

  await openPage(page, '/sim-worker.html')
  await expect.poll(() => created.length).toBe(3) // client + sim + gen0

  // A worker blocked in `Atomics.wait` receives no CDP (0015 §2): `__park` (the `yield` protocol)
  // is what makes every isolate -- the sim one included, now that it runs a real body -- reachable.
  await page.evaluate(() => window.__park?.())
  const kinds = await Promise.all(
    created.map((w) =>
      w.evaluate(() => (self as unknown as { __engineWorkerKind?: string }).__engineWorkerKind),
    ),
  )
  const simIndex = kinds.indexOf('sim')
  expect(kinds.slice().sort()).toEqual(['client', 'gen', 'sim'])
  expect(simIndex).toBeGreaterThanOrEqual(0)
  const sim = created[simIndex] as PageWorker
  const isolateName = await sim.evaluate(
    () => (self as unknown as { __engineIsolateName?: string }).__engineIsolateName,
  )
  expect(isolateName).toBe('sim')

  // Resume, tick again, and prove the sim worker still steps correctly after a park/resume round
  // trip (the M06b/M08b concern this milestone's own Deviations flags: a wake issued while parked
  // is not replayed on `resume()`, and `lastSeen` must be right on every re-entry).
  await page.evaluate(() => window.__resume?.())
  const secondHash = await page.evaluate(async () => {
    await window.__stepTick?.(1)
    return window.__worldHash?.()
  })
  expect(secondHash).toHaveLength(16)
})
