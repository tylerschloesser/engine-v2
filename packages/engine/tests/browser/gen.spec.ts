// The client generation queue over real workers and SABs (docs/plan/08b-gen-workers-and-queue.md,
// Tests added): `gen.html`'s imperative debug API, the same pattern `topology.ts` uses for
// `workers.spec.ts`. The zero-GC test lives in `gc-gen.spec.ts` (production-topology page,
// `gc-gen.html`), matching M06b's own `topology.html`/`gc-topology.html` split (Deviations).
import { expect, test } from '@playwright/test'
import type { GenStats } from '../../src/test/gen.ts'
import { budget } from '../support/budgets.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __genCreateClient?: (opts?: { genWorkers?: number; seed?: string; chunkBits?: number }) => void
    __genClientReady?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
    __genClientDestroy?: () => void
    __genSetView?: (opts: {
      x: number
      y: number
      halfExtentX: number
      halfExtentY: number
      velocityX?: number
      velocityY?: number
    }) => void
    __genStep?: (dtMs: number) => void
    __genStats?: () => Promise<GenStats>
    __genIdle?: () => Promise<void>
    __genChunkHash?: (cx: number, cy: number) => Promise<string | null>
    __genChunkHashRect?: (
      minCx: number,
      minCy: number,
      maxCx: number,
      maxCy: number,
    ) => Promise<(string | null)[]>
    __genIsolates?: () => Record<string, { memPages: number; memGrows: number }>
    __genRings?: () => Record<string, { drops: number; pushed: number; popped: number }>
    __genProbeOrder?: () => Promise<{
      ring0At: number
      ring1At: number
      ring2At: number
      cycles: number
    }>
  }
}

type Page = import('@playwright/test').Page

async function createClient(
  page: Page,
  opts?: { genWorkers?: number; seed?: string; chunkBits?: number },
): Promise<void> {
  await page.evaluate((o) => window.__genCreateClient?.(o), opts)
}

async function ready(page: Page): Promise<{ ok: boolean; code?: string; message?: string }> {
  const r = await page.evaluate(() => window.__genClientReady?.())
  if (!r) throw new Error('gen.spec: __genClientReady missing')
  return r
}

// A small 2x2 visible rect, used only by "one and two workers" below: `visible.expanded(2)` is a
// 6x6 = 36-chunk generation set, its own scope, not the view-clamp join case (which has its own
// geometry, `VIEW_CLAMP` below).
const SMALL_VIEW = { x: 32, y: 32, halfExtentX: 16, halfExtentY: 16 }
const SMALL_GENERATION_SET_SIZE = 36

// The view clamp of 0008 §5: "at most 9x9 visible chunks" (worst-case alignment for a 256-tile
// viewport, half-extent 128 tiles each axis) -- `visible_rect((0,0),(128,128),dims(5))` gives
// exactly `ChunkRect{(-4,-4)-(4,4)}` (9x9), the same rect `queue_counts_at_view_bound` (Rust) hard-
// codes. `visible.expanded(2)` = 13x13 = 169 -- PRE-PLAN §7's "chunk generation, join case" figure,
// `budgets.json`'s `counters.gen.genJoinChunks` (Planning decisions 8: exact values are budgets).
const VIEW_CLAMP = { x: 0, y: 0, halfExtentX: 128, halfExtentY: 128 }
const GENERATION_SET_SIZE = budget('counters.gen.genJoinChunks')
const PAN_CHUNKS = budget('counters.gen.genPanChunks')

async function setViewAndIdle(page: Page, view: typeof SMALL_VIEW): Promise<void> {
  await page.evaluate((v) => window.__genSetView?.(v), view)
  await page.evaluate(() => window.__genIdle?.())
}

test('gen: visible before ring 1 before ring 2', async ({ page }) => {
  await openPage(page, '/gen.html')
  await createClient(page, { genWorkers: 1 })
  expect(await ready(page)).toEqual({ ok: true })

  const r = await page.evaluate(() => window.__genProbeOrder?.())
  expect(r, 'probe ran').toBeTruthy()
  const { ring0At, ring1At, ring2At } = r as NonNullable<typeof r>
  expect(ring0At, `ring0At=${ring0At}`).toBeGreaterThan(0)
  expect(ring1At, `ring1At=${ring1At}`).toBeGreaterThan(0)
  expect(ring2At, `ring2At=${ring2At}`).toBeGreaterThan(0)
  expect(ring0At, `ring0=${ring0At} ring1=${ring1At}`).toBeLessThan(ring1At)
  expect(ring1At, `ring1=${ring1At} ring2=${ring2At}`).toBeLessThan(ring2At)

  await page.evaluate(() => window.__genClientDestroy?.())
})

