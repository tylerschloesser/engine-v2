// Production entry (docs/plan/20b-reference-player-and-collect-ui.md step 0; hooks removed per the
// orchestrator's ruling on cut 1's flagged decision, step 3-4): thin by design, no `window.__*`
// hooks at all. Never sets `ClientOptions.test` -- `startGame` (`game.ts`) holds everything this
// file used to do itself through M20's step 3. Every diagnostic hook this package's tests need,
// including `__setCamera`/`__cameraState` (moved here from this file) and the new `__tickCamera`
// (drives real Playwright gestures through `client.camera.tick()` with no real rAF), lives on
// `test-entry.ts`/`test.html` instead.
import { startGame } from './game.js'
import { selectHost } from './mode.js'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement

// `#k=<joinKey>` in the URL: play on the server this page came from (`/ws` on its own origin);
// otherwise a world of this browser's own. The local world is `world.json` (the seed every native
// test also uses, so the landmark tiles this package's tests probe are the ones a player sees).
const { client } = await startGame({ canvas, host: selectHost(location) })
await client.ready

window.__pageReady = true
