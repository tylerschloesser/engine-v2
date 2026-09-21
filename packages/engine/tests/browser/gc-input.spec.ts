// `input` zero-GC page (docs/plan/11-camera-and-input.md, Tests added: "Zero-GC: page id `input`
// through `zeroGcSuite` (600 frames of injected drag, pinch, wheel and WASD with a `tap` every 30
// frames; chunk streaming and the renderer active; isolates `main`, `client`, `gen0`)"). Same
// production-topology shape as `terrain.spec.ts` (real `createClient()`, real WebGPU adapter, no
// `post-message` control -- a production worker has no spare `postMessage` type for a message-driven
// tick).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'input',
  path: '/gc-input.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})
