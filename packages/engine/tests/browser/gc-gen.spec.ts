// `gen: zero-GC over a scripted pan` (docs/plan/08b-gen-workers-and-queue.md, Tests added): a real
// `createClient()` over `fx-worldgen` (`host: { kind: 'remote', ... }`, no `Sim` role), the camera
// panning a little every frame so the generation queue keeps finding fresh work across gen and
// client isolates for the whole measured window. No `post-message` control, same reasoning as
// `topology`/`echo` (orchestrator decision 2 of 06b): a production worker has no spare `postMessage`
// type for a message-driven tick.
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'gen',
  path: '/gc-gen.html',
  controlKinds: ['object', 'burst'],
})
