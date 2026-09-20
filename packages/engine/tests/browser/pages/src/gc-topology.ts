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
  host: { kind: 'local', world: { game: DEFAULT_GAME } },
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

installGcPage(harness)

window.__pageReady = true
