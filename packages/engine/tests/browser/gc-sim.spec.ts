// `sim: zero-GC over real ticking` (docs/plan/13-sim-host-tick-loop.md, step 6, Tests added: "zero-
// GC test extended to the sim isolate"): a real `createClient()` local topology over `fx-puts`, the
// sim isolate driven by one deterministic `sim_tick` per measured frame (`gc-sim.ts`). No `post-
// message` control, same reasoning as `topology`/`echo`/`gen` (orchestrator decision 2 of 06b): a
// production worker has no spare `postMessage` type for a message-driven tick.
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'sim',
  path: '/gc-sim.html',
  controlKinds: ['object', 'burst'],
})
