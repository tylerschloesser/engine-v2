// docs/plan/37-robustness-events.md steps 1-3, Tests added (`browser`): a trapped client instance
// recovers and resyncs, the client-trap loop guard is fatal, a dead sim worker is respawned, and a
// failed storage write raises `onFatal` with every file left alone. `recovery.html` runs the real
// single-player topology on stepped frames and ticks and an injected clock: nothing here sleeps.
// Chromium only (nothing is renderer-specific). Gen-role traps: `gen-trap.spec.ts`.
import { expect, test } from '@playwright/test'
import type { DesyncReport } from '../../src/client.js'
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
    __recUntilRespawned?: (n: number) => Promise<void>
    __recStaleReports?: (n: number) => Promise<void>
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
    __recSimRespawns?: () => number
    __recDesyncs?: () => DesyncReport[]
    __recCorrupt?: (cx: number, cy: number) => Promise<number>
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

const PAINTS: [number, number][] = [
  [2, 2],
  [3, 3],
  [4, 4],
]

/** Dispatches one `Paint` per entry of `PAINTS`, runs three ticks and waits for every result. */
async function paintAndConfirm(page: Page): Promise<number[]> {
  const seqs: number[] = []
  for (const [x, y] of PAINTS) {
    const seq = await page.evaluate(
      ([px, py]) =>
        window.__recDispatch?.({ Paint: { pos: { x: px, y: py }, base: 1, resource: 0 } }),
      [x, y],
    )
    seqs.push(seq as number)
  }
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 3))
  await expect
    .poll(async () => {
      const results = (await page.evaluate(() => window.__recResults?.())) ?? []
      return seqs.filter((s) => results.some(([r, v]) => r === s && v === 'Confirmed')).length
    })
    .toBe(seqs.length)
  return seqs
}

test('sim worker death respawns and resyncs', async ({ page }) => {
  const worldId = `death-${test.info().workerIndex}-${Date.now()}`
  const KILL_AT = 40
  const KILL_AGAIN_AT = 90
  await openPage(
    page,
    recoveryUrl({
      fixture: 'puts',
      persist: '1',
      world: worldId,
      // The respawned worker gets the entries not yet used, so it dies once more at the second tick.
      flags: JSON.stringify({ killSimWorkerAtTick: [KILL_AT, KILL_AGAIN_AT] }),
    }),
  )
  await paintAndConfirm(page)
  // The world as the host has it, with every admitted action in it, before the worker dies.
  const before = await page.evaluate(() => window.__recWorldHashAndTick?.())
  if (!before) throw new Error('no world hash')
  expect(before.tick).toBeLessThan(KILL_AT)

  // Ticks past `killSimWorkerAtTick`: the sim worker ends (as an uncaught error would end it). Main
  // replaces it from the kept `Module`; start-up is the ordinary load path (snapshot and log tail).
  await page.evaluate((n) => window.__recStepSim?.(n), KILL_AT - before.tick + 2)
  // The client keeps sending camera reports meanwhile (more than the 8 a connection may send before its
  // `Hello`): the new worker's connection drops them, up to the `Hello`.
  await page.evaluate(() => window.__recStaleReports?.(12))
  await page.evaluate(() => window.__recUntilRespawned?.(1))
  // The new sim knows no session: the client says `Hello` again, the answer is a second `Welcome`
  // at the bumped epoch (`onResyncing`), and the replica is rebuilt from the host.
  await page.evaluate(() => window.__recPumpUntilOnline?.(1))
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 3))

  expect((await events(page))?.fatal).toEqual([])
  expect(await page.evaluate(() => window.__recSimWorkers?.())).toBe(1)
  const hashes = await page.evaluate(() => window.__recHashes?.())
  expect(hashes?.replica).toBe(hashes?.host)

  // No admitted action lost, by log comparison: the stored log, replayed to the tick the world had
  // reached before the death, gives the very hash the host reported then.
  const bytes = await page.evaluate(() => window.__recExport?.())
  if (!bytes) throw new Error('export returned nothing')
  const storage = memoryStorage()
  await importWorld(storage, new Uint8Array(bytes), { worldId })
  const { wasm } = await loadFixture('puts')
  const replayed = await replayWorld({ wasm, storage, worldId, checkpoints: [before.tick] })
  expect(replayed[0]?.hash).toBe(before.hash)

  // The epoch bumped (0005 Panic recovery 2): the manifest on disk says so.
  const dump = await page.evaluate((id) => window.__recDump?.(id), worldId)
  const manifest = JSON.parse(
    new TextDecoder().decode(new Uint8Array(dump?.[`worlds/${worldId}/manifest`] ?? [])),
  ) as { epoch: number }
  expect(manifest.epoch).toBeGreaterThanOrEqual(1)

  // Loop guard (0005 Panic recovery 3-4): a second death within 10 s of injected time is fatal, not
  // another respawn.
  await page.evaluate((n) => window.__recStepSim?.(n), KILL_AGAIN_AT)
  await expect.poll(async () => (await events(page))?.fatal.length).toBe(1)
  expect((await events(page))?.fatal[0]?.message).toMatch(/sim worker died twice within 10 s/)
  expect(await page.evaluate(() => window.__recSimRespawns?.())).toBe(1)
})

