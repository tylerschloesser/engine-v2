// `gc-topology.html`'s script (docs/plan/06b-workers-and-spawn.md, Tests added): a real
// `createClient()` local topology (client + sim + gen0), driven the way `stepFrame` in
// `test/client.ts` already does -- camera-block write, wake, `frame`, ack -- through `asHarness`, so
// `zeroGcSuite` runs the same generated clean-plus-negative-controls suite it runs against
// `gc-loop.html`'s harness-driven page (`gc/suite.ts`). Named `gc-topology` (not `topology.html`,
// which `workers.spec.ts`/`start.spec.ts` already own for the imperative debug API: a page that
// auto-creates a client at load, as a zero-GC page must, cannot also serve those tests' own explicit
// `__createClient()` call and worker-count assertions -- Deviations).
import wasm from 'virtual:engine/wasm'
import { createClient } from '../../../../src/client.ts'
import { asHarness, parkWorkers, setCamera } from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const DEFAULT_GAME = { seed: '0x1', entities: 4 }
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  // `world` is structurally valid but otherwise inert: `test.game` (below) overrides every
  // worker's real config (docs/plan/13-sim-host-tick-loop.md, Scope "createClient local host"),
  // same as before this milestone's real `WorldConfig` type replaced the old `{ game }` stub.
  host: { kind: 'local', world: { worldId: 'w', params: { seed: '1', worldgen: DEFAULT_GAME } } },
  genWorkers: 1,
  test: { clock, game: DEFAULT_GAME, flags: { gcHook: true } },
})
await client.ready
// A production worker enters its blocking loop right after `ready` (unlike the M03/M04 harness,
// which starts idle): park every worker before `__pageReady` so CDP can reach them the moment the
// test attaches (packages/engine/CLAUDE.md, "call `parkWorkers` before any CDP call into a
// worker"). `installGcPage`'s own `run()` resumes them through the normal `yield` protocol.
const harness = asHarness(client)
await parkWorkers(client)
setCamera(client, { x: 1, y: -1, tilesAcross: 12 })

// Ticks every frame (fix round 2, docs/plan/06b-workers-and-spawn.md, Deviations): a prior
// `STEP_TICK_EVERY = 2` halved `sim`/`gen0`'s own wake count to mask a real per-pass allocation bug
// (`NO_TIMEOUT`'s `Number.POSITIVE_INFINITY` re-box, `worker/shell.ts`) rather than fix it; with
// that bug (and `frame(t_ms)`'s own box, `worker/client.ts`) fixed, every isolate's clean reading is
// far under budget at full tick rate and the mask is no longer needed.
installGcPage(harness, {
  drive() {
    harness.stepFrame(1000 / 60)
    harness.stepTick()
  },
})

window.__pageReady = true
