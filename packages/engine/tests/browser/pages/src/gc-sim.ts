// `gc-sim.html`'s script (docs/plan/13-sim-host-tick-loop.md, step 6, Tests added: "zero-GC test
// extended to the sim isolate"; docs/plan/23-persistence-opfs-and-lifecycle.md step 6, Planning
// decision 1): a real `createClient()` local topology over `fx-puts` (`host: { kind: 'local',
// world, persist: true }`), the sim isolate driven by exactly one deterministic tick per measured
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
//
// Persistence (step 6): `host.persist: true` gives this page the real OPFS-backed sim worker
// startup order (steps 3-4) instead of the in-memory-only stub, so `sim`'s own strict budget now
// covers the real `append`/`sync` calls `Persistence.afterTick` makes every tick -- unconditionally,
// whether or not a snapshot is ever forced (0016's own deferred sentence: "log `append` and `sync`
// stay in the strict window by construction"). `?forceSnapshot=1` additionally arms `forceSnapshot()`
// (`engine/test`) at a fixed local frame (300) of *every* `drive()`-driven pass, warm-up and measured
// alike (Deviations, "0028's own two-window minimum silently drops a once-per-test event"):
// `instrument.ts`'s `measure()` runs two consecutive 600-frame windows and reports the isolate's
// *lower* total (0028), so a snapshot gated to fire only in one of them (a `marked`-only trigger,
// tried first) can land in the window that gets discarded, silently excluding its own cost. Firing
// every pass instead means both measured windows carry exactly one real snapshot's worth of
// overhead, so the comparison -- and the reported number -- are meaningful.
//
// **Measured (Planning decision 1's own question): outside the strict window.** With `?forceSnapshot
// =1`, the `sim` isolate's own per-window total (the lower of the two, 0028) reads a stable 7280-7292
// bytes over 600 frames (12.13-12.15 B/frame) across repeated runs -- over the 8 B/frame strict
// budget every other page's `sim`/`gen0`/`client` isolate meets. Without `?forceSnapshot=1` (this
// page's own default, unchanged), the isolate stays comfortably under 8 (persistence's own per-tick
// bookkeeping -- `Persistence.afterTick`'s counters, `sim_dirty()` read -- costs nothing measurable
// when it never actually snapshots). `zeroGcSuite`'s own generated `sim clean` test therefore keeps
// asserting the strict, snapshot-free default (Planning decision 1: "the strict test runs without a
// snapshot"); `zero_gc_singleplayer_with_snapshot` (`gc-sim.spec.ts`) opens this page with
// `?forceSnapshot=1` instead and asserts the snapshot as a *budgeted event* against
// `budgets.json`'s new `simWorker.snapshotEventBytes`, per ADR 0039 (superseding 0016's own deferred
// sentence).
//
// `leakyStorageAppend` (`?leakyAppend=1`, `TestFlags`) is `neg_control_snapshot_allocates`'s own
// hook: a bespoke test (`gc-sim.spec.ts`), not `zeroGcSuite`'s generic per-isolate loop, drives it.
import { createClient } from '../../../../src/client.ts'
import {
  asHarness,
  forceSnapshot,
  parkWorkers,
  stepSimTickSync,
} from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const params = new URL(location.href).searchParams
const leakyAppend = params.get('leakyAppend') === '1'
const forceSnapshotArmed = params.get('forceSnapshot') === '1'

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')

// A fixed frame well inside every real 600-frame measured window (`gc/instrument.ts`'s own `FRAMES`)
// and comfortably clear of frame 1/600's own edges.
const SNAPSHOT_AT_FRAME = 300

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'gc-sim', params: { seed: '1', worldgen: null } },
    persist: true,
  },
  genWorkers: 1,
  test: { flags: { gcHook: true, ...(leakyAppend ? { leakyStorageAppend: true } : {}) } },
})
await client.ready
// A production worker enters its blocking loop right after `ready`: park before `__pageReady`
// (packages/engine/CLAUDE.md, gc-topology.ts's own precedent) so CDP can reach it the instant the
// test attaches.
const harness = asHarness(client)
await parkWorkers(client)

installGcPage(harness, {
  drive(f) {
    stepSimTickSync(client, 1)
    if (forceSnapshotArmed && f === SNAPSHOT_AT_FRAME) forceSnapshot(client)
  },
})

window.__pageReady = true
