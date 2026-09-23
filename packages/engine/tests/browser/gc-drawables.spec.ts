// `drawables` zero-GC page (docs/plan/17-drawlist-and-sprites.md step 6, Tests added: "page id
// `drawables` through `zeroGcSuite` (fixture with a few hundred entities, panning, actions from
// pre-encoded bytes; isolates `main`, `client`, `sim`, `gen0`)"), plus the two production DrawList
// tests that need a real worker publishing into a real triple buffer rather than the hand-filled
// scenes `draw-readback.spec.ts` uses: `drawlist.triple_newest_wins` (the worker publishes several
// times before main ever acquires) and `counters.draws_equal_nonempty_layers` (the real per-frame
// `drawCalls()` delta matches the real DrawList's own non-empty layer count). `expectAdapter: true`
// (a real WebGPU adapter, `terrain`/`connected-terrain`'s own precedent); `controlKinds: ['object',
// 'burst']` (a production worker has no spare `postMessage` type for a message-driven tick, same
// reasoning as every other production-topology page).
import { expect, test } from '@playwright/test'
import { SPRITE_TABLE_BYTES } from '../../src/render/atlas.ts'
import { CAPACITY, DRAW_BYTES, DRAW_FRAME_UNIFORM_BYTES } from '../../src/render/drawables.ts'
import { budget, expectWithinBudget } from '../support/budgets.ts'
import { zeroGcSuite } from './gc/suite.ts'
import { type AdapterInfo, expectAdapter } from './support/gpu.ts'
import { openPage } from './support/page.ts'

declare global {
  interface Window {
    __drawablesTest?: {
      resume(): Promise<void>
      park(): Promise<void>
      acquire(): void
      frameSeq(): number
      recordCount(): number
      nonEmptyLayerCount(): number
      drawListDropped(): number
      stepClientFrameOnly(): void
      acquireAndDraw(): void
      drawCallsNow(): number
      pipelineSwitchesNow(): number
      instanceBytesNow(): number
      populatedLayers(): number[]
      gpuBytes(): number
      terrainGpuBytes(): number
    }
  }
}

zeroGcSuite({
  pageId: 'drawables',
  path: '/gc-drawables.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})

test('drawlist.triple_newest_wins', async ({ page }, testInfo) => {
  await openPage(page, '/gc-drawables.html')
  const ready = await page.evaluate(() => window.__gc?.ready)
  expectAdapter(testInfo, (ready?.adapter as AdapterInfo | null) ?? null)

  // `__pageReady` leaves every worker parked (`window.__gc.run`'s own bracketing, Deviations):
  // `stepClientFrameOnly`/`acquire` below need it resumed first, the same way `run()` does.
  await page.evaluate(() => window.__drawablesTest?.resume())

  // Baseline: one acquire to see whatever the population loop's own trailing frame already
  // published (`gc-drawables.ts`'s own setup, before `__pageReady`).
  await page.evaluate(() => window.__drawablesTest?.acquire())
  const before = await page.evaluate(() => window.__drawablesTest?.frameSeq())
  expect(before).toBeDefined()

  // The client worker publishes a new DrawList every real frame (`frame()`'s own `begin_frame`/
  // `extract`/`sort_into` sequence, worker/client-drawlist.ts's `publish()` right after) -- ten real
  // publishes here, main never acquiring in between (`stepClientFrameOnly` never calls `acquire()`),
  // simulating "worker publishes faster than main consumes" (Tests added).
  const PUBLISHES = 10
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.__drawablesTest?.stepClientFrameOnly()
  }, PUBLISHES)

  // Main's one, late acquire sees the *last* of the ten publishes, not a stale intermediate one --
  // the newest-slot guarantee `sab/triple.ts`'s own `triple.newest_wins_never_partial` proves
  // generically, exercised here through the real DrawList production path instead of a synthetic
  // stamp.
  await page.evaluate(() => window.__drawablesTest?.acquire())
  const after = await page.evaluate(() => window.__drawablesTest?.frameSeq())
  const recordCount = await page.evaluate(() => window.__drawablesTest?.recordCount())
  expect(after).toBeDefined()
  expect(recordCount).toBeDefined()

  expect((after as number) - (before as number)).toBe(PUBLISHES)
  // The acquired slot is not torn: `record_count` decodes to a plausible value (never `undefined`,
  // never absurdly large -- `CAPACITY`, 0018 §2) rather than garbage from a half-written header.
  expect(recordCount as number).toBeGreaterThan(0)
  expect(recordCount as number).toBeLessThanOrEqual(65_536)

  expect(await page.evaluate(() => window.__drawablesTest?.nonEmptyLayerCount())).toBeGreaterThan(0)
  // Exit criteria: "drawListDropped == 0 in every test except the overflow test" -- 301-ish
  // populated records are far under CAPACITY (65,536), so nothing here should ever drop.
  expect(await page.evaluate(() => window.__drawablesTest?.drawListDropped())).toBe(0)

  await page.evaluate(() => window.__drawablesTest?.park())
})

