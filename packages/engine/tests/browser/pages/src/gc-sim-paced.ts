// `gc-sim-paced.html`'s script (docs/plan/13b-tick-timing-allocation.md, Order of work 1: "add a
// zero-GC page ... that runs the real onFire pacing path" -- built as a *new* page, not by
// converting `gc-sim.ts`, per the orchestrator's own correction: `gc-sim.ts` keeps testing the
// deterministic `stepSimTickSync` path it was built for in M13; this page tests the production
// pacing path (`onFire` via `AtomicsTimer`) on its own, so neither coverage is lost).
//
// A real `createClient()` local topology over `fx-puts`, same as `gc-sim.ts`, but `test.flags.pace:
// true` (`worker/sim.ts`) arms `simHost.start()` for real: the sim worker paces itself off its own
// `AtomicsTimer`, exactly the way a real single-player session does, with `test` still present so
// `gcHook`'s negative-control hook keeps working. `drive()` is the *default* `installGcPage`
// behaviour (`stepFrame` + `harness.stepTick()`, deliberately not overridden): `asHarness.stepTick()`
// wakes the sim-kind worker generically (`test/client.ts`) without ever touching `CB_SIM_STEP_REQ`,
// so every tick this page's `sim` isolate ever runs comes from `onFire` alone -- `SimHost.stepTick`
// (the manual, deterministic core `gc-sim.ts` drives) is never called here. This isolates
// `AtomicsTimer`'s own `poll()`/`timeoutMs()` allocation from `SimHost.runOneTickTimed`'s (already
// covered by `gc-sim`), so a regression in either shows up on the page built to catch it.
import { createClient } from '../../../../src/client.ts'
import { asHarness, parkWorkers } from '../../../../src/test/client.ts'
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
    world: { worldId: 'gc-sim-paced', params: { seed: '1', worldgen: null } },
  },
  genWorkers: 1,
  test: { flags: { gcHook: true, pace: true } },
})
await client.ready
// A production worker enters its blocking loop right after `ready`: park before `__pageReady`
// (packages/engine/CLAUDE.md, gc-topology.ts's own precedent) so CDP can reach it the instant the
// test attaches.
const harness = asHarness(client)
await parkWorkers(client)

installGcPage(harness)

window.__pageReady = true
