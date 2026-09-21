// `sim-worker.html`'s script (docs/plan/13-sim-host-tick-loop.md, step 5, Tests added:
// `sim_worker_steps_and_hashes`, `sim_worker_yields_for_cdp`): a real `createClient()` local
// topology over `fx-puts` (`host: { kind: 'local', world }`, no `test.game` override -- this page
// is the one thing in the browser suite that exercises `createClient`'s own real-`WorldConfig`
// conversion path end to end, `simGame`/`game` in `client.ts`), driven entirely through
// `engine/test`'s `stepTick`/`worldHash`/`simCounters` (this milestone's own new exports) instead
// of `asHarness`. `test.flags = {}` (not omitted) only to enable the parked `test-call` channel
// `worldHash`/`simCounters` need (`worker.ts`'s own `testEnabled` gate); no `gcHook`, since this
// page is not a zero-GC page (that is `gc-sim.ts`, step 6).
import { createClient } from '../../../../src/client.ts'
import type { SimHostCounters } from '../../../../src/server.ts'
import {
  parkWorkers,
  resumeWorkers,
  simCounters,
  stepTick,
  worldHash,
} from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __stepTick?: (n: number) => Promise<void>
    __worldHash?: () => Promise<string>
    __simCounters?: () => Promise<SimHostCounters>
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
  }
}

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: {
      worldId: 'sim-worker-test',
      // Decimal `1`, matching `fixtures/puts/golden/scenario.json`'s `seed: "0x1"` exactly
      // (`seedToHexU64('1') === '0x1'`) so `worldHash` after `stepTick(100)` can be compared
      // against that fixture's own blessed golden.
      params: { seed: '1', worldgen: null },
    },
  },
  genWorkers: 1,
  test: { flags: {} },
})
await client.ready

window.__stepTick = (n) => stepTick(client, n)
window.__worldHash = () => worldHash(client)
window.__simCounters = () => simCounters(client)
window.__park = () => parkWorkers(client)
window.__resume = () => resumeWorkers(client)

window.__pageReady = true
