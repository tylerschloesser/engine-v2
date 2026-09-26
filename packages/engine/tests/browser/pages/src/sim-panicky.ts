// `sim-panicky.html`'s script (docs/plan/24-recovery-and-migration.md, Tests added:
// `sim_worker_recovers_from_panic`): a real `createClient()` single-player topology over
// `fx-panicky`, persisted (`host.persist`, memory storage via `test.flags.noOpfs` -- OPFS itself is
// `world.spec.ts`'s own territory, not this milestone's), real-time paced (`test.flags.pace`, this
// page's own driver -- `world.ts`'s precedent for `parkWorkers`/`callParked`/`resumeWorkers` around
// a paced sim worker). `__trapSim` calls `sim_test_trap` (`engine/test`'s "M24 test trap hook",
// reached here through the parked `test-call` channel by name, `worldHash`'s own precedent) while
// parked, then resumes -- the sim worker's own `body()` discovers the dead instance on its very next
// real wake and recovers through `SimHost.recover()` (`worker/sim.ts`), entirely off this page's own
// script. No client-role connection (`host.connect` omitted): this test is about the sim role's own
// recovery, not the wire.
import type { Client, ClientOptions } from '../../../../src/client.ts'
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { CB_SIM_TICKS_RUN, W_MEM_GROWS, workerWord } from '../../../../src/sab/control.ts'
import {
  callParked,
  parkWorkers,
  worldHash as readWorldHash,
  resumeWorkers,
  simCounters,
} from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __simTicksRun?: () => number
    __trapSim?: () => Promise<number>
    __worldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __memGrows?: () => number
    __exportWorld?: () => Promise<number[]>
    __errors?: () => string[]
  }
}

const worldId = new URL(location.href).searchParams.get('world') ?? 'panicky-recover'
const wasm = await fixtureWasm('panicky')
const canvas = document.createElement('canvas')

const clientOptions: ClientOptions = {
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId, params: { seed: '1', worldgen: null } },
    persist: true,
  },
  // `pace: true`: real-time sim pacing (`worker/sim.ts`'s own `!message.test || test.pace === true`
  // gate), the same `world.ts` combination this page's own `parkWorkers`/`callParked`/
  // `resumeWorkers` sequence mirrors. `noOpfs: true`: memory storage (this test's own recovery
  // machinery is storage-adapter-agnostic; OPFS itself is `world.spec.ts`'s territory).
  test: { flags: { pace: true, noOpfs: true } },
}

const client: Client = createClient(clientOptions)
await client.ready

window.__simTicksRun = () => Atomics.load(clientTestHandle(client).control.words, CB_SIM_TICKS_RUN)

/** Parks the sim worker, reads the tick count while parked (pacing cannot advance it further until
 * genuinely resumed -- the correct, race-free baseline a caller polls `__simTicksRun()` against,
 * unlike one read moments earlier through a separate round trip, which real-time pacing could have
 * already carried past by the time this function actually gets around to parking), calls
 * `sim_test_trap` (always traps -- the resulting rejection is expected and swallowed here), then
 * resumes. Returns that baseline tick. */
window.__trapSim = async () => {
  await parkWorkers(client)
  const counters = await simCounters(client)
  try {
    await callParked(client, 'sim', 'sim_test_trap')
  } catch {
    // Expected: `sim_test_trap` always traps (`engine/test.trapSim`'s own doc comment).
  }
  await resumeWorkers(client)
  return counters.ticksRun
}

// Reads hash and tick together, in the same park/resume window (`world.ts`'s own
// `readHashAndTick` precedent): pacing keeps advancing the tick counter between two separate
// parked round trips, so a caller comparing this hash against an independent replay needs the
// *paired* tick this hash was actually read at, not a tick read moments later.
window.__worldHashAndTick = async () => {
  await parkWorkers(client)
  const hash = await readWorldHash(client)
  const counters = await simCounters(client)
  await resumeWorkers(client)
  return { hash, tick: counters.ticksRun }
}

function simWorkerIndex(): number {
  const entry = clientTestHandle(client).workers.find((w) => w.kind === 'sim')
  if (!entry) throw new Error('sim-panicky: no sim-kind worker was spawned')
  return entry.index
}

// `memGrows() === 0` on the new instance (Tests added): a bare `Atomics.load` of `W_MEM_GROWS`,
// same "no message needed" convention `asHarness`'s own `memGrows` doc comment gives.
window.__memGrows = () =>
  Atomics.load(clientTestHandle(client).control.words, workerWord(simWorkerIndex(), W_MEM_GROWS))

window.__exportWorld = async () => {
  const blob = await client.exportWorld()
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}

window.__errors = () => []
window.__pageReady = true
