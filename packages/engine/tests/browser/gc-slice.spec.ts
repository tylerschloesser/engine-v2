// `gc-slice: zero-GC window with actions` (docs/plan/16-action-round-trip.md, step 6): `gc-slice.ts`
// is `gc-connected-terrain.ts`'s own real connected+rendered+panning topology plus a periodic
// `dispatchRaw` call inside the measured window -- `main` allocates a real, non-zero amount for it
// (a dispatched action's own *result* is JSON-parsed on `main`, `gc-slice.ts`'s own module comment
// has the reasoning) but stays `class: "strict"`, measured, not assumed: the allocation is too
// small to cross a minor-GC threshold (Deviations). `expectAdapter: true` (a real WebGPU adapter,
// `terrain`/`connected-terrain`'s own precedent); `controlKinds: ['object', 'burst']` (a production
// worker has no spare `postMessage` type for a message-driven tick, `connected-terrain`'s own
// precedent).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'zero_gc_action',
  path: '/gc-slice.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})
