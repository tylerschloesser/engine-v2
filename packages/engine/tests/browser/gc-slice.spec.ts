// `gc-slice: zero-GC window with actions` (M16, step 6): `gc-slice.ts`
// is `gc-connected-terrain.ts`'s own real connected+rendered+panning topology plus a periodic
// `dispatchRaw` call inside the measured window -- `main` allocates a real, non-zero amount for it
// (a dispatched action's own *result* is JSON-parsed on `main`, `gc-slice.ts`'s own module comment
// has the reasoning) but stays `class: "strict"`, measured, not assumed: the allocation is too
// small to cross a minor-GC threshold (Deviations). `expectAdapter: true` (a real WebGPU adapter,
// `terrain`/`connected-terrain`'s own precedent); `controlKinds: ['object', 'burst']` (a production
// worker has no spare `postMessage` type for a message-driven tick, `connected-terrain`'s own
// precedent).
import { expect } from '@playwright/test'
import { zeroGcSuite } from './gc/suite.ts'

declare global {
  interface Window {
    __predictStats?: () => Promise<{ appliedEver: number }>
  }
}

zeroGcSuite({
  pageId: 'zero_gc_action',
  path: '/gc-slice.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
  // Open gate failures item 3, gate round 1 (M26:
  // proves this page's own dispatched `Paint` was actually predicted `Applied`, not
  // `NotPredictable` -- a real counter (`ClientCore::predict_applied_ever`), not just a claim
  // resting on the fixture's shape. Read after `measure()` has already finished (never inside the
  // measured window: `__predictStats` parks the client worker itself, a `postMessage` round trip
  // 0016 §2 forbids in steady state).
  afterClean: async (page) => {
    const stats = await page.evaluate(() => window.__predictStats?.())
    expect(stats?.appliedEver ?? 0, 'gc-slice: predicted Applied at least once').toBeGreaterThan(0)
  },
})
