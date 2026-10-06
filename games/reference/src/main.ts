// Production entry (docs/plan/20b-reference-player-and-collect-ui.md step 0; hooks removed per the
// orchestrator's ruling on cut 1's flagged decision, step 3-4): thin by design, no `window.__*`
// hooks at all. Never sets `ClientOptions.test` -- `startGame` (`game.ts`) holds everything this
// file used to do itself through M20's step 3. Every diagnostic hook this package's tests need,
// including `__setCamera`/`__cameraState` (moved here from this file) and the new `__tickCamera`
// (drives real Playwright gestures through `client.camera.tick()` with no real rAF), lives on
// `test-entry.ts`/`test.html` instead.
import { attachHostLifecycle, checkSupport } from 'engine'
import { showStartFailure, startGame } from './game.js'
import { selectHost } from './mode.js'
import { showCapabilityScreen } from './ui/capability.js'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement

// Capability screen (M35): checked first, before any WebGPU or worker is touched. A browser that fails
// gets the reasons on screen instead of a blank canvas; warnings (`no-opfs`, `no-web-locks`) only
// mean less (a world that is not durable) and do not stop the game.
const support = await checkSupport()
if (!support.ok) {
  showCapabilityScreen(document.body, support.failures)
} else {
  // `#k=<joinKey>` in the URL: play on the server this page came from (`/ws` on its own origin);
  // otherwise a world of this browser's own. The local world is `world.json` (the seed every native
  // test also uses, so the landmark tiles this package's tests probe are the ones a player sees).
  // `?bench=large-save` (M36): in a bench build only (`vite build --mode bench`); `__BENCH__` is a
  // build-time false everywhere else, so the branch and `bench.ts` are not in the bundle at all.
  const benchModule = __BENCH__ ? await import('./bench.js') : undefined
  const bench = benchModule?.benchRequest(location.search)
  const meter = bench ? benchModule?.createBenchMeter() : undefined
  // The check module is loaded *before* the game starts and subscribes inside `startGame` (`onClient`): the
  // client's link and Ui events do not replay, and the game's first awaits (GPU init) outlast `online` on a
  // cold first load (M39n fix round 2).
  const checkModule = __BENCH__ ? await import('./check.js') : undefined
  const onClient = checkModule ? { onClient: checkModule.watchClient } : {}
  const game = await startGame(
    bench && meter && benchModule
      ? {
          canvas,
          host: benchModule.benchHost(bench.scale),
          scheduler: meter.scheduler,
          test: benchModule.BENCH_TEST_OPTIONS,
          ...onClient,
        }
      : { canvas, host: selectHost(location, undefined, { persist: true }), ...onClient },
  )
  const { client } = game
  const benchApi = bench && meter ? meter.start(game, bench) : undefined
  // The check build (M39f): the bench build also carries `window.__check` (`src/check.ts`, never in a
  // release build: `__BENCH__` is a build-time false there, and the module is not in the bundle at all).
  checkModule?.installCheck(game, benchApi)
  try {
    await client.ready
    attachHostLifecycle(client) // snapshot and flush when the tab is hidden (M23)
  } catch (e) {
    // A second tab on this world, or a save this build cannot read: a screen, not a crash.
    if (!showStartFailure(game, e)) throw e
  }
}

window.__pageReady = true
