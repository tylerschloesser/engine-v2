// `sim: zero-GC over real ticking` (docs/plan/13-sim-host-tick-loop.md, step 6, Tests added: "zero-
// GC test extended to the sim isolate"): a real `createClient()` local topology over `fx-puts`, the
// sim isolate driven by one deterministic `sim_tick` per measured frame (`gc-sim.ts`). No `post-
// message` control, same reasoning as `topology`/`echo`/`gen` (orchestrator decision 2 of 06b): a
// production worker has no spare `postMessage` type for a message-driven tick.
//
// docs/plan/23-persistence-opfs-and-lifecycle.md step 6: `gc-sim.ts` now runs with persistence on
// unconditionally (`host.persist: true`) -- `sim clean`, above, is therefore also the strict,
// snapshot-free half of Planning decision 1 ("the strict test runs without a snapshot"; measured:
// still comfortably under the 8 B/frame budget, `gc-sim.ts`'s own Deviations has the numbers).
// `zero_gc_singleplayer_with_snapshot` and `neg_control_snapshot_allocates` are the other two tests
// that decision calls for, bespoke (not `zeroGcSuite`'s generic per-isolate loop): the first needs a
// `?forceSnapshot=1` page variant and a *budgeted-event* assertion shape `zeroGcSuite` has no concept
// of; the second needs a page-baked leak (`?leakyAppend=1`) with no counterpart isolate to compare
// against (`neg object`/`neg burst` already cover the generic per-isolate hook).
import { expect, test } from '@playwright/test'
import { budget } from '../support/budgets.ts'
import { measure } from './gc/instrument.ts'
import { zeroGcSuite } from './gc/suite.ts'
import { openPage } from './support/page.ts'

zeroGcSuite({
  pageId: 'sim',
  path: '/gc-sim.html',
  controlKinds: ['object', 'burst'],
})

/**
 * Planning decision 1, resolved outside the strict window (`budgets.json`'s own `counters.simWorker`
 * formula has the full measurement, corrected in fix round 1): the forced snapshot's own marginal
 * cost does not fit the 8 B/frame strict budget, so it is asserted here as a budgeted *event*
 * instead -- `snapshotEventBytes` (ADR 0039, superseding 0016's own deferred sentence) -- but as a
 * delta against `snapshotFreeBytesPerFrame` (the isolate's own tight *measured* snapshot-free rate),
 * never against the isolate's own separate strict *allowance* (fix round 1, coordinator correction:
 * subtracting the loose 8 B/frame ceiling instead of the ~4.6-4.8 B/frame this page's own idle world
 * actually measures let ~2 KB of unused strict slack silently absorb real snapshot growth -- ADR
 * 0029's failure mode, arrived at through arithmetic rather than a widened number). Zero `MajorGC` is
 * still required (Planning decision 1: "zero `MajorGC`").
 */
test('zero_gc_singleplayer_with_snapshot', async ({ page, browser }) => {
  await openPage(page, '/gc-sim.html?forceSnapshot=1')
  const r = await measure(page, browser, { pageId: 'sim', control: null })
  expect(r.errors, 'errors').toEqual([])
  expect(r.gc.sim?.MajorGC ?? 0, `MajorGC: ${JSON.stringify(r.gc.sim)}`).toBe(0)
  const snapshotFreeBytesPerFrame = budget('counters.simWorker.snapshotFreeBytesPerFrame')
  const snapshotEventBudget = budget('counters.simWorker.snapshotEventBytes')
  const totalBytesSim = r.totalBytes.sim ?? 0
  const delta = totalBytesSim - snapshotFreeBytesPerFrame * r.frames
  expect(
    delta,
    `sim: ${totalBytesSim} B over ${r.frames} frames (one forced snapshot) minus the measured ` +
      `snapshot-free rate (${snapshotFreeBytesPerFrame} B/frame * ${r.frames} = ` +
      `${snapshotFreeBytesPerFrame * r.frames} B) leaves a ${delta} B snapshot-attributable delta, ` +
      `over the ${snapshotEventBudget} B snapshotEventBytes budget. windowByFn.sim: ` +
      `${JSON.stringify(r.windowByFn.sim)}`,
  ).toBeLessThanOrEqual(snapshotEventBudget)
})

/**
 * 0029: a permanent negative control must actually trip on the isolate it names, never widened to
 * pass. `?leakyAppend=1` wraps the persisted world's own `Storage.append` (`TestFlags.
 * leakyStorageAppend`, `worker/sim.ts`) so every real tick's own synthetic `append` call also
 * allocates one throwaway object -- `sim` only, `main`/`client`/`gen0` untouched.
 */
test('neg_control_snapshot_allocates', async ({ page, browser }) => {
  await openPage(page, '/gc-sim.html?leakyAppend=1')
  const r = await measure(page, browser, { pageId: 'sim', control: null })
  expect(r.errors, 'errors').toEqual([])
  const strictBudget = budget('gc.pages.sim.isolates.sim.bytesPerFrame')
  expect(
    r.bytesPerFrame.sim,
    `sim: ${r.bytesPerFrame.sim} B/frame did not exceed the ${strictBudget} B/frame strict budget ` +
      `-- the leaky-append control failed to trip: ${JSON.stringify(r.byFn.sim)}`,
  ).toBeGreaterThan(strictBudget)
  // Nowhere else: `main`/`client`/`gen0` are untouched by this page's own `?leakyAppend=1` hook.
  const mainBudget = budget('gc.pages.sim.isolates.main.bytesPerFrame')
  expect(r.bytesPerFrame.main, `main: ${r.bytesPerFrame.main}`).toBeLessThanOrEqual(mainBudget)
})
