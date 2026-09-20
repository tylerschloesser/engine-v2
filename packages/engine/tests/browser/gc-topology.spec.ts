// `topology`: a real `createClient()` local topology (client + sim + gen0), driven by
// `test/client.ts`'s `stepFrame` lockstep through `asHarness` (docs/plan/06b-workers-and-spawn.md,
// Tests added). No `post-message` control: a production worker has no spare `postMessage` type for
// a message-driven tick (orchestrator decision 2).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'topology',
  path: '/gc-topology.html',
  controlKinds: ['object', 'burst'],
})
