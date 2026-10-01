// `soak-browser @slow` (docs/plan/36-slow-tier-and-benchmarks.md step 7): the reference game's
// single-player zero-GC page (`gc-single-player.html`, M34b: the state of the script's middle, then
// the camera panning and a collect or a deposit dispatched every 100 frames, every frame one stepped
// tick) measured over 12,000 frames in each of 0028's two windows instead of 600, so the M04 assertion
// (no GC on a strict isolate, the per-frame allocation budget `gc.pages.reference_single_player`) runs
// over 24,000 stepped ticks of play. `memory.buffer.byteLength` of every WASM instance is unchanged
// across both windows and `engine_mem_grows` is 0.
//
// M34b's own script cannot loop as written (a landmark tile holds ten units, `expectUi` pins absolute
// inventories), so the window loops the page's own verbs, which are that script's collect and deposit
// steps (`gc-single-player-entry.ts`): the repeatable part, with the same budget and no new one.
import { expect, test } from '@playwright/test'
import { measure } from './gc/instrument.ts'
import { openPage } from './support/page.ts'

const FRAMES = 12_000
const PAGE_ID = 'reference_single_player'

test('soak-browser @slow', async ({ page, browser }, testInfo) => {
  test.setTimeout(900_000)
  await openPage(page, '/gc-single-player.html')
  const r = await measure(page, browser, { pageId: PAGE_ID, frames: FRAMES })

  testInfo.annotations.push({ type: 'adapter.info', description: JSON.stringify(r.adapter) })
  expect(r.adapter, 'WebGPU adapter').not.toBeNull()
  expect(r.errors, 'errors').toEqual([])
  expect(r.frames, 'frames per measured window').toBe(FRAMES)
  // 0016 §1 last row: every WASM instance's memory is unchanged across both windows, and none grew.
  for (const name of r.isolates) {
    if (name === 'main') continue
    expect(r.memoryBytes.after[name], `${name} memory.buffer.byteLength`).toBe(
      r.memoryBytes.before[name],
    )
    expect(r.memGrows[name], `${name} engine_mem_grows`).toBe(0)
  }
  for (const name of r.isolates) {
    expect(r.presentIsolates, `${name} thread present in the trace`).toContain(name)
  }
  console.log(
    `soak-browser: ${FRAMES} frames x 2 windows, bytesPerFrame ${JSON.stringify(r.bytesPerFrame)}, gc ${JSON.stringify(r.gc)}, memory ${JSON.stringify(r.memoryBytes.after)}`,
  )
  // The M04 assertions, per isolate. Assertion B (bytes per frame against the page's budget) holds for
  // every isolate over the whole window. Assertion A (no GC event) holds for the workers: they must
  // not collect once in 24,000 frames. `main` is budgeted at 234 B a frame (the dispatches, the
  // overlay write, `draw`): 12,000 frames of that is 2.8 MB per window, more than V8's young generation
  // holds, so a scavenge (and, when the machine is busy, now and then a mark-compact) in a window is
  // the budget itself, not a leak; B bounds it, and A is not asserted for `main` here.
  const verdict = r.verdict as {
    pass: boolean
    A: Record<string, boolean>
    B: Record<string, boolean>
  }
  const detail = JSON.stringify({ bytesPerFrame: r.bytesPerFrame, gc: r.gc, verdict }, null, 2)
  for (const name of r.isolates) {
    expect(verdict.B[name], `${name}: bytes per frame within budget\n${detail}`).toBe(true)
    if (name !== 'main') {
      expect(verdict.A[name], `${name}: no GC event in the window\n${detail}`).toBe(true)
    }
  }
})
