// The harness's `stepTick`/`resume`/`park`/`untilQuiescent`/`hash`/`memGrows` mechanics
// (docs/plan/03-browser-harness.md, Tests added), proven through `stepping.html`'s single sim
// worker. Chromium only: this is ABI-level plumbing, not a determinism claim (that is
// `determinism.spec.ts`).
import { expect, test } from '@playwright/test'
import { RegionId, Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import type { Harness } from '../../src/test/harness.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import type { HashScenario } from '../support/scenario.js'
import { openPage } from './support/page.js'

// `stepping.ts` (its own compiled program) declares the same augmentation.
declare global {
  interface Window {
    __harness?: Harness
  }
}

test('stepping: 1,000 stepTick() in one task match a plain reference', async ({ page }) => {
  // The reference: the same config, 1,000 plain `sim_tick` calls, no admits (the harness's
  // `stepTick` never admits input either; that is a separate, setup-rate path).
  const scenario = readGolden<HashScenario>('hash', 'scenario.json')
  const { wasm } = await loadFixture('hash')
  const ref = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
  for (let t = 0; t < 1000; t++) ref.call0(ref.x.sim_tick)
  ref.call0(ref.x.sim_hash)
  const expected = ref.readU64Hex(RegionId.Result, 0)

  await openPage(page, '/stepping.html')
  const actual = await page.evaluate(async () => {
    const harness = window.__harness
    if (!harness) throw new Error('harness missing')
    await harness.resume()
    // The 1,000 calls are one synchronous JS task: stepTick() is synchronous and allocation-free
    // once resumed (Seams), so nothing here awaits between ticks.
    for (let t = 0; t < 1000; t++) harness.stepTick()
    await harness.park()
    return harness.hash('sim')
  })
  expect(actual).toBe(expected)
})

test('stepping: untilQuiescent() leaves the worker parked with nothing outstanding', async ({
  page,
}) => {
  await openPage(page, '/stepping.html')
  const hashLength = await page.evaluate(async () => {
    const harness = window.__harness
    if (!harness) throw new Error('harness missing')
    await harness.resume()
    harness.stepTick()
    harness.stepTick()
    await harness.untilQuiescent()
    // `hash()` only reaches a worker over `postMessage`, which a worker blocked in
    // `Atomics.wait` cannot receive (Seams): succeeding here is the public-API proof that
    // `untilQuiescent()` really left the worker parked, not just synchronously caught up.
    return (await harness.hash('sim')).length
  })
  expect(hashLength).toBe(16)
})

test('stepping: park() then hash() then resume() round-trips', async ({ page }) => {
  await openPage(page, '/stepping.html')
  const result = await page.evaluate(async () => {
    const harness = window.__harness
    if (!harness) throw new Error('harness missing')
    await harness.resume()
    harness.stepTick()
    await harness.park()
    const before = await harness.hash('sim')
    await harness.resume()
    harness.stepTick() // stepping still works after the round trip
    await harness.park()
    const after = await harness.hash('sim')
    return { before, after }
  })
  expect(result.before).not.toBe(result.after) // a tick ran between the two hashes
  expect(result.before).toHaveLength(16)
  expect(result.after).toHaveLength(16)
})

test('stepping: memGrows() is 0', async ({ page }) => {
  await openPage(page, '/stepping.html')
  const grows = await page.evaluate(async () => {
    const harness = window.__harness
    if (!harness) throw new Error('harness missing')
    await harness.resume()
    for (let t = 0; t < 100; t++) harness.stepTick()
    await harness.park()
    return harness.memGrows()
  })
  expect(grows).toEqual({ sim: 0 })
})
