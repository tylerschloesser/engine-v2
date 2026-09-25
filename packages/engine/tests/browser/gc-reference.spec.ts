// `reference: zero-GC over a scripted pan with two collect buttons mounted` (docs/plan/
// 20b-reference-player-and-collect-ui.md, zero-allocation exit criterion): a real `games/reference`
// production topology (`gc.html`/`gc-entry.ts`, that package's own `startGame` wiring, driven by
// `engine/test.asHarness` instead of a real frame loop), oscillating the camera a little every frame
// near two isolated wood tiles (`collect-flow.spec.ts`'s own `reference_several_buttons` scan) so
// both collect buttons stay mounted the whole run. Lives here, not under `games/reference/tests/`
// (`games/reference/CLAUDE.md`'s own "never import `packages/engine/tests/**`" rule): `zeroGcSuite`
// is exactly such an import, and the `gc-reference` project (`playwright.config.ts`) points its
// `baseURL` at that package's own preview server instead of moving the mechanism.
//
// No `post-message` control: a production worker has no spare `postMessage` type for a message-
// driven tick (`topology`/`terrain`/`gen`/`echo`'s own precedent, same reasoning).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'reference',
  path: '/gc.html',
  expectAdapter: true,
  controlKinds: ['object', 'burst'],
})