test('counters.draws_equal_nonempty_layers', async ({ page }, testInfo) => {
  await openPage(page, '/gc-drawables.html')
  const ready = await page.evaluate(() => window.__gc?.ready)
  expectAdapter(testInfo, (ready?.adapter as AdapterInfo | null) ?? null)

  // Independent ground truth (fix round 1, coordinator review): the population loop's own
  // bookkeeping of which layers it actually dispatched entities to (`gc-drawables.ts`'s own
  // `POPULATE_LAYERS`, `[0, 3, 7]` -- a gap at 1/2/4/5/6), never `nonEmptyLayerCount()` or anything
  // else derived from `render/drawables.ts`'s own `computeLayerOffsets`/`layerCounts` -- a bug
  // there could move `drawCallsNow()`'s delta and a `layerCounts`-derived count together, and this
  // comparison would never catch it.
  const populatedLayers = await page.evaluate(() => window.__drawablesTest?.populatedLayers())
  expect(populatedLayers).toEqual([0, 3, 7])

  await page.evaluate(() => window.__drawablesTest?.resume())
  await page.evaluate(() => window.__drawablesTest?.stepClientFrameOnly())
  const before = await page.evaluate(() => window.__drawablesTest?.drawCallsNow())
  await page.evaluate(() => window.__drawablesTest?.acquireAndDraw())
  const after = await page.evaluate(() => window.__drawablesTest?.drawCallsNow())

  // One instanced draw per non-empty layer (0018 §2), never more (an empty layer costs nothing)
  // and never fewer (every non-empty layer gets its own draw call, `render/drawables.ts`'s own
  // `encodeDraws`) -- checked against the population loop's own three-layer ground truth, not
  // `render/drawables.ts`'s own layer-count parsing.
  expect((after as number) - (before as number)).toBe((populatedLayers as number[]).length)
  expect(after as number).toBeLessThanOrEqual(budget('counters.render.drawCallsMax'))

  await page.evaluate(() => window.__drawablesTest?.park())
})

test('counters.pipeline_switches_and_instance_bytes', async ({ page }, testInfo) => {
  await openPage(page, '/gc-drawables.html')
  const ready = await page.evaluate(() => window.__gc?.ready)
  expectAdapter(testInfo, (ready?.adapter as AdapterInfo | null) ?? null)

  await page.evaluate(() => window.__drawablesTest?.resume())
  await page.evaluate(() => window.__drawablesTest?.stepClientFrameOnly())

  // `pipelineSwitches`: `encodeDraws` sets the uber-quad pipeline at most once per `draw()`/
  // `encodeInto()` call, regardless of how many of the three populated layers (0, 3, 7) are
  // non-empty -- `budgets.json`'s own `counters.render.pipelineSwitches` (`1`) is read here, not
  // hard-coded, so a budget change and this test stay in sync.
  const pipelineBefore = await page.evaluate(() => window.__drawablesTest?.pipelineSwitchesNow())
  await page.evaluate(() => window.__drawablesTest?.acquireAndDraw())
  const pipelineAfter = await page.evaluate(() => window.__drawablesTest?.pipelineSwitchesNow())
  expect((pipelineAfter as number) - (pipelineBefore as number)).toBeLessThanOrEqual(
    budget('counters.render.pipelineSwitches'),
  )

  // `instanceBytes`: the one `queue.writeBuffer` call `acquire()` issues copies exactly
  // `record_count * 32` bytes (`DRAW_BYTES`, 0018 §2) for the slot it just read -- checked as a
  // fresh delta around one more `acquire()`, matched against `recordCount()` read immediately
  // after (the same slot: no publish happens in between).
  const bytesBefore = await page.evaluate(() => window.__drawablesTest?.instanceBytesNow())
  await page.evaluate(() => window.__drawablesTest?.acquire())
  const bytesAfter = await page.evaluate(() => window.__drawablesTest?.instanceBytesNow())
  const recordCount = await page.evaluate(() => window.__drawablesTest?.recordCount())
  expect(recordCount as number).toBeGreaterThan(0)
  expect((bytesAfter as number) - (bytesBefore as number)).toBe((recordCount as number) * 32)

  await page.evaluate(() => window.__drawablesTest?.park())
})

