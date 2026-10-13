// `bench_belts @slow` (M57): the bench build's belt field (`?bench=belts`, `src/bench.ts`; the field
// is `sim/src/bench.rs`'s, written at genesis at the phone pair's caps) on desktop Chromium, at both
// zooms the phones run: `zoom=max` (256 tiles across: one belt sprite per belt entity in view, no
// item at 5 px a tile) and `zoom=mid` (64 across, 20 px a tile: the items drawn), plus `zoom=max` on
// a 390 x 844 portrait viewport (the field's 256 tiles fit the short side, `benchTilesAcross`). Each
// scene: the pan held at the field's centre; the DrawList's belt and item-layer records read on two
// frames at least a second of ticks apart, the belt records equal and pinned exact; the pan
// released and the HUD read once a full 10 s window (and 500 frames) has passed since, so no
// held-phase sample is left in it; then `engine_mem_grows` 0 in both workers and the HUD's p95s
// printed (the desktop record for ADR 0080; nothing asserts on them: `bench.frame_belts` gates the
// desktop). At `mid` the read waits for the spawners' items to reach the view's east edge (tick
// 1,800: the items move 1.875 tiles a second from x 0).
//
// The bench build (`vite build --mode bench`: cargo feature `bench`, output `dist-bench/`) is the slow
// tier's `reference-bench` build step; this spec serves it with its own `vite preview` on its own port.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { openGame } from '../helpers/game.js'

/** The fields of `src/bench.ts`'s `BenchHud` this spec reads (a structural copy: this package's
 * test `tsc` does not follow the page's `virtual:engine/wasm` imports). */
type BenchHud = {
  engineMemGrows: { sim: number; client: number }
  tick: number
  tickP95Ms: number
  frameP95Ms: number
  mainP95Ms: number
  rafP95Ms: number
  rafOver20Per10s: number
  records: number
  dropped: number
  beltRecords: number
  itemLayerRecords: number
  itemsDrawn: number
  gpuP95Ms: number | null
  gpuUnavailable: string | null
}

declare global {
  interface Window {
    __bench?: {
      hud(): BenchHud
      holdPan(): void
      releasePan(): void
      framesRendered(): number
    }
  }
}

const REFERENCE = fileURLToPath(new URL('../../', import.meta.url))
// The reference project's port (`ENGINE_TEST_PORT`, 4517 by default) plus an offset no other server
// uses (`bench.frame_reference` takes + 12).
const PORT = Number(process.env.ENGINE_TEST_PORT ?? 4517) + 13
const BASE = `http://127.0.0.1:${PORT}`
/** `bench-stats.ts`'s window. */
const WINDOW_MS = 10_000
/** Frames the released window must also hold (at 60 Hz, 10 s is 600). */
const WINDOW_FRAMES = 500
/** At `mid`, the tick by which the field's items fill the held view (x 96 to 160). */
const MID_FILLED_TICK = 1_800

let preview: ChildProcess | undefined