test('gen: one and two workers give equal chunk hashes', async ({ page }) => {
  async function hashesFor(genWorkers: number): Promise<(string | null)[]> {
    await openPage(page, '/gen.html')
    await createClient(page, { genWorkers })
    expect(await ready(page)).toEqual({ ok: true })
    await setViewAndIdle(page, SMALL_VIEW)
    // One round trip for the whole rect, not one per chunk (browser suite time budget).
    const out = await page.evaluate(() => window.__genChunkHashRect?.(-2, -2, 3, 3) ?? [])
    await page.evaluate(() => window.__genClientDestroy?.())
    return out
  }

  const one = await hashesFor(1)
  expect(one).toHaveLength(SMALL_GENERATION_SET_SIZE)
  expect(one.every((h) => typeof h === 'string')).toBe(true)

  const two = await hashesFor(2)
  expect(two).toEqual(one)
})

test('gen: drops 0, mem_grows 0, stats exact', async ({ page }) => {
  await openPage(page, '/gen.html')
  await createClient(page, { genWorkers: 1 })
  expect(await ready(page)).toEqual({ ok: true })

  await setViewAndIdle(page, VIEW_CLAMP)
  const join = (await page.evaluate(() => window.__genStats?.())) as GenStats
  expect(join).toEqual({
    requested: GENERATION_SET_SIZE,
    dispatched: GENERATION_SET_SIZE,
    delivered: GENERATION_SET_SIZE,
    cancelled: 0,
    requeued: 0,
    pending: 0,
    inFlight: 0,
  })

  const ringsAfterJoin = (await page.evaluate(() => window.__genRings?.())) as Record<
    string,
    { drops: number; pushed: number; popped: number }
  >
  for (const [name, s] of Object.entries(ringsAfterJoin)) {
    expect(s.drops, `${name}.drops`).toBe(0)
  }

  // Pan one chunk edge east: visible shifts from {(-4,-4)-(4,4)} to {(-3,-4)-(5,4)}; the new
  // `visible.expanded(2)` (still 13x13=169) overlaps the old one in 156 chunks (12x13), leaving 13
  // new ones (x=7, y=-6..6) -- `genPanChunks` in budgets.json.
  await page.evaluate((v) => window.__genSetView?.(v), { ...VIEW_CLAMP, x: 32 })
  await page.evaluate(() => window.__genIdle?.())
  const pan = (await page.evaluate(() => window.__genStats?.())) as GenStats
  expect(pan.cancelled).toBe(0)
  expect(pan.requeued).toBe(0)
  expect(pan.pending).toBe(0)
  expect(pan.inFlight).toBe(0)
  expect(pan.requested - join.requested).toBe(PAN_CHUNKS)
  expect(pan.dispatched - join.dispatched).toBe(PAN_CHUNKS)
  expect(pan.delivered - join.delivered).toBe(PAN_CHUNKS)

  const ringsAfterPan = (await page.evaluate(() => window.__genRings?.())) as Record<
    string,
    { drops: number; pushed: number; popped: number }
  >
  for (const [name, s] of Object.entries(ringsAfterPan)) {
    expect(s.drops, `${name}.drops`).toBe(0)
  }

  const isolates = (await page.evaluate(() => window.__genIsolates?.())) as Record<
    string,
    { memPages: number; memGrows: number }
  >
  expect(isolates.client?.memGrows).toBe(0)
  expect(isolates.gen0?.memGrows).toBe(0)

  await page.evaluate(() => window.__genClientDestroy?.())
})

test('gen: oversize slab is a readable fatal', async ({ page }) => {
  await openPage(page, '/gen.html')
  // 0007 §3 chunk bits 4/5/6 (edge 16/32/64): 6 gives a 64x64x4 = 16,384 B slab, far over the
  // browser topology's fixed genResult slot (16 + 4,096 B payload, `sab/layout.ts`'s `RING_
  // DEFAULTS.genResult`) -- Planning decisions 6's "the first game that changes CHUNK_BITS".
  await createClient(page, { chunkBits: 6 })
  const r = await ready(page)
  expect(r.ok).toBe(false)
  expect(r.code).toBe('worker-fatal')
  expect(r.message).toContain('does not fit the configured genResult slot')

  await page.evaluate(() => window.__genClientDestroy?.())
})
