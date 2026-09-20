// `createClient`'s spawn path, the production worker shell's `yield`/park/resume, the camera block
// reaching a WASM instance, and `destroy()` (docs/plan/06b-workers-and-spawn.md, Tests added).
// Chromium only except `spawn_local` (tagged `@engines`).
import { expect, type Worker as PageWorker, test } from '@playwright/test'
import { openPage } from './support/page.js'

// `topology.ts` (its own compiled program) declares the same augmentation.
declare global {
  interface Window {
    __client?: unknown
    __createClient?: (opts?: {
      host?: { kind: 'local'; world: { game: unknown } } | { kind: 'remote'; url: string }
      arenas?: { sim?: number; client?: number; gen?: number }
      genWorkers?: number
      test?: { game?: unknown; flags?: { postModule?: boolean } }
      createWorker?: () => Worker
    }) => void
    __clientReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __clientWorkers?: () => Record<string, { memPages: number; memGrows: number }>
    __clientDestroy?: () => void
    __setCameraAndStep?: (x: number, y: number, tilesAcross: number, dtMs: number) => void
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
  }
}

const MIB = 1024 * 1024
// Measured (`node --experimental-strip-types`, this session): every role's fixed footprint before
// its configured arena is reserved -- the boot region, static data, stack -- is 1,310,720 bytes
// (20 pages), identical for `sim`/`client`/`gen` on the dev-profile `fx-hash` module. A toolchain
// bump that changes this is expected to move it (docs/plan/06b-workers-and-spawn.md, Deviations).
const FIXED_FOOTPRINT_BYTES = 1_310_720

function expectedPages(arenaBytes: number): number {
  return (FIXED_FOOTPRINT_BYTES + arenaBytes) / 65536
}

type Page = import('@playwright/test').Page

async function ready(page: Page): Promise<{ ok: boolean; code?: string; message?: string }> {
  const r = await page.evaluate(() => window.__clientReady?.())
  if (!r) throw new Error('workers.spec: __clientReady missing')
  return r
}

/** A worker blocked in `Atomics.wait` receives no CDP (0015 §2): every kind but `net` enters that
 * loop right after `ready`, so a spec that reaches into a worker with `worker.evaluate()` parks
 * first (`workers.park_resume`'s own point) and, if it still needs the worker running afterwards,
 * resumes again. */
function park(page: Page): Promise<void> {
  return page.evaluate(() => window.__park?.())
}
function resume(page: Page): Promise<void> {
  return page.evaluate(() => window.__resume?.())
}

function workerKind(w: PageWorker): Promise<string> {
  return w.evaluate(
    () => (self as unknown as { __engineWorkerKind?: string }).__engineWorkerKind ?? '',
  )
}

test('workers.spawn_local @engines', async ({ page }) => {
  const created: PageWorker[] = []
  page.on('worker', (w) => created.push(w))

  await openPage(page, '/topology.html')
  await page.evaluate(() => window.__createClient?.({ genWorkers: 1 }))
  await expect.poll(() => created.length).toBe(3) // client + sim + gen0
  const r = await ready(page)
  expect(r).toEqual({ ok: true })

  await park(page)
  const kinds = (await Promise.all(created.map(workerKind))).sort()
  expect(kinds).toEqual(['client', 'gen', 'sim'])

  const memPages = await page.evaluate(() => window.__clientWorkers?.())
  // Defaults (0015 §5): sim 96 MiB, client 48 MiB, gen 4 MiB, one `memory.grow` each at init.
  expect(memPages).toEqual({
    client0: { memPages: expectedPages(48 * MIB), memGrows: 0 },
    sim1: { memPages: expectedPages(96 * MIB), memGrows: 0 },
    gen2: { memPages: expectedPages(4 * MIB), memGrows: 0 },
  })
})