test.beforeAll(async () => {
  // The slow tier's `reference-bench` build step made `dist-bench/` (`scripts/suites.mjs`).
  if (!existsSync(join(REFERENCE, 'dist-bench/index.html'))) {
    throw new Error(
      'no games/reference/dist-bench: run `pnpm --filter reference build --mode bench`',
    )
  }
  preview = spawn(
    'pnpm',
    ['exec', 'vite', 'preview', '--mode', 'bench', '--host', '127.0.0.1', '--port', String(PORT)],
    { cwd: REFERENCE, stdio: 'ignore' },
  )
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${BASE}/index.html`)).ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`bench preview did not come up on ${BASE}`)
    await new Promise((r) => setTimeout(r, 200))
  }
})

test.afterAll(() => {
  preview?.kill()
})

const hud = (page: Page): Promise<BenchHud> =>
  page.evaluate(() => window.__bench?.hud() as BenchHud)

/** One scene: the held reads (two frames at least 20 ticks apart, belt records equal) after
 * `fromTick`, then the released window; returns the first held read and the window's HUD. */
async function scene(
  page: Page,
  zoom: 'max' | 'mid',
  fromTick: number,
  viewport = { width: 1280, height: 720 },
) {
  await page.setViewportSize(viewport)
  await openGame(page, { path: `${BASE}/index.html?bench=belts&zoom=${zoom}` })
  await page.waitForFunction(() => window.__bench !== undefined)
  await page.evaluate(() => window.__bench?.holdPan())
  await page.waitForFunction((t) => (window.__bench?.hud().tick ?? 0) >= t, fromTick, {
    timeout: 150_000,
  })
  const read = async () => {
    const h = await hud(page)
    return {
      tick: h.tick,
      beltRecords: h.beltRecords,
      dropped: h.dropped,
      itemLayerRecords: h.itemLayerRecords,
      itemsDrawn: h.itemsDrawn,
    }
  }
  const first = await read()
  await page.waitForFunction((t) => (window.__bench?.hud().tick ?? 0) >= t, first.tick + 20, {
    timeout: 10_000,
  })
  const second = await read()
  // The items flow, so only the belt records and drops are compared across the two frames.
  expect(
    { beltRecords: second.beltRecords, dropped: second.dropped },
    `${zoom}: the held reads 20 ticks apart`,
  ).toEqual({ beltRecords: first.beltRecords, dropped: first.dropped })
  // The window: wall time and frames since the release, measured in the page (the HUD's rolling
  // windows prune by wall time).
  const start = await page.evaluate(() => {
    window.__bench?.releasePan()
    return { t: performance.now(), frames: window.__bench?.framesRendered() ?? 0 }
  })
  await page.waitForFunction(
    ([s, ms, n]) =>
      performance.now() - s.t >= ms && (window.__bench?.framesRendered() ?? 0) - s.frames >= n,
    [start, WINDOW_MS + 500, WINDOW_FRAMES] as const,
    { timeout: 60_000 },
  )
  return { held: first, window: await hud(page) }
}

test('bench_belts: the belt field at both zooms and upright, records pinned, no memory growth @slow', async ({
  page,
}) => {
  test.setTimeout(360_000)
  const max = await scene(page, 'max', 200)
  const portrait = await scene(page, 'max', 200, { width: 390, height: 844 })
  const mid = await scene(page, 'mid', MID_FILLED_TICK)
  // 256 x 144 tiles at 5 px a tile: one sprite per belt entity in view (the whole field), no item
  // (below the 20 px cut): the item layer holds the own player's circle and range ring alone.
  expect(
    {
      beltRecords: max.held.beltRecords,
      dropped: max.held.dropped,
      itemLayerRecords: max.held.itemLayerRecords,
    },
    'max: belt records, dropped, item-layer records',
  ).toEqual({ beltRecords: 12_264, dropped: 0, itemLayerRecords: 2 })
  // Upright, the field's 256 tiles span the 390 px side: every belt is still in view.
  expect(
    {
      beltRecords: portrait.held.beltRecords,
      dropped: portrait.held.dropped,
      itemLayerRecords: portrait.held.itemLayerRecords,
    },
    'portrait max: belt records, dropped, item-layer records',
  ).toEqual({ beltRecords: 12_264, dropped: 0, itemLayerRecords: 0 })
  // 64 x 36 at 20 px: the belt entities the view's tile rectangle meets.
  expect(
    { beltRecords: mid.held.beltRecords, dropped: mid.held.dropped },
    'mid: belt records, dropped',
  ).toEqual({ beltRecords: 893, dropped: 0 })
  // The items at `mid`: a bound, not an exact read (0069 §8). The item clock runs on real rAF time
  // across real workers, so the edge items of the held view come and go from frame to frame (7,110
  // to 7,136 measured). Saturated lanes hold 8 items a belt tile; the 5 % slack below covers the
  // partial edge tiles and the underground ends in view (no splitter is in the held view: they sit
  // at x 64-65, the view at x 96-160; a splitter half would raise the count, not lower it), the 64
  // above the edge items of the lanes that cross the view's border (893 x 8 = 7,144).
  const items = mid.held.itemsDrawn
  expect(
    items >= 0.95 * 8 * mid.held.beltRecords && items <= 8 * mid.held.beltRecords + 64,
    `mid: ${items} items within [0.95 x 8 x ${mid.held.beltRecords}, 8 x ${mid.held.beltRecords} + 64]`,
  ).toBe(true)
  for (const [name, s] of [
    ['max', max],
    ['portrait max', portrait],
    ['mid', mid],
  ] as const) {
    expect(s.window.engineMemGrows, `${name}: engine_mem_grows`).toEqual({ sim: 0, client: 0 })
    const w = s.window
    console.log(
      `bench_belts ${name}: tick ${w.tick}, tick p95 ${w.tickP95Ms.toFixed(3)} ms, frame p95 ${w.frameP95Ms.toFixed(3)} ms, main p95 ${w.mainP95Ms.toFixed(3)} ms, rAF p95 ${w.rafP95Ms.toFixed(2)} ms, over 20 ms ${w.rafOver20Per10s}, gpu p95 ${w.gpuP95Ms === null ? `none (${w.gpuUnavailable})` : `${w.gpuP95Ms.toFixed(3)} ms`}, records ${w.records}, held items ${s.held.itemsDrawn}`,
    )
  }
})
