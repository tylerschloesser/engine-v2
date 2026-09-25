// `slice.html`'s test (docs/plan/16-action-round-trip.md, step 6): the vertical slice itself --
// `client.dispatch(action)` -> action ring -> `on_action` -> uplink -> `admit` -> the frame for
// T+1 -> `apply` -> `Ack` and its deltas in one frame -> `client.onActionResult`. One test, named
// `vertical_slice` (Verification commands: `pnpm test browser -t vertical_slice`), phased so every
// claim in the brief's own "Tests added" list is checked and none of them can pass by accident
// (this repo's own recurring defect, named in the delegation prompt: "a test that cannot fail for
// the reason it claims" -- eight prior instances). Chromium only (no `@engines`): nothing here is
// engine-portability-specific beyond what `terrain-readback.spec.ts` already covers.
//
// Failability proofs (each phase below, proven by injecting the exact defect it exists to catch,
// watched red, then reverted -- see this milestone's own report for the "watched red at ..." line
// per phase):
//   - Phase 2 (pristine probe): reads GRASS at a tile *outside* `fx-puts`'s own `WALK` set (the
//     tick rule's own once-a-second overlay near the origin) -- proven by probing (0, 0) instead
//     (a `WALK` member): turns GRASS red once the sim has ticked at all, showing the "probe a tile
//     the tick rule never touches" choice is load-bearing, not incidental.
//   - Phase 3 (pan): proven by skipping the `__sliceInjectPointer` calls (camera held still) --
//     `chunkEntersPristine` stops growing and the assertion fails, the exact shape of this repo's
//     own prior "held-still camera" defect (`overlay_tile_reaches_screen`'s first draft).
//   - Phase 4 (worldHash): proven by asserting against a neighbouring/wrong literal hash --
//     fails as expected.
//   - Phase 5 (Paint round trip): proven two ways -- (a) probing the *pristine* tile instead of the
//     painted one (GRASS both before and after, the exact "probe reads a point where painted and
//     unpainted agree" trap the delegation prompt names) passes wrongly if the READ is wrong,
//     caught by choosing a tile the pristine phase never touched *and* asserting the pre-paint
//     colour is GRASS first; (b) asserting `confirmed` before it actually incremented (racing the
//     real result) -- proven by removing the `expect.poll` wait and reading `confirmed` once,
//     immediately after `dispatch`: flaky-red under repeat-each, confirming the poll is load-
//     bearing, not decorative.
//   - Phase 6 (out-of-range reject): proven by reverting `Puts::admit`'s new bound check --
//     `rejected` never increments and the test times out on `expect.poll`, instead of silently
//     reading `Confirmed`.
import { expect, test } from '@playwright/test'
import { instantiate } from '../../src/loader.js'
import type { AdapterInfo } from '../../src/render/device.js'
import type { NetCounters } from '../../src/test/client.js'
import type { PointerPhase } from '../../src/test/input.js'
import { expectPixel } from '../../src/test/render.js'
import { loadFixture, readGolden } from '../support/fixtures.js'
import { roleOf, runHashScenario, type SimScenario } from '../support/scenario.js'
import { expectAdapter, expectNoGpuErrors } from './support/gpu.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __dispatchPaintAt?: (x: number, y: number) => number
    __paintUnderCentre?: () => number
    __sliceConfirmed?: () => number
    __sliceRejected?: () => number
    __sliceLastReject?: () => unknown
    __setCamera?: (x: number, y: number, tilesAcross: number) => void
    __sliceInjectPointer?: (
      phase: PointerPhase,
      id: number,
      cssX: number,
      cssY: number,
      tMs: number,
    ) => void
    __netCounters?: (conn?: number) => Promise<NetCounters>
    __worldHash?: () => Promise<string>
    __worldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __sliceSettle?: (tileX?: number, tileY?: number, notTexel?: number) => Promise<void>
    __ringDrops?: () => number
    __tick?: () => number
    __hudText?: () => string
    __probeTile?: (
      tileX: number,
      tileY: number,
      size: number,
      notTexel?: number,
    ) => Promise<{ width: number; height: number; data: number[]; texel: number }>
    __errors?: () => string[]
    __adapterInfo?: () => AdapterInfo
  }
}

