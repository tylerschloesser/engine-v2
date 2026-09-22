// `zeroGcSuite({ pageId, path, expectAdapter? })` (docs/plan/04-zero-gc-harness.md, Seams):
// generates the clean test and every permanent negative control from a page's `budgets.json` entry
// alone, so "registering a zero-GC test later = a page that calls `installGcPage`, a `gc.pages.
// <pageId>` entry, and a spec file calling `zeroGcSuite`" (M09, M13, M16, M18, M29).
import { type Browser, expect, type Page, test } from '@playwright/test'
import type { NegativeControl } from '../../../src/test/controls.ts'
import { gcPage, type IsolateBudget } from '../../support/budgets.ts'
import { openPage } from '../support/page.ts'
import { type GcResult, measure } from './instrument.ts'

type ControlVerdict = { A: Record<string, boolean>; B: Record<string, boolean> }

/** The verdict table of 0016 §3.8: a clean run passes everywhere; every negative control fails only
 * the named isolate(s)/assertion(s) and nowhere else. `classes` (`gc.pages.<id>.isolates.*.class`)
 * matters for `burst` on a `"budgeted"` isolate: `analyse.ts`'s own assertion A is `MajorGC === 0`
 * there, not `MinorGC + MajorGC === 0` (`"strict"`'s stronger check) -- a `burst` control's own
 * fixed per-frame garbage (`allocateBurst`) reliably forces a minor GC but not necessarily a major
 * one, so assertion A can stay `true` on a budgeted isolate even while it trips hard on assertion B
 * (`gc-slice.ts`'s own `zero_gc_action neg burst main`, the first page to exercise this: `B.main`
 * measured ~40,000 B/frame against a 115 B budget, `A.main` genuinely `true`, 0 `MajorGC` events).
 * `"strict"` (every isolate before this milestone) is unchanged: `burst` still flips both. */
function expectedVerdict(
  isolates: string[],
  control: NegativeControl,
  classes: Record<string, IsolateBudget['class']>,
): ControlVerdict {
  const A: Record<string, boolean> = {}
  const B: Record<string, boolean> = {}
  for (const name of isolates) {
    A[name] = true
    B[name] = true
  }
  if (control?.kind === 'object') {
    B[control.isolate] = false
  } else if (control?.kind === 'burst') {
    if (classes[control.isolate] === 'strict') A[control.isolate] = false
    B[control.isolate] = false
  } else if (control?.kind === 'post-message') {
    // A message per frame allocates on both ends (0016 §3 step 8; the spike's own numbers).
    B.main = false
    B[control.isolate] = false
  }
  return { A, B }
}

/** What a failing test prints: budgets, exact bytes, GC counts, top allocation sites per isolate
 * (0016 §3 step 7). */
function detail(r: GcResult): string {
  return JSON.stringify(
    {
      control: r.control,
      mode: r.mode,
      bytesPerFrame: r.bytesPerFrame,
      attributedBytesPerFrame: r.attributedBytesPerFrame,
      gc: r.gc,
      byFn: r.byFn,
      // 0028: both measured windows' own totals, so the discarded one is visible next to the
      // verdict and the lower-of-two is never a silent subtraction.
      windowBytes: r.windowBytes,
      // `byFn`'s sites are the chosen (lower) window's alone: a collateral allocation on a
      // *sibling* isolate while a burst control fires elsewhere (gc-parity round 2, 2026-09-21:
      // `sim neg burst main`/`sim neg burst sim` on CI, `sim`/`main` each tripping the other's
      // strict budget) needs both windows' own sites side by side to name, the same reason
      // `gc-loop`'s flat-transport parity test carries this field (`instrument.ts`'s own doc
      // comment on `windowByFn`).
      windowByFn: r.windowByFn,
      verdict: r.verdict,
    },
    null,
    2,
  )
}

function assertEnvironment(r: GcResult, path: string, opts: { expectAdapter?: boolean }): void {
  expect(r.crossOriginIsolated, `${path}: crossOriginIsolated`).toBe(true)
  if (opts.expectAdapter) {
    // docs/plan/10-ci-workflow.md, Scope ("adapter class recorded by every GPU test") and
    // orchestrator's decision 4: mirrors `tests/browser/support/gpu.ts`'s `expectAdapter` so a
    // `zeroGcSuite`-generated GPU test's adapter also reaches `scripts/lib/report.mjs`'s
    // `adapters` (the runner's quiet-by-default log), not just `terrain-readback.spec.ts`'s
    // hand-written tests.
    test.info().annotations.push({ type: 'adapter.info', description: JSON.stringify(r.adapter) })
    expect(r.adapter, `${path}: WebGPU adapter`).not.toBeNull()
  }
  expect(r.errors, `${path}: errors`).toEqual([])
  // 0016 §1 last row: every WASM instance's memory is unchanged across the window.
  for (const name of r.isolates) {
    if (name === 'main') continue
    expect(r.memoryBytes.after[name], `${path}: ${name} memoryBytes`).toBe(
      r.memoryBytes.before[name],
    )
    expect(r.memGrows[name], `${path}: ${name} memGrows`).toBe(0)
  }
}

