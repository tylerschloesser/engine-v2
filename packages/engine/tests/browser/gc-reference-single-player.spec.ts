// `reference_single_player` (docs/plan/34b-reference-scripted-single-player.md, "Zero GC through the
// game"): `games/reference`'s single-player topology in the state of the script's middle (furnace
// placed and stocked), the camera panning and a collect or deposit dispatched every 100 frames
// (`gc-single-player.html`). Lives here for the same reason as `gc-reference.spec.ts`: `zeroGcSuite`
// is an import `games/reference/tests/` may not make. No `post-message` control (production workers).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'reference_single_player',
  path: '/gc-single-player.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
  extraSettleFrames: 500,
})
