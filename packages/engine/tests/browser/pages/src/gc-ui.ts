// `gc-ui.html`'s script (docs/plan/16b-ui-observation-and-clock.md, "What the brief does not say":
// a new M04-harness zero-GC page proving the Budgets claim "unchanged `Ui` adds 0 B/frame (main
// row)"). A real, **connected** `createClient()` topology over `fx-puts` (`gc-sim.ts`'s own bare-
// canvas, no-renderer shape, but `connect: true` like `gc-connected-terrain.ts`): `on_frame` only
// ever runs from a real client net pump, which only exists once linked, and `UiObserver::maybe_run`
// only ever runs when `ClientCore::mutations()` actually moves -- a page with no connection at all
// (`gc-sim.ts`'s own topology) would never call `ClientSide::ui` even once.
//
// A **real** host tick is driven only every `TICK_EVERY_FRAMES` frames, not every frame
// (`gc-connected-terrain.ts`'s own `stepSimTickSync(client, 1)` every frame would cross `fx-puts`'s
// own once-a-simulated-second tick rule's boundary -- `Puts::tick` bumps `Global.day` every 20
// ticks, module doc comment -- many times inside a 600-frame window, which is a *different* test
// this milestone did not ask for). At `TICK_EVERY_FRAMES = 50` the whole 600-frame window drives
// only 12 real ticks, pre-tick values 0..11 -- the rule's own `cx.tick().0 % 20 == 0` guard never
// fires past the very first one (`cx.tick()` reads *before* `Sim::step` advances the counter, so
// the first-ever tick's own pre-tick is 0), and that first firing writes `PutsUi::default()`'s own
// values right back (`Global::default()` is already `day: 0, motd: 0, ...`, and no `SetNote`/
// `SetMotd` is ever dispatched here) -- so `PutsClient::ui`'s output never differs from what
// `UiObserver`'s own `previous` already holds, and `push_ui_record` never runs, for the life of
// this page. `harness.stepFrame()` still runs every frame regardless (the client worker's own
// `frame()` export, and with it `UiObserver::maybe_run`'s own "no new mutation" no-op path) --
// "ticks" (real per-frame client work) keep happening throughout, exactly what the test name
// promises, with a provably unchanging `Ui`.
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import {
  asHarness,
  parkWorkers,
  pumpUntilLive,
  stepSimTickSync,
  uiObserverStats,
} from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Coordinator gate, M16b cut 2: `no_ui_change_asserts_ui_ran_and_wrote_nothing` (`gc-ui.
     * spec.ts`) reads both the Rust-side call/record counters (`UiObserver`, via `client_ui_
     * stats`) and the TS-side drain counters (`ClientTestHandle.uiDrainStats`) through this one
     * hook, called *after* `window.__gc.run(...)` -- `run()`'s own trailing `harness.park()`
     * already leaves the client worker parked, `client_ui_stats`'s own precondition. */
    __uiTestStats?: () => Promise<{
      rustCalls: number
      rustRecords: number
      recordsSeenMain: number
      onUiFiredMain: number
    }>
  }
}

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'gc-ui', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { flags: { gcHook: true } },
})
// `pumpUntilLive` (`engine/test`'s own doc comment): this page's ticks are test-driven, well after
// this point, so a bare `await client.ready` would deadlock (docs/plan/16-action-round-trip.md).
await pumpUntilLive(client)
const harness = asHarness(client)
await parkWorkers(client)

const TICK_EVERY_FRAMES = 50
let frame = 0

installGcPage(harness, {
  drive() {
    frame += 1
    // `gc-connected-terrain.ts`/`gc-slice.ts`'s own order (`stepFrame` before `stepSimTickSync`):
    // a wake this call's own `stepSimTickSync` produces is drained by the client's net pump either
    // through the sim's own cross-thread wake or, at the latest, the *next* `drive()` call's
    // `stepFrame` -- immaterial here (Deviations), since the point is only that `Ui` never changes
    // across the whole window, not exactly which frame a given tick's `on_frame` lands on.
    harness.stepFrame(1000 / 60)
    if (frame % TICK_EVERY_FRAMES === 0) {
      stepSimTickSync(client, 1)
    }
  },
})

window.__uiTestStats = async () => {
  const rust = await uiObserverStats(client)
  const ts = clientTestHandle(client).uiDrainStats()
  return {
    rustCalls: rust.calls,
    rustRecords: rust.records,
    recordsSeenMain: ts.recordsSeen,
    onUiFiredMain: ts.onUi,
  }
}

window.__pageReady = true
