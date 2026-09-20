// `terrain: zero-GC over a scripted pan` (docs/plan/09-renderer-terrain.md, Tests added): a real
// `createClient()` over `fx-terrain` plus a real device/renderer, driven the same way `gc-gen.ts`
// drives `fx-worldgen` -- the camera panning a little every frame so chunks are generated,
// converted, uploaded and evicted inside the measured window. `expectAdapter: true`: the first
// zero-GC page with a real WebGPU adapter (0016 §1, `gc-page.ts`'s own "a later page's script fills
// this in"). No `post-message` control: same reasoning as `gen`/`echo`/`topology` (a production
// worker has no spare `postMessage` type for a message-driven tick).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'terrain',
  path: '/gc-terrain.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})
