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
import { budget } from '../support/budgets.ts'
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
      populatedLayers(): number[]
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