// `GRASS`/`WATER` (`connected-terrain.spec.ts`'s own colours, `scripts/gen-terrain-art.mjs`'s
// `CELLS`): `fx-puts`'s own `FlatWorldgen` is grass everywhere, and a dispatched `Paint{base: 1,
// resource: 2}` maps through the *identity* resource table straight to visual id 2 (`WATER`) --
// unlike the tick rule's own overlay (which goes through `PutsClient::tile_visual`'s `aux != 0`
// swap), a player-dispatched `Paint` never sets `aux`, so this is the identity-table path, not the
// aux-swap one; both happen to land on the same visual id (2), which is why this milestone's own
// Rust change picked `resource: 2` for `slice.ts`'s own Paint control.
const GRASS: readonly [number, number, number, number] = [34, 139, 34, 255]
const WATER: readonly [number, number, number, number] = [30, 80, 200, 255]
const TOL = 2 // 0020 §6

/** `readTilePixel`'s own camera: tile `(tileX, tileY)` exactly centred, zoom 1 tile/px, so it lands
 * on the exact centre pixel of a 16x16 probe target (`connected-terrain.spec.ts`'s own inverted-
 * formula precedent, generalised off tile (0, 0) to an arbitrary one). Gate-round fix: this used to
 * be built here and sent to `__writeFrameUniform`, a *separate* `page.evaluate` call from
 * `__renderAndRead` -- on `slice.html` specifically (unlike `connected-terrain.html`), a real
 * production render loop keeps calling `renderer.draw()` on its own in the background, and the gap
 * between those two calls was long enough, under contention, for a real animation frame to
 * interleave and overwrite the probe's own camera before its draw ran (Deviations has the full
 * mechanism and the reproduction). `__probeTile` (`slice.ts`) does both in one atomic call now;
 * this function just forwards to it. */
async function readTilePixel(
  page: import('@playwright/test').Page,
  tileX: number,
  tileY: number,
  notTexel = -1,
): Promise<import('../../src/test/render.js').PixelBuffer & { texel: number }> {
  const raw = await page.evaluate(([x, y, not]) => window.__probeTile?.(x, y, 16, not), [
    tileX,
    tileY,
    notTexel,
  ] as const)
  return {
    width: raw?.width ?? 0,
    height: raw?.height ?? 0,
    data: Uint8Array.from(raw?.data ?? []),
    texel: raw?.texel ?? -1,
  }
}

/** `camera.spec.ts`'s own `'camera: block reaches worker each frame'` drag shape (`down`, then a
 * few `move`s at growing offsets), but against `slice.html`'s *own* real camera integration
 * (`client.camera.tick()`, driven by the page's own production `requestAnimationFrame` loop, not a
 * test-only `__tickCamera` hook) -- one real animation frame awaited between moves so the page's
 * own `onCamera` hook actually integrates each one before the next is injected. */
async function dragPan(
  page: import('@playwright/test').Page,
  totalPx: number,
  steps = 6,
): Promise<void> {
  const startX = 400
  const y = 300
  await page.evaluate(([x, yy]) => window.__sliceInjectPointer?.('down', 1, x, yy, 0), [
    startX,
    y,
  ] as const)
  for (let i = 1; i <= steps; i++) {
    const cssX = startX - Math.round((totalPx * i) / steps) // drag left -> camera pans right (+x)
    await page.evaluate(([x, yy, t]) => window.__sliceInjectPointer?.('move', 1, x, yy, t), [
      cssX,
      y,
      i * 16,
    ] as const)
    await page.evaluate(() => new Promise(requestAnimationFrame))
  }
  await page.evaluate(([x, yy, t]) => window.__sliceInjectPointer?.('up', 1, x, yy, t), [
    startX - totalPx,
    y,
    (steps + 1) * 16,
  ] as const)
  await page.evaluate(() => new Promise(requestAnimationFrame))
}

