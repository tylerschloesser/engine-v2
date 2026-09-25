// Production entry (docs/plan/20b-reference-player-and-collect-ui.md step 0; hooks removed per the
// orchestrator's ruling on cut 1's flagged decision, step 3-4): thin by design, no `window.__*`
// hooks at all. Never sets `ClientOptions.test` -- `startGame` (`game.ts`) holds everything this
// file used to do itself through M20's step 3. Every diagnostic hook this package's tests need,
// including `__setCamera`/`__cameraState` (moved here from this file) and the new `__tickCamera`
// (drives real Playwright gestures through `client.camera.tick()` with no real rAF), lives on
// `test-entry.ts`/`test.html` instead.
import { startGame } from './game.js'

declare global {
  interface Window {
    __pageReady?: true
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

window.__pageReady = true
