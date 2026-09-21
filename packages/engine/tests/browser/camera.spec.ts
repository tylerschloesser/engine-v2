// `camera: block reaches worker each frame` (docs/plan/11-camera-and-input.md, Tests added):
// injected pan input drives the real camera integration, one `camera` + `writeCamera` phase per
// tick (`topology.ts`'s own `__tickCamera`, mirroring `frame-loop.ts`'s `tick()` order), and the
// client worker's own WASM instance is read back over CDP after *every* tick -- not just the last
// one -- to prove each frame's write actually reaches the worker (not batched, not stale).
import { expect, type Worker as PageWorker, test } from '@playwright/test'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __rcCreate?: (opts?: { cameraKey?: string }) => void
    __rcReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __rcDestroy?: () => void
    __rcRead?: () => { centreX: number; centreY: number; tilesAcross: number }
    __rcRestored?: () => boolean
    __rcMoveTo?: (x: number, y: number, opts?: { tiles?: number; durationMs?: number }) => void
    __rcTick?: (dtMs: number) => void
  }
}

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

// `camera: persisted and restored` (docs/plan/11-camera-and-input.md, Tests added; also: "`restored`
// is false on a fresh key" and "two `cameraKey`s do not share a camera"): a real `client.camera`
// (`real-camera.html`, this range's own page), a deliberately off-default position/zoom (a no-op
// save, or two clients sharing one `localStorage` slot, would both be caught by comparing exact
// values instead of just truthiness), and a fresh Playwright context per test (Playwright Test's own
// default), so `localStorage` starts empty without this test picking its own unique key.
test('camera: persisted and restored', async ({ page }) => {
  await openPage(page, '/real-camera.html')

  // Fresh key: nothing to restore yet.
  await page.evaluate(() => window.__rcCreate?.({ cameraKey: 'world-a' }))
  await page.evaluate(() => window.__rcReady?.())
  expect(await page.evaluate(() => window.__rcRestored?.())).toBe(false)

  // Jump to an off-default, off-grid position and zoom, then tick once: nothing else is engaged, so
  // the camera is "at rest" on this very first tick and `onMotionEnd` fires immediately.
  await page.evaluate(() => window.__rcMoveTo?.(1234.5, -987.25, { tiles: 33, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  const savedA = await page.evaluate(() => window.__rcRead?.())
  expect(savedA?.centreX).not.toBe(0) // sanity: actually moved off the class default
  await page.evaluate(() => window.__rcDestroy?.())

  // A second, independent world uses a different key with a different position: proves the two
  // don't share a slot, not just that each one's own round trip works.
  await page.evaluate(() => window.__rcCreate?.({ cameraKey: 'world-b' }))
  await page.evaluate(() => window.__rcReady?.())
  expect(await page.evaluate(() => window.__rcRestored?.())).toBe(false)
  await page.evaluate(() => window.__rcMoveTo?.(-42.75, 500.125, { tiles: 90, durationMs: 0 }))
  await page.evaluate(() => window.__rcTick?.(16))
  const savedB = await page.evaluate(() => window.__rcRead?.())
  await page.evaluate(() => window.__rcDestroy?.())

  // Re-open world-a: restored, and matches world-a's own values exactly (not world-b's).
  await page.evaluate(() => window.__rcCreate?.({ cameraKey: 'world-a' }))
  await page.evaluate(() => window.__rcReady?.())
  expect(await page.evaluate(() => window.__rcRestored?.())).toBe(true)
  const restoredA = await page.evaluate(() => window.__rcRead?.())
  expect(restoredA).toEqual(savedA)
  expect(restoredA).not.toEqual(savedB)
  await page.evaluate(() => window.__rcDestroy?.())

  // Re-open world-b: restored, and matches world-b's own values.
  await page.evaluate(() => window.__rcCreate?.({ cameraKey: 'world-b' }))
  await page.evaluate(() => window.__rcReady?.())
  expect(await page.evaluate(() => window.__rcRestored?.())).toBe(true)
  const restoredB = await page.evaluate(() => window.__rcRead?.())
  expect(restoredB).toEqual(savedB)
  await page.evaluate(() => window.__rcDestroy?.())
})