async function run(
  page: Page,
  browser: Browser,
  pageId: string,
  path: string,
  control: NegativeControl,
  extraSettleFrames?: number,
): Promise<GcResult> {
  await openPage(page, path)
  const r = await measure(page, browser, {
    pageId,
    control,
    ...(extraSettleFrames !== undefined ? { extraSettleFrames } : {}),
  })
  // `Tracing.start` stall (0016 caveat a): a warning annotation, never a failure. The `playwright`
  // adapter (scripts/lib/adapters.mjs) turns this into `report.mjs`'s `warn` line under the suite.
  for (const description of r.warnings)
    test.info().annotations.push({ type: 'warning', description })
  return r
}

/** Every negative-control kind `zeroGcSuite` knows how to generate. */
const ALL_CONTROL_KINDS = ['object', 'burst', 'post-message'] as const
type ControlKind = (typeof ALL_CONTROL_KINDS)[number]

export function zeroGcSuite(opts: {
  pageId: string
  path: string
  expectAdapter?: boolean
  /** Which negative-control kinds to generate; default every kind (`gc-loop`'s own shape).
   * `object`/`burst` are generated per isolate, `post-message` per worker isolate only.
   * docs/plan/06b-workers-and-spawn.md, orchestrator decision 2: a production-topology page (no
   * spare `postMessage` type to drive a message-round-trip tick) passes `['object', 'burst']`. */
  controlKinds?: readonly ControlKind[]
  /** Forwarded to `measure()`'s own `extraSettleFrames` (see its doc comment): `terrain`'s own gate
   * fix round 2, docs/plan/09-renderer-terrain.md Deviations. Default 0, every other page
   * unaffected. */
  extraSettleFrames?: number
}): void {
  const budgets = gcPage(opts.pageId)
  const isolates = Object.keys(budgets.isolates)
  const isolateClasses: Record<string, IsolateBudget['class']> = {}
  for (const [name, budget] of Object.entries(budgets.isolates)) isolateClasses[name] = budget.class
  const workers = isolates.filter((name) => name !== 'main')
  const controlKinds = opts.controlKinds ?? ALL_CONTROL_KINDS

  test(`${opts.pageId} clean`, async ({ page, browser }) => {
    const r = await run(page, browser, opts.pageId, opts.path, null, opts.extraSettleFrames)
    assertEnvironment(r, opts.path, opts)
    // Gate round 3 (docs/plan/09-renderer-terrain.md, Deviations): with `burst` demoted to `@slow`
    // for every page but `gc-loop`, this is what proves, in the fast tier, that instrument A's own
    // thread discovery (`analyse.ts`'s `presentIsolates`) actually found every expected isolate's
    // thread in the trace -- not just that it saw zero GC events there, which a mark dropped by a
    // `Tracing.start` capture race (0016 caveat a) would also read as. Fails by isolate name, one
    // assertion per isolate, if a thread is missing.
    for (const name of isolates) {
      expect(r.presentIsolates, `${opts.path}: ${name} thread present in trace`).toContain(name)
    }
    const expected = expectedVerdict(isolates, null, isolateClasses)
    expect(r.verdict, detail(r)).toEqual({ pass: true, ...expected })
  })

  if (controlKinds.includes('object') || controlKinds.includes('burst')) {
    for (const name of isolates) {
      for (const kind of ['object', 'burst'] as const) {
        if (!controlKinds.includes(kind)) continue
        // `zeroGcSuite` tags by page id, not by a caller option a future page could forget (gate
        // round 3, orchestrator decision 3): every page's `burst` negatives move to `@slow` except
        // `gc-loop`'s own, which stays fast so both instruments are proven live on every `pnpm
        // test` (0016 §8's "permanent negative controls", amended by 0026). `object` stays fast for
        // every page (instrument B, every isolate).
        const slow = kind === 'burst' && opts.pageId !== 'gc-loop'
        const title = `${opts.pageId} neg ${kind} ${name}${slow ? ' @slow' : ''}`
        test(title, async ({ page, browser }) => {
          const control: NegativeControl = { isolate: name, kind }
          const r = await run(
            page,
            browser,
            opts.pageId,
            opts.path,
            control,
            opts.extraSettleFrames,
          )
          assertEnvironment(r, opts.path, opts)
          const expected = expectedVerdict(isolates, control, isolateClasses)
          expect(r.verdict, detail(r)).toEqual({ pass: false, ...expected })
        })
      }
    }
  }

  if (controlKinds.includes('post-message')) {
    for (const name of workers) {
      test(`${opts.pageId} neg post-message main<->${name}`, async ({ page, browser }) => {
        const control: NegativeControl = { isolate: name, kind: 'post-message' }
        const r = await run(page, browser, opts.pageId, opts.path, control, opts.extraSettleFrames)
        assertEnvironment(r, opts.path, opts)
        const expected = expectedVerdict(isolates, control, isolateClasses)
        expect(r.verdict, detail(r)).toEqual({ pass: false, ...expected })
      })
    }
  }
}