// docs/plan/17b-sprites-and-frame-budget.md fix round 1: "gpuBytes must cover the whole renderer
// ... measured on a real page that has both terrain and drawables" -- `gc-drawables.html` is exactly
// that page (a real TerrainRenderer + DrawablesRenderer, sprites installed). No `resume()`/`park()`
// bracketing needed: `gpuBytes()` reads only cached byte counts on the two renderer objects, never
// the client worker.
// Fix round 2 (coordinator review): `gpuBytes > 0` alone is satisfied by the page texture (terrain's
// own fixed 4 MiB) whether or not a sprite atlas ever loaded -- it cannot fail on a broken
// `setSpriteAtlas` wiring. `gc-sprite-art.mjs`'s own fixed fixture dimensions (96x64, mip 1 halved
// to 48x32 by `render/atlas.ts`'s own `mip1W`/`mip1H` formula) let the drawables-side share be
// recomputed independently of `DrawablesRenderer.gpuBytes()`'s own arithmetic, from exported
// constants alone (`CAPACITY`/`DRAW_BYTES`/`DRAW_FRAME_UNIFORM_BYTES`, `render/drawables.ts`;
// `SPRITE_TABLE_BYTES`, `render/atlas.ts`), and checked against `gpuBytes() - terrainGpuBytes()`.
const FIXTURE_ATLAS_W = 96
const FIXTURE_ATLAS_H = 64
const FIXTURE_ATLAS_MIP1_W = FIXTURE_ATLAS_W >> 1
const FIXTURE_ATLAS_MIP1_H = FIXTURE_ATLAS_H >> 1
const EXPECTED_ATLAS_GPU_BYTES =
  FIXTURE_ATLAS_W * FIXTURE_ATLAS_H * 4 +
  FIXTURE_ATLAS_MIP1_W * FIXTURE_ATLAS_MIP1_H * 4 +
  SPRITE_TABLE_BYTES * 2
const EXPECTED_DRAWABLES_GPU_BYTES =
  CAPACITY * DRAW_BYTES + DRAW_FRAME_UNIFORM_BYTES + EXPECTED_ATLAS_GPU_BYTES

test('counters.gpu_bytes_within_budget', async ({ page }, testInfo) => {
  await openPage(page, '/gc-drawables.html')
  const ready = await page.evaluate(() => window.__gc?.ready)
  expectAdapter(testInfo, (ready?.adapter as AdapterInfo | null) ?? null)

  const gpuBytes = await page.evaluate(() => window.__drawablesTest?.gpuBytes())
  const terrainGpuBytes = await page.evaluate(() => window.__drawablesTest?.terrainGpuBytes())
  expect(gpuBytes).toBeGreaterThan(0)
  expect(terrainGpuBytes, 'terrain-only share, read independently').toBeGreaterThan(0)
  // The sprite atlas's own specific contribution: the whole renderer's total minus terrain's own
  // share, checked against an independently recomputed expectation (not `DrawablesRenderer.
  // gpuBytes()`'s own cached sum) -- fails if `setSpriteAtlas` never installed a real atlas (the
  // drawables share would fall back to the tiny placeholder's own few hundred bytes instead).
  const drawablesGpuBytes = (gpuBytes ?? 0) - (terrainGpuBytes ?? 0)
  expect(drawablesGpuBytes, 'drawables share (instance buffer + uniform + atlas + tables)').toBe(
    EXPECTED_DRAWABLES_GPU_BYTES,
  )
  expectWithinBudget('counters.render.gpuBytes', gpuBytes ?? Number.POSITIVE_INFINITY)
})
