// `connected-paced.html`'s script (docs/plan/15b-ring-connection-and-replica-rendering.md,
// Orchestrator ruling 3): `connected.html`'s own topology (fx-puts, `host.connect: true`), but
// `test.flags.pace = true` arms the sim worker's real-time pacing (`simHost.start()` via `onFire`/
// `AtomicsTimer`, `worker/sim.ts`) instead of driving every tick through `CB_SIM_STEP_REQ` -- the
// one page in this milestone where a *genuine* external wake (a linked client's own uplink push,
// `worker/client-net.ts`) races the sim worker's own real timer, which is exactly the scenario ADR
// 0030's `poll()` fix (steps 1-3, landed inert; this milestone's own step 4 made it live) exists
// for: `connected-paced.spec.ts`'s `poll_skips_a_spurious_tick_on_a_ring_wake` fails if that fix is
// ever reverted. No manual clock here (unlike `connected.ts`): `client_poll_uplink`'s own 50 ms
// rate limit (0010 "Rates") should pace against *real* elapsed time, the same clock the sim's own
// real-time pacing paces against, so the two interleave the way a real single-player session's
// would.
//
// `__simCounters` is called twice by the spec (docs/plan/15e-paced-tick-measurement.md), once
// before `__pokeFor` and once after: `SimHostCounters.ticksRun` is cumulative from
// `simHost.start()` (called at the end of `worker/sim.ts`'s own `setup()`), not reset per call, so
// the spec asserts on the *delta* between the two readings -- the ticks that ran during the poke
// window -- rather than the lifetime total, which would also count every tick the sim ran while
// the page was merely loading and instantiating WASM (slope: ~1 tick per 50 ms of that idle time,
// the 20 Hz pacing rate, measured before this comment was written).
import { createClient } from '../../../../src/client.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import type { SimHostCounters } from '../../../../src/server.ts'
import {
  parkWorkers,
  resumeWorkers,
  setCamera,
  simCounters,
  stepFrame,
} from '../../../../src/test/client.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Calls `stepFrame` with a slightly different camera position every `intervalMs`, for `ms`
     * real milliseconds -- forcing a fresh camera report (and hence a real uplink push, and hence
     * a real external wake of the sim worker) roughly once per `intervalMs`, independent of and
     * interleaved with the sim worker's own real ~50 ms tick timer. */
    __pokeFor?: (ms: number, intervalMs: number) => Promise<void>
    __simCounters?: () => Promise<SimHostCounters>
  }
}

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'connected-paced-test', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { flags: { pace: true } },
})
await client.ready

// Same reasoning as `connected.ts`: this page draws nothing, so nothing else ever drains
// `uploadRing` -- kept empty so it never grows across a run that (unlike `connected.ts`) lasts
// real wall-clock seconds.
const uploadDiscard = new RingConsumer(client.uploadRing)
const uploadDiscardBuf = new Uint8Array(4112)
setInterval(() => {
  for (;;) {
    if (uploadDiscard.popInto(uploadDiscardBuf, 0) < 0) break
  }
}, 16)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

window.__pokeFor = async (ms, intervalMs) => {
  const start = performance.now()
  let n = 0
  while (performance.now() - start < ms) {
    n += 1
    setCamera(client, { x: n, y: 0, tilesAcross: 32 })
    stepFrame(client, 16)
    await sleep(intervalMs)
  }
}
// `simCounters` reaches the sim worker through the parked-only `test-call` channel
// (`callParked`): real-time pacing means it is never parked on its own, unlike `connected.ts`'s
// deterministic `stepTick`-driven page -- so every reading has to park first, and (unlike
// `connected.ts`, which is done once its own single read completes) `resumeWorkers` afterward,
// since the spec takes a before-poke reading and pacing has to keep running between it and the
// after-poke one for the delta between them to mean anything. `resumeWorkers` re-enters
// `runBlockingLoop`, whose entry `body()` pass runs with the wake word unchanged from the park and
// therefore fires exactly one `poll()` -- one extra tick, folded into whichever window follows the
// resume that caused it (the before-poke reading's resume lands inside the poke window; the
// after-poke reading's resume lands after the window the spec measures and so never counts). Well
// inside the `0.5`/`1.35` margin either way.
window.__simCounters = async () => {
  await parkWorkers(client)
  const counters = await simCounters(client)
  await resumeWorkers(client)
  return counters
}

window.__pageReady = true
