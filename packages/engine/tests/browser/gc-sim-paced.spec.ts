// `sim-paced: zero-GC over the real onFire pacing path` (docs/plan/13b-tick-timing-allocation.md,
// Order of work 1): a real `createClient()` local topology over `fx-puts`, `simHost.start()` armed
// for real (`gc-sim-paced.ts`), so the `sim` isolate's own `AtomicsTimer` (`poll`/`timeoutMs`) is
// measured for the first time -- distinct from `gc-sim.ts`'s own deterministic `stepSimTickSync`
// coverage, kept unchanged. No `post-message` control, same reasoning as every other
// production-topology page (a production worker has no spare `postMessage` type for a
// message-driven tick).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'sim-paced',
  path: '/gc-sim-paced.html',
  controlKinds: ['object', 'burst'],
})
