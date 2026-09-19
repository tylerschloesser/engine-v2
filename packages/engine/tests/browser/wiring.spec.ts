// Cross-origin isolation, worker/SAB wiring, the loader's `onLog`/`onPanic` plumbing, and the
// harness's `errors()` (docs/plan/03-browser-harness.md, Tests added). Chromium only: none of this
// needs a second engine (that is `determinism.spec.ts`).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ABI_VERSION, Role } from '../../src/abi.js'
import type { Harness, HarnessWorkerSpec } from '../../src/test/harness.js'
import { fixtureBuildDir } from '../support/fixtures.js'
import { openPage } from './support/page.js'

// `wiring.ts` (tests/browser/pages/, its own compiled program) declares the same augmentation; the
// two are never type-checked together, so this duplication costs nothing but a second source of truth.
declare global {
  interface Window {
    __wiring?: {
      url: string
      buildHash: string
      contentType: string | null
      crossOriginIsolated: boolean
      abiVersion: number
      logLines: string[]
    }
    __createHarness?: (workers: HarnessWorkerSpec[]) => Promise<Harness>
  }
}

test('wiring: crossOriginIsolated and SharedArrayBuffer on main', async ({ page }) => {
  await openPage(page, '/wiring.html')
  const main = await page.evaluate(() => ({
    crossOriginIsolated: window.crossOriginIsolated,
    sab: typeof SharedArrayBuffer !== 'undefined',
  }))
  expect(main).toEqual({ crossOriginIsolated: true, sab: true })
})

test('wiring: crossOriginIsolated and Atomics.wait in the worker', async ({ page }) => {
  await openPage(page, '/wiring.html')
  const workerEvent = page.waitForEvent('worker')
  const spec: HarnessWorkerSpec = {
    name: 'sim',
    role: Role.Sim,
    config: { arenaBytes: 1 << 20, game: { seed: '0x1', entities: 4 } },
  }
  await page.evaluate((s) => window.__createHarness?.([s]), spec)
  const worker = await workerEvent
  const report = await worker.evaluate(() => ({
    crossOriginIsolated: self.crossOriginIsolated,
    sab: typeof SharedArrayBuffer !== 'undefined',
    // `timed-out`, not a hang or a throw, proves the primitive works without a real waiter.
    atomicsWait: Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50),
  }))
  expect(report).toEqual({ crossOriginIsolated: true, sab: true, atomicsWait: 'timed-out' })
})

test('wiring: wasm Content-Type and a hashed /assets/*.wasm URL', async ({ page }) => {
  await openPage(page, '/wiring.html')
  const wiring = await page.evaluate(() => window.__wiring)
  expect(wiring?.contentType).toBe('application/wasm')
  expect(wiring?.url).toMatch(/^\/assets\/.*\.wasm$/)
})

test('wiring: buildHash equals game.json and the ABI version matches', async ({ page }) => {
  await openPage(page, '/wiring.html')
  const wiring = await page.evaluate(() => window.__wiring)
  const gameJson = JSON.parse(readFileSync(join(fixtureBuildDir('hash'), 'game.json'), 'utf8'))
  expect(wiring?.buildHash).toBe(gameJson.buildHash)
  expect(wiring?.abiVersion).toBe(ABI_VERSION)
  expect(gameJson.abiVersion).toBe(ABI_VERSION)
})

test('wiring: an engine.log line arrives through onLog', async ({ page }) => {
  await openPage(page, '/wiring.html')
  const wiring = await page.evaluate(() => window.__wiring)
  // `engine_init ok` (crates/engine/src/abi/mod.rs) logs at Debug on every init; dev-profile builds
  // keep it (release drops below Warn, 0014 §3).
  expect(wiring?.logLines.some((line) => line.includes('engine_init ok'))).toBe(true)
})

test('wiring: a deliberate panic surfaces as EngineTrap and the harness reports it', async ({
  page,
}) => {
  await openPage(page, '/wiring.html')
  const spec: HarnessWorkerSpec = {
    name: 'sim',
    role: Role.Sim,
    config: { arenaBytes: 1 << 20, game: { seed: '0x1', entities: 4, panicAtTick: 2 } },
  }
  const errors = await page.evaluate(async (s) => {
    const harness = await window.__createHarness?.([s])
    if (!harness) throw new Error('__createHarness missing')
    await harness.resume()
    harness.stepTick()
    harness.stepTick()
    harness.stepTick()
    // Lets the worker's postMessage('error') reach main's listener before errors() is read.
    await new Promise((resolve) => setTimeout(resolve, 100))
    return harness.errors()
  }, spec)
  expect(errors.length).toBeGreaterThan(0)
  expect(errors.some((e) => e.includes('fx-hash: panicAtTick 2'))).toBe(true)
  expect(errors.some((e) => e.startsWith('sim: '))).toBe(true)
})
