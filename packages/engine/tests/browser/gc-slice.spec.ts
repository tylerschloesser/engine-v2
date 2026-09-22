// `gc-slice: zero-GC window with actions` (docs/plan/16-action-round-trip.md, step 6): `gc-slice.ts`
// is `gc-connected-terrain.ts`'s own real connected+rendered+panning topology plus a periodic
// `dispatchRaw` call inside the measured window -- the first page in this repo whose `main` isolate
// carries a real, non-zero `class: "budgeted"` row (`gc-slice.ts`'s own module comment has the
// reasoning: a dispatched action's own *result* is JSON-parsed on `main`, which allocates by
// construction, 0004/0003). `expectAdapter: true` (a real WebGPU adapter, `terrain`/`connected-
// terrain`'s own precedent); `controlKinds: ['object', 'burst']` (a production worker has no spare
// `postMessage` type for a message-driven tick, `connected-terrain`'s own precedent).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'zero_gc_action',
  path: '/gc-slice.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})
