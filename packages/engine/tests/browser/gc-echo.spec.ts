// `echo`: 10 KiB per frame, main -> `actionRing` -> client `Rx` -> `Tx` -> `uiRing` -> main, through
// a real `createClient()` local topology (docs/plan/06b-workers-and-spawn.md, Tests added). No
// `post-message` control (orchestrator decision 2, same reasoning as `gc-topology.spec.ts`).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'echo',
  path: '/gc-echo.html',
  controlKinds: ['object', 'burst'],
})
