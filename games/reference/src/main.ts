// Production entry (docs/plan/20b-reference-player-and-collect-ui.md step 0): thin by design.
// Never sets `ClientOptions.test` -- `startGame` (`game.ts`) holds everything this file used to do
// itself through M20's step 3. `__probeTile`/`__dispatchStartCollect` (the two hooks the step-0
// delegation prompt names explicitly) have moved to `test-entry.ts`/`test.html`, which the
// `reference` Playwright preview also serves.
//
// **Deviation, flagged for the orchestrator (see this brief's Deviations):** `__setCamera`/
// `__cameraState` are *not* moved here. `camera.spec.ts`'s `reference_pan_and_zoom_work`
// (M20's own test) drives this page with real Playwright mouse/wheel gestures against the
// production canvas and reads `__cameraState` back; moving it to the stepped test entry would mean
// either real gestures against a page whose render loop is driven by a manual, unfired clock (the
// gesture's own `camera.tick()` integration would never run), or rewriting the test to use
// `engine/test.injectPointer`/`injectWheel` instead of real DOM events -- a change to an existing,
// passing test beyond the one this step names (`reference_depletion_visible`). Left in place
// pending that decision; this is the one place the page does not yet meet the "no window.__*
// hooks" wording literally.
import { startGame } from './game.js'

declare global {
  interface Window {
    __pageReady?: true
    __setCamera?: (x: number, y: number, tilesAcross: number) => Promise<void>
    __cameraState?: () => { x: number; y: number; tilesAcross: number }
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement

const { client } = await startGame({
  canvas,
  host: {
    kind: 'local',
    // `6840143426475589698` = `0x5EED_1234_ABCD_0042` = `sim/tests/common/mod.rs::TEST_SEED`:
    // the real page uses the same seed every native test does, so the landmark tiles this
    // package's tests probe are the same ones a player actually sees.
    world: { worldId: 'reference', params: { seed: '6840143426475589698', worldgen: {} } },
    connect: true,
  },
})
await client.ready

// `async` only to match `test-entry.ts`'s own declaration (the two `declare global` blocks are
// compiled together and must agree exactly); this page has no worker-parking state to resume.
window.__setCamera = async (x, y, tilesAcross) => {
  client.cameraState.centreX = x
  client.cameraState.centreY = y
  client.cameraState.tilesAcross = tilesAcross
}
window.__cameraState = () => ({
  x: client.cameraState.centreX,
  y: client.cameraState.centreY,
  tilesAcross: client.cameraState.tilesAcross,
})

window.__pageReady = true
