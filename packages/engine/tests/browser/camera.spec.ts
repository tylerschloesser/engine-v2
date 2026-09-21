// `camera: block reaches worker each frame` (docs/plan/11-camera-and-input.md, Tests added):
// injected pan input drives the real camera integration, one `camera` + `writeCamera` phase per
// tick (`topology.ts`'s own `__tickCamera`, mirroring `frame-loop.ts`'s `tick()` order), and the
// client worker's own WASM instance is read back over CDP after *every* tick -- not just the last
// one -- to prove each frame's write actually reaches the worker (not batched, not stale).
import { expect, type Worker as PageWorker, test } from '@playwright/test'
import { openPage } from './support/page.js'

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
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
    __setupCameraInput?: (viewport: { widthPx: number; heightPx: number }) => void
    __injectPointer?: (
      phase: 'down' | 'move' | 'up' | 'cancel',
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
      pointerType?: 'mouse' | 'touch' | 'pen',
    ) => void
    __tickCamera?: (dtMs: number) => {
      centreX: number
      centreY: number
      tilesAcross: number
      frameTimeMs: number
    }
  }
}

type Page = import('@playwright/test').Page

async function ready(page: Page): Promise<void> {
  const r = await page.evaluate(() => window.__clientReady?.())
  if (!r?.ok) throw new Error(`camera.spec: client not ready: ${JSON.stringify(r)}`)
}
function park(page: Page): Promise<void> {
  return page.evaluate(() => window.__park?.())
}
function resume(page: Page): Promise<void> {
  return page.evaluate(() => window.__resume?.())
}

/** Reads the client worker's own `RegionId.Result` (index 2), the same 24 bytes `fx-hash`'s
 * `frame()` writes `[centre.x, centre.y, t_ms]` into (docs/plan/06b-workers-and-spawn.md,
 * Deviations "Decision A as built"). Caller must have `park()`-ed first (a blocked worker receives
 * no CDP, 0015 §2). */
async function readEchoedCentre(clientWorker: PageWorker): Promise<{ x: number; y: number }> {
  const bytes = await clientWorker.evaluate(() => {
    const inst = (
      self as unknown as { __engineInstance?: { region(id: number): { u8: Uint8Array } | null } }
    ).__engineInstance
    const region = inst?.region(2) // RegionId.Result
    if (!region) return null
    return Array.from(region.u8.subarray(0, 16))
  })
  if (!bytes) throw new Error('camera.spec: no Result region')
  const view = new DataView(new Uint8Array(bytes).buffer)
  return { x: view.getFloat64(0, true), y: view.getFloat64(8, true) }
}

test('camera: block reaches worker each frame', async ({ page }) => {
  const created: PageWorker[] = []
  page.on('worker', (w) => created.push(w))

  await openPage(page, '/topology.html')
  await page.evaluate(() => window.__createClient?.({ genWorkers: 1 }))
  await expect.poll(() => created.length).toBe(3)
  await ready(page)

  await park(page)
  let clientWorker: PageWorker | undefined
  for (const w of created) {
    const kind = await w.evaluate(
      () => (self as unknown as { __engineWorkerKind?: string }).__engineWorkerKind ?? '',
    )
    if (kind === 'client') clientWorker = w
  }
  if (!clientWorker) throw new Error('camera: block reaches worker each frame: no client worker')
  await resume(page)

  await page.evaluate(() => window.__setupCameraInput?.({ widthPx: 1600, heightPx: 800 }))
  await page.evaluate(() => window.__injectPointer?.('down', 1, 800, 400, 0))

  const seen: Array<{ x: number; y: number }> = []
  for (let i = 1; i <= 4; i++) {
    const cssX = 800 + i * 30
    await page.evaluate((x) => window.__injectPointer?.('move', 1, x, 400, x), cssX)
    const step = await page.evaluate((dt) => window.__tickCamera?.(dt), 16)
    if (!step) throw new Error('camera.spec: __tickCamera missing')

    await park(page)
    const echoed = await readEchoedCentre(clientWorker)
    await resume(page)

    expect(echoed.x).toBe(step.centreX)
    expect(echoed.y).toBe(step.centreY)
    seen.push(echoed)
  }

  // Every frame actually panned (proves the loop above isn't reading a stale, unchanging value).
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]?.x).not.toBe(seen[i - 1]?.x)
  }
})
