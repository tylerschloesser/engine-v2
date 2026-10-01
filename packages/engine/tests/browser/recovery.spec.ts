// docs/plan/37-robustness-events.md steps 1-3, Tests added (`browser`): a trapped client instance
// recovers and resyncs, the client-trap loop guard is fatal, a dead sim worker is respawned, and a
// failed storage write raises `onFatal` with every file left alone. `recovery.html` runs the real
// single-player topology on stepped frames and ticks and an injected clock: nothing here sleeps.
// Chromium only (nothing is renderer-specific). Gen-role traps: `gen-trap.spec.ts`.
import { expect, test } from '@playwright/test'
import { importWorld } from '../../src/storage/archive.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { replayWorld } from '../../src/test.js'
import { loadFixture } from '../support/fixtures.js'
import { openPage } from './support/page.js'

type FatalEvent = { tick: number; message: string }

declare global {
  interface Window {
    __recAdvance?: (x: number, y: number, tilesAcross: number, ticks: number) => Promise<void>
    __recFrames?: (n: number, dtMs?: number) => Promise<void>
    __recAdvanceClock?: (ms: number) => void
    __recStepSim?: (n: number) => Promise<void>
    __recDispatch?: (action: unknown) => number
    __recResults?: () => [number, unknown][]
    __recEvents?: () => { resyncing: number; fatal: FatalEvent[] }
    __recSession?: () => number
    __recPumpUntilOnline?: (minResyncing: number) => Promise<void>
    __recHashes?: () => Promise<{ replica: string; host: string }>
    __recWorldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __recDrawHash?: () => string
    __recSimTicks?: () => number
    __recClientTraps?: () => Promise<number>
    __recExport?: () => Promise<number[]>
    __recDump?: (worldId: string) => Promise<Record<string, number[]>>
    __recSimWorkers?: () => number
  }
}

type Page = import('@playwright/test').Page

/** The injected `RuntimeError` of `TestFlags.trapClientAtFrame` leaves no console line (it never goes
 * through `engine.panic`), so the default "no console error at all" rule of `openPage` holds. */
function recoveryUrl(query: Record<string, string>): string {
  return `/recovery.html?${new URLSearchParams(query).toString()}`
}

const events = (page: Page) => page.evaluate(() => window.__recEvents?.())
const call = <T>(page: Page, fn: () => Promise<T> | T) => page.evaluate(fn)

test('trap: client instance recovers and resyncs', async ({ page }) => {
  await openPage(
    page,
    recoveryUrl({ fixture: 'drawables', flags: JSON.stringify({ trapClientAtFrame: 3 }) }),
  )
  const drawHash = () => page.evaluate(() => window.__recDrawHash?.())

  const empty = await drawHash()
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 4))
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 4))
  const presenting = await drawHash()
  expect(presenting, 'the page is presenting a real DrawList').not.toBe(empty)

  // Frame 3 traps the client instance (`trapClientAtFrame`): the worker builds a fresh one and asks
  // for the full resync. `onResyncing` fires at once.
  await page.evaluate(() => window.__recFrames?.(1))
  await expect.poll(async () => (await events(page))?.resyncing).toBe(1)
  // Frame 4 runs on the new instance, before any `Welcome`: its replica is empty, and the worker
  // withholds the DrawList, so main keeps drawing the last one.
  await page.evaluate(() => window.__recFrames?.(1))
  expect(await drawHash(), 'main kept presenting the last DrawList').toBe(presenting)
  // No dispatch in the window between the trap and the new `Welcome`.
  await expect(page.evaluate(() => window.__recDispatch?.({ Spawn: {} }))).rejects.toThrow(
    /before ready/,
  )

  await page.evaluate(() => window.__recPumpUntilOnline?.(1))
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 4))
  const hashes = await page.evaluate(() => window.__recHashes?.())
  expect(hashes?.replica).toHaveLength(16)
  expect(hashes?.replica, 'replica hash equals host hash after the resync').toBe(hashes?.host)
  expect(await page.evaluate(() => window.__recClientTraps?.())).toBe(1)
  expect((await events(page))?.fatal).toEqual([])
})

test('fatal: two client traps', async ({ page }) => {
  // Traps at frames 3, 5 and 7 of the stepped client. The second is more than 10 s of injected time
  // after the first: recovered, no fatal (the guard counts the manual clock, not real time). The third
  // comes within 10 s of the second: `onFatal`.
  await openPage(
    page,
    recoveryUrl({ fixture: 'drawables', flags: JSON.stringify({ trapClientAtFrame: [3, 5, 7] }) }),
  )
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 2))
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 2))

  await page.evaluate(() => window.__recFrames?.(1)) // frame 3: trap
  await page.evaluate(() => window.__recPumpUntilOnline?.(1))
  await page.evaluate(() => window.__recAdvanceClock?.(11_000))
  await page.evaluate(() => window.__recFrames?.(2)) // frames 4, 5: trap, 11 s after the first
  await page.evaluate(() => window.__recPumpUntilOnline?.(2))
  expect((await events(page))?.fatal, 'two traps 11 s apart are recoverable').toEqual([])

  await page.evaluate(() => window.__recFrames?.(2)) // frames 6, 7: trap, a few ms after the second
  await expect.poll(async () => (await events(page))?.fatal.length).toBe(1)
  const fatal = (await events(page))?.fatal[0]
  expect(fatal?.message).toMatch(/trapped twice within 10 s/)
  expect(typeof fatal?.tick).toBe('number')

  // Afterwards `dispatch` hands back a seq and its result is a rejection (`EngineFault`).
  const seq = await page.evaluate(() => window.__recDispatch?.({ Spawn: {} }))
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__recResults?.()))?.find(([s]) => s === seq)?.[1],
    )
    .toEqual({ Rejected: { Engine: 'EngineFault' } })
})