test('fatal: storage error', async ({ page }) => {
  const worldId = `storage-${test.info().workerIndex}-${Date.now()}`
  const FAIL_AT = 12
  await openPage(
    page,
    recoveryUrl({
      fixture: 'puts',
      persist: '1',
      world: worldId,
      flags: JSON.stringify({ failStorageAtTick: FAIL_AT }),
    }),
  )
  await paintAndConfirm(page)
  const before = await page.evaluate(() => window.__recWorldHashAndTick?.())
  expect(before?.tick ?? FAIL_AT).toBeLessThan(FAIL_AT)

  // The world has run `FAIL_AT` ticks: its storage reports a failed write (`Storage.onError`, 0005
  // Storage: a failed or lost write is fatal to the world). `onFatal`, not a respawn.
  await page.evaluate((n) => window.__recStepSim?.(n), FAIL_AT - (before?.tick ?? 0) + 2)
  await expect.poll(async () => (await events(page))?.fatal.length).toBe(1)
  const fatal = (await events(page))?.fatal[0]
  expect(fatal?.message).toMatch(/storage error: .*failStorageAtTick/)
  expect(fatal?.tick).toBeGreaterThanOrEqual(FAIL_AT)
  expect(await page.evaluate(() => window.__recSimRespawns?.())).toBe(0)

  // From here on nothing touches a file and nothing ticks, and `dispatch` is a rejection.
  const filesAtFatal = await page.evaluate((id) => window.__recDump?.(id), worldId)
  expect(Object.keys(filesAtFatal ?? {}).length).toBeGreaterThan(0)
  const ticksAtFatal = await page.evaluate(() => window.__recSimTicks?.())
  const seq = await page.evaluate(() =>
    window.__recDispatch?.({ Paint: { pos: { x: 9, y: 9 }, base: 1, resource: 0 } }),
  )
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__recResults?.()))?.find(([s]) => s === seq)?.[1],
    )
    .toEqual({ Rejected: { Engine: 'EngineFault' } })
  expect(await page.evaluate(() => window.__recSimTicks?.())).toBe(ticksAtFatal)
  expect(await page.evaluate((id) => window.__recDump?.(id), worldId)).toEqual(filesAtFatal)
})

test('desync: onDesync fires once per report', async ({ page }) => {
  // M31b's `client_corrupt_chunk` on a linked page (production hash cadence: one chunk every 4
  // ticks): the sweep reaches the flipped chunk, the client reports it, asks for the resync and
  // heals. `client.onDesync` is called once, with a report naming the chunk; the healed chunk's
  // next sweep is clean and calls nothing.
  await openPage(page, recoveryUrl({ fixture: 'puts' }))
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 8))
  const before = await page.evaluate(() => window.__recDesyncs?.())
  expect(before, 'a clean session reports nothing').toEqual([])

  expect(await page.evaluate(() => window.__recCorrupt?.(0, 0)), 'chunk (0,0) is held').toBe(0)
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 8))
        return (await page.evaluate(() => window.__recDesyncs?.()))?.length
      },
      { timeout: 20_000 },
    )
    .toBe(1)
  const [report] = (await page.evaluate(() => window.__recDesyncs?.())) ?? []
  expect(report?.scope).toBe('chunk')
  expect([report?.cx, report?.cy]).toEqual([0, 0])
  expect(report?.hostHash).toMatch(/^[0-9a-f]{16}$/)
  expect(report?.clientHash).toMatch(/^[0-9a-f]{16}$/)
  expect(report?.clientHash).not.toBe(report?.hostHash)

  // The resync healed it: the replica matches the host, and two further sweeps report nothing.
  await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 8))
  const hashes = await page.evaluate(() => window.__recHashes?.())
  expect(hashes?.replica).toBe(hashes?.host)
  for (let i = 0; i < 20; i++) await page.evaluate(() => window.__recAdvance?.(0, 0, 32, 8))
  expect(
    await page.evaluate(() => window.__recDesyncs?.()),
    'a healed chunk fires nothing',
  ).toHaveLength(1)
})
