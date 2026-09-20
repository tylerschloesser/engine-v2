// `topology`: a real `createClient()` local topology (client + sim + gen0), driven by
// `test/client.ts`'s `stepFrame` lockstep through `asHarness` (docs/plan/06b-workers-and-spawn.md,
// Tests added). No `post-message` control: a production worker has no spare `postMessage` type for
// a message-driven tick (orchestrator decision 2).
import { zeroGcSuite } from './gc/suite.ts'

// `warmupFrames`: the production `yield`-protocol shell's deeper call chain needs more than
// `gc-loop`'s 120 to reach steady optimized code (docs/plan/06b-workers-and-spawn.md, Deviations).
zeroGcSuite({
  pageId: 'topology',
  path: '/gc-topology.html',
  controlKinds: ['object', 'burst'],
  warmupFrames: 8000,
})
