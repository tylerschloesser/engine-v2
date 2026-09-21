// `gc-sim.html`'s script (docs/plan/13-sim-host-tick-loop.md, step 6, Tests added: "zero-GC test
// extended to the sim isolate"): a real `createClient()` local topology over `fx-puts` (`host: {
// kind: 'local', world }`), the sim isolate driven by exactly one deterministic tick per measured
// frame through `stepSimTickSync` (bypassing real-time pacing entirely, same as `stepTick`'s own
// synchronous core -- `test/client.ts`) instead of `asHarness`'s generic `stepFrame`/`stepTick`
// default (which never touches `CB_SIM_STEP_REQ` and so would never actually tick `sim`: real-time
// pacing itself never arms in test mode, `worker/sim.ts`'s own `!message.test` gate). No `client`/
// `gen` work is driven here (no camera, no view): this page's whole point is the sim isolate's own
// allocation under real ticking, not a scripted pan. `client`/`gen0` are spawned (`createClient`'s
// topology always does) but deliberately not in `budgets.json`'s own `isolates` for this page,
// matching `gen`'s own `net`-not-budgeted precedent (Deviations there): a `drive()` that never
// wakes them gives their own negative control nothing to fire on, and `zeroGcSuite` only generates
// per-isolate assertions for names `budgets.isolates` lists.
import { createClient } from '../../../../src/client.ts'
import { asHarness, parkWorkers, stepSimTickSync } from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'gc-sim', params: { seed: '1', worldgen: null } },
  },
  genWorkers: 1,
  test: { flags: { gcHook: true } },
})
await client.ready
// A production worker enters its blocking loop right after `ready`: park before `__pageReady`
// (packages/engine/CLAUDE.md, gc-topology.ts's own precedent) so CDP can reach it the instant the
// test attaches.
const harness = asHarness(client)
await parkWorkers(client)

installGcPage(harness, {
  drive() {
    stepSimTickSync(client, 1)
  },
})

window.__pageReady = true
