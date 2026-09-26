// `sim-panicky.html`'s test (docs/plan/24-recovery-and-migration.md, Tests added:
// `sim_worker_recovers_from_panic`): the sim worker's own `body()` -> `SimHost.recover()` wiring, a
// real `.wasm` under a real worker topology (this is the only browser-suite proof of that path;
// `tests/wasm/panicky-recovery.test.ts` proves the state machine itself, under Node). Chromium only
// (no `@engines`): nothing here is WebGPU- or engine-specific.
import { expect, test } from '@playwright/test'
import { memoryStorage } from '../../src/storage/memory.js'
import { replayWorld } from '../../src/test.js'
import { loadFixture } from '../support/fixtures.js'
import { openPage } from './support/page.js'

// `sim-panicky.ts` (its own compiled program) declares the same augmentation.
declare global {
  interface Window {
    __simTicksRun?: () => number
    __trapSim?: () => Promise<number>
    __worldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __memGrows?: () => number
    __exportWorld?: () => Promise<number[]>
    __errors?: () => string[]
  }
}

test('sim_worker_recovers_from_panic', async ({ page }) => {
  const worldId = `panicky-${test.info().workerIndex}-${Date.now()}`
  // `sim_test_trap`'s own default panic text ("sim_test_trap: deliberate test trap") reaches the
  // page's console through the loader's default `onPanic` hook (`console.error`, `loader.ts`) --
  // expected exactly once here, `openPage`'s own `allowConsoleError` hook (docs/plan/
  // 24-recovery-and-migration.md's own addition to `support/page.ts`).
  await openPage(page, `/sim-panicky.html?world=${worldId}`, {
    allowConsoleError: (text) => text.includes('sim_test_trap'),
  })

  await expect.poll(() => page.evaluate(() => window.__simTicksRun?.() ?? 0)).toBeGreaterThan(0)

  // `__trapSim`'s own return value is the tick count read *while parked*, right before the trap --
  // the correct, race-free baseline (unlike a separately-read `__simTicksRun()`, which real-time
  // pacing could carry past before parking actually takes effect, making a later "greater than"
  // poll pass on ordinary pre-trap ticking alone instead of on recovery genuinely happening).
  const tickAtTrap = await page.evaluate(() => window.__trapSim?.())
  if (tickAtTrap === undefined) throw new Error('sim_worker_recovers_from_panic: __trapSim missing')

  // Normal pacing resumed on the fresh, recovered instance: ticks keep advancing past the trap.
  await expect
    .poll(() => page.evaluate(() => window.__simTicksRun?.() ?? 0))
    .toBeGreaterThan(tickAtTrap)

  // `memGrows() === 0` on the new instance (Tests added): a fresh instance's own arena never grew,
  // this trivial idle-only world never needing more than its reserved budget.
  expect(await page.evaluate(() => window.__memGrows?.())).toBe(0)

  const live = await page.evaluate(() => window.__worldHashAndTick?.())
  if (!live) throw new Error('sim_worker_recovers_from_panic: __worldHashAndTick missing')
  const bytes = await page.evaluate(() => window.__exportWorld?.())
  if (!bytes) throw new Error('sim_worker_recovers_from_panic: __exportWorld returned nothing')

  const storage = memoryStorage()
  const { importWorld } = await import('../../src/storage/archive.js')
  await importWorld(storage, new Uint8Array(bytes), { worldId })
  const { wasm } = await loadFixture('panicky')
  const replayed = await replayWorld({ wasm, storage, worldId, checkpoints: [live.tick] })
  expect(replayed).toHaveLength(1)
  expect(replayed[0]?.hash).toBe(live.hash)

  expect(await page.evaluate(() => window.__errors?.())).toEqual([])
})