test('vertical_slice', async ({ page }, testInfo) => {
  // Phase 1: cross-origin isolated (`openPage` itself asserts this), a sim worker exists, terrain
  // on screen.
  await openPage(page, '/slice.html')
  const adapterInfo = await page.evaluate(() => window.__adapterInfo?.())
  expectAdapter(testInfo, adapterInfo ?? null)

  // Phase 2: pristine terrain probe, at a tile `fx-puts`'s own tick-rule `WALK` never touches --
  // provably, for *any* tick count, not just early ones (gate-round check): `WALK` is a fixed
  // 8-entry array (`fixtures/puts/src/lib.rs`), indexed `WALK[g.walk_i % WALK.len()]` forever, so
  // it can only ever paint one of its own 8 fixed positions near the origin -- (20, 20) can never
  // be one of them, regardless of how many simulated seconds elapse.
  //
  // Gate-round fix: a pixel probe taken after a fixed real-time wait is not deterministic on this
  // real-time-paced page -- under contention the client worker's own chunk-generation round trip
  // can still be in flight when a fixed `setTimeout` ends (`node scripts/repeat.mjs browser 15
  // --load 10` found this: 2/30 failures, all `expectPixel(8, 8) channel r: got 34, want 30` --
  // Phase 5's *post*-paint `WATER` read below finding pristine `GRASS` still there, not a `WALK`
  // reach: 34 is `GRASS`'s own R channel exactly, and `WALK` cannot reach either probed tile at any
  // tick count, so the race is in the render catching up, not in what the sim painted).
  // `__sliceSettle` (`engine/test.untilQuiescent`) is deterministic instead: it waits for every SAB
  // ring -- including both gen-worker ring pairs -- to fully drain, so it only resolves once
  // whatever chunk-generation round trip was in flight has actually landed.
  // docs/plan/16d-sim-pacing-under-external-wakes.md, step 4: passing the tile makes the settle
  // also wait for that tile's chunk to be resident on the GPU -- the real event this read needs
  // (`slice.ts`'s `__sliceSettle` has the attribution).
  await page.evaluate(() => window.__setCamera?.(20, 20, 8))
  await page.evaluate(() => window.__sliceSettle?.(20, 20))
  expectPixel(await readTilePixel(page, 20, 20), 8, 8, GRASS, TOL)

  // Phase 3: injected pan brings new chunks into subscription -- a real drag through
  // `__sliceInjectPointer`, not a raw `cameraState` nudge, so the whole real input pipeline
  // (`installPointerListeners` -> `SemanticRecognizer` -> `CameraIntegrator`) is what moves it.
  // Zoomed well out (`tilesAcross: 64`) so a drag of a realistic CSS-pixel distance covers enough
  // *world* tiles to cross a chunk edge (32 tiles, `docs/spec/world.md`): at `tilesAcross: 8`
  // (the Paint-probe camera above) the same drag would pan only a couple of tiles, nowhere near
  // one chunk width -- the subscribed chunk rect would never move at all, and the assertion below
  // would fail not because panning is broken but because this test never asked for enough of it.
  await page.evaluate(() => window.__setCamera?.(0, 0, 64))
  const before = await page.evaluate(() => window.__netCounters?.())
  await dragPan(page, 4000)
  // The new camera position still has to travel uplink -> host admit -> subscription update
  // before `chunkEntersPristine` reflects it (0010 "Rates": at most one uplink batch per 50 ms) --
  // real wall-clock time, not a stepped tick.
  //
  // Panning + real per-connection state (camera, uplink pacing) wakes the sim worker externally
  // far more often than its own ~50 ms pacing timer fires (every `client.camera.tick()` real rAF
  // frame writes the camera block and, when the 0010 rate limit allows, sends a fresh uplink
  // batch). Until M16d this starved the sim's pacing timer for seconds (`worker/sim.ts`'s
  // `wokenBy === lastWokenBy` guard skipped every externally-woken pass); ADR 0032 fixed it and
  // `connected-paced.spec.ts`'s `sim_ticks_steadily_under_external_wakes` guards it. Give it room.
  // Gate-round fix: a fixed real-time wait here has the same shape the Phase 2/5 pixel probes had
  // (`node scripts/repeat.mjs browser 15 --load 10`'s own finding, below) -- 3 s is a guess, not a
  // guarantee, and under the wake-starvation this comment already describes the real wait could
  // need to be longer. Polling for the specific condition this assertion is actually about (`
  // chunkEntersPristine` increasing), with a generous ceiling, replaces the guess with the real
  // thing: it waits exactly as long as needed and still fails, clearly, if panning genuinely never
  // subscribes a new chunk.
  const baseline = before?.chunkEntersPristine ?? -1
  await expect
    .poll(
      async () => (await page.evaluate(() => window.__netCounters?.()))?.chunkEntersPristine ?? 0,
      {
        timeout: 20_000,
        message: 'a real drag must move the camera far enough to subscribe new chunks',
      },
    )
    .toBeGreaterThan(baseline)

  // Phase 4: a sim worker exists and `worldHash()` matches a golden at a fixed tick. `slice.html`
  // real-time-paces its own sim (Phase 3's own comment): the exact tick this page has reached at
  // any instant is not something a test can pin in advance without the same fragility Phase 3
  // just described (a static "wait until tick == 100 exactly" poll can overshoot past 100 in one
  // resync catch-up burst and never observe it at all). So this reads the *actual* tick reached
  // (`__worldHashAndTick`, both values from inside one park window so they can never drift apart)
  // and compares against a reference computed **the same way `pnpm golden` itself would** --
  // `runHashScenario` over `fixtures/puts/golden/scenario-connected.json`'s own committed config
  // (one connection, zero game actions -- exactly this page's own topology up to this point, no
  // `Paint` dispatched yet), with `ticks`/`checkpointEvery` set to the tick actually observed
  // instead of the committed file's own fixed 100. This is the same mechanism that produced
  // `golden-connected.json`'s `3a392e50dba8f378` at tick 100 -- a sanity re-check of that exact
  // figure is `expect(referenceAt100).toBe('3a392e50dba8f378')`, right below, so a change to the
  // fixture's own genesis/tick rule would be caught here too, not just by `pnpm golden`'s own gate.
  //
  // docs/plan/16d-sim-pacing-under-external-wakes.md, step 3: the threshold was 50 while the sim
  // stalled under this page's own external wakes (ADR 0032); every tick then arrived in one resync
  // burst, so the number did not matter. Now ticks arrive at 20 Hz and the wait is real time.
  // `__tick` reads the clock block, which only moves when a frame carries content -- here the tick
  // rule's once-a-second paint (ticks 0, 20, 40, ...) -- so any threshold resolves on a multiple of
  // 20. 20 is the first one after genesis: the checkpoint hash below then covers two tick-rule
  // writes, not genesis alone, and costs 1 s of real time instead of 3.
  await expect
    .poll(() => page.evaluate(() => window.__tick?.() ?? 0), { timeout: 20_000, intervals: [200] })
    .toBeGreaterThanOrEqual(20)
  const checkpoint = await page.evaluate(() => window.__worldHashAndTick?.())
  if (!checkpoint) throw new Error('vertical_slice: __worldHashAndTick missing')

  const { wasm } = await loadFixture('puts')
  const scenario = readGolden<SimScenario>('puts', 'scenario-connected.json')
  const referenceAt100 = runHashScenario(
    instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} }),
    scenario,
  )
  expect(referenceAt100).toEqual(['3a392e50dba8f378']) // the committed golden itself, unchanged
  const [reference] = runHashScenario(
    instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} }),
    { ...scenario, ticks: checkpoint.tick, checkpointEvery: checkpoint.tick },
  )
  expect(checkpoint.hash).toBe(reference)

  // Phase 5: `dispatch({ Paint })` returns 1 (this page's very first dispatch), `onActionResult(1,
  // 'Confirmed')` fires, and the probe at that tile shows the new colour. Tile (50, 50): clear of
  // `WALK` at any tick count (Phase 2's own comment) and of the (20, 20) pristine-probe tile above.
  await page.evaluate(() => window.__setCamera?.(50, 50, 8))
  await page.evaluate(() => window.__sliceSettle?.(50, 50)) // until chunk (50, 50) is on the GPU
  const prePaint = await readTilePixel(page, 50, 50)
  expectPixel(prePaint, 8, 8, GRASS, TOL)
  const seq = await page.evaluate(() => window.__dispatchPaintAt?.(50, 50))
  expect(seq).toBe(1)
  // A generous timeout, not Playwright's 5 s default: Phase 3's own comment explains why real-time
  // pacing on this page can run well below 20 Hz while it is panning, so a result can take several
  // real seconds to come back, not milliseconds.
  await expect
    .poll(() => page.evaluate(() => window.__sliceConfirmed?.() ?? 0), { timeout: 20_000 })
    .toBe(1)
  // Gate-round fix (Phase 2's own comment has the full story): `Confirmed` firing only proves the
  // *result* reached `main`'s UI-ring drain -- it says nothing about whether the *matching* upload-
  // ring record (the same `on_frame` call queues both, but they drain through two independent rAF-
  // registered pumps on `main`) has been drained into `renderer`'s own textures yet. A fixed "one
  // more `requestAnimationFrame`" wait assumes that always happens within one frame; under
  // contention it does not (this is the exact failure `node scripts/repeat.mjs browser 15 --load
  // 10` found: this line read pristine `GRASS` instead of the painted `WATER`). `__sliceSettle`
  // waits for the upload ring to actually drain instead of guessing a frame count.
  // M16d: the real event is the Paint's delta reaching the GPU -- the tile's GPU texel differs from
  // the one the pre-paint probe read. The probe re-checks it in the same turn as its draw.
  await page.evaluate((t) => window.__sliceSettle?.(50, 50, t), prePaint.texel)
  expectPixel(await readTilePixel(page, 50, 50, prePaint.texel), 8, 8, WATER, TOL)

  // Phase 6: an out-of-range Paint yields Rejected with the typed reason (`Puts::admit`'s new
  // `PAINT_BOUND` check, this cut's own Rust change -- `Reject::OutOfRange`).
  const rejSeq = await page.evaluate(() => window.__dispatchPaintAt?.(2_000_000, 2_000_000))
  expect(rejSeq).toBe(2)
  await expect
    .poll(() => page.evaluate(() => window.__sliceRejected?.() ?? 0), { timeout: 20_000 })
    .toBe(1)
  const lastReject = await page.evaluate(() => window.__sliceLastReject?.())
  expect(lastReject).toEqual({ Rejected: { Game: 'OutOfRange' } })

  // Phase 7: the HUD shows exactly the field names the device check (`docs/plan/device-checks.md`,
  // "M16: Vertical slice on the phone") reads, with the values this test itself just produced.
  const hud = await page.evaluate(() => window.__hudText?.())
  expect(hud).toContain('confirmed: 1')
  expect(hud).toContain('rejected: 1')
  expect(hud).toMatch(/ring drops: 0\b/)
  expect(hud).toMatch(/tick: \d+/)
  expect(hud).toMatch(/engine_mem_grows: /)

  expectNoGpuErrors((await page.evaluate(() => window.__errors?.())) ?? [])
})