test('workers.spawn_remote', async ({ page }) => {
  const created: PageWorker[] = []
  page.on('worker', (w) => created.push(w))

  await openPage(page, '/topology.html')
  await page.evaluate(() =>
    window.__createClient?.({
      genWorkers: 1,
      host: { kind: 'remote', url: 'wss://example.invalid' },
    }),
  )
  await expect.poll(() => created.length).toBe(3) // client + net + gen0
  const r = await ready(page)
  expect(r).toEqual({ ok: true })

  await park(page)
  const kinds = (await Promise.all(created.map(workerKind))).sort()
  expect(kinds).toEqual(['client', 'gen', 'net'])
})

test('workers.destroy_terminates', async ({ page }) => {
  const created: PageWorker[] = []
  const closed: PageWorker[] = []
  page.on('worker', (w) => {
    created.push(w)
    w.on('close', () => closed.push(w))
  })

  await openPage(page, '/topology.html')
  await page.evaluate(() => window.__createClient?.({ genWorkers: 1 }))
  await expect.poll(() => created.length).toBe(3)
  await ready(page)

  await page.evaluate(() => window.__clientDestroy?.())
  await expect.poll(() => closed.length).toBe(3)
})

test('workers.url_fallback', async ({ page }) => {
  const created: PageWorker[] = []
  page.on('worker', (w) => created.push(w))

  await openPage(page, '/topology.html')
  await page.evaluate(() =>
    window.__createClient?.({ genWorkers: 1, test: { flags: { postModule: false } } }),
  )
  await expect.poll(() => created.length).toBe(3)
  const r = await ready(page)
  expect(r).toEqual({ ok: true })

  // The worker itself called `instantiateStreaming`, not a posted `Module`; it still reserved its
  // arena correctly.
  const memPages = await page.evaluate(() => window.__clientWorkers?.())
  expect(memPages?.client0?.memPages).toBe(expectedPages(48 * MIB))
})

test('workers.camera_block_reaches_wasm', async ({ page }) => {
  const created: PageWorker[] = []
  page.on('worker', (w) => created.push(w))

  await openPage(page, '/topology.html')
  await page.evaluate(() => window.__createClient?.({ genWorkers: 1 }))
  await expect.poll(() => created.length).toBe(3)
  await ready(page)

  await park(page)
  let clientWorker: PageWorker | undefined
  for (const w of created) {
    if ((await workerKind(w)) === 'client') clientWorker = w
  }
  if (!clientWorker) throw new Error('workers.camera_block_reaches_wasm: no client worker')
  await resume(page)

  const centreX = 123.5
  const centreY = -987.25
  await page.evaluate(({ x, y }) => window.__setCameraAndStep?.(x, y, 12, 16.6), {
    x: centreX,
    y: centreY,
  })

  await park(page)
  const echoed = await clientWorker.evaluate(() => {
    const inst = (
      self as unknown as {
        __engineInstance?: { region(id: number): { u8: Uint8Array } | null }
      }
    ).__engineInstance
    const region = inst?.region(2) // RegionId.Result
    if (!region) return null
    return Array.from(region.u8.subarray(0, 16))
  })
  expect(echoed).not.toBeNull()
  const view = new DataView(new Uint8Array(echoed as number[]).buffer)
  expect(view.getFloat64(0, true)).toBe(centreX)
  expect(view.getFloat64(8, true)).toBe(centreY)
})

test('workers.park_resume', async ({ page }) => {
  const created: PageWorker[] = []
  page.on('worker', (w) => created.push(w))

  await openPage(page, '/topology.html')
  await page.evaluate(() => window.__createClient?.({ genWorkers: 1 }))
  await expect.poll(() => created.length).toBe(3)
  await ready(page)

  // Blocked: `worker.evaluate()` must not resolve before a bounded deadline.
  const blocked = await Promise.race([
    created[0]?.evaluate(() => 'answered'),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1500)),
  ])
  expect(blocked).toBe('timed-out')

  // Parked: the same call now answers.
  await park(page)
  const answers = await Promise.all(created.map((w) => w.evaluate(() => 'answered')))
  expect(answers).toEqual(['answered', 'answered', 'answered'])

  await resume(page)
})
