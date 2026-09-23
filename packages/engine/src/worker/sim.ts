// `sim`-kind worker body (docs/plan/13-sim-host-tick-loop.md, Order of work 4): a real `SimHost`
// (`server.ts`) over the instantiated `role=sim` instance, paced by `AtomicsTimer` on top of
// `runBlockingLoop`'s own `timeoutMs` (0015 §2's "sim worker" row) -- the worker blocks in
// `Atomics.wait` between ticks instead of spinning, and M06b's park/resume keeps working unchanged
// (`timeoutMs` is still an ordinary function).
//
// Real-time pacing (`simHost.start()`) is armed only for a production topology (no `message.test`):
// a test/dev page drives every tick itself, deterministically, through `CB_SIM_STEP_REQ`
// (`sab/control.ts`; `engine/test`'s `stepTick`, `asHarness.stepTick`'s own generic "run one tick
// per call" contract) -- arming real-time pacing there too would let `onFire`'s own catch-up loop
// race a deterministic step request the instant a `body()` pass crossed a real 50 ms tick boundary
// (a slow CI machine, say), corrupting a hash comparison that must match a golden bit-for-bit
// (Deviations).
//
// `W_ACK` is still stored on every real wake regardless of `gcHook` (a plain `Atomics.store`,
// allocation-free, kept from the M06b stub this replaces): `asHarness.stepTick()`'s own generic
// wake-then-wait-for-ack lockstep (`test/client.ts`) needs it, the same way `gen`'s own body()
// does.
import { Role } from '../abi.js'
import { systemClock } from '../clock.js'
import { RingConnection } from '../ring-connection.js'
import {
  CB_SIM_STEP_REQ,
  CB_SIM_TICKS_RUN,
  W_ACK,
  WORKER_CLIENT,
  workerWord,
} from '../sab/control.js'
import { createSimHostFromInstance, type SimHostCounters, wrapEngineInstance } from '../server.js'
import { createAtomicsTimer } from './atomics-timer.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import {
  NET_COUNTERS_BYTES,
  NET_COUNTERS_CALL,
  SIM_COUNTERS_BYTES,
  SIM_COUNTERS_CALL,
} from './protocol.js'
import type { LoopState, Shell } from './shell.js'
import { handleTestCall } from './test-call.js'

function encodeCounters(c: SimHostCounters, out: Uint8Array): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, c.ticksRun >>> 0, true)
  view.setUint32(4, c.ticksDropped >>> 0, true)
  view.setUint32(8, c.tickOverruns >>> 0, true)
  view.setUint32(12, c.chunksWarmed >>> 0, true)
  view.setUint32(16, c.genOnMiss >>> 0, true)
}

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  const inst = await instantiateForSetup(shell, message, Role.Sim)
  const gcHook = message.test?.gcHook === true

  // docs/decisions/0032-atomics-timer-bounds-external-wakes.md (M16d): the timer takes a clock
  // again, but reads it only while external wakes interrupt its wait (about once per tick then) and
  // never on an uninterrupted pass; `SimHost`'s resync (0030) is the other reader.
  const atomicsTimer = createAtomicsTimer(systemClock)
  const simInstance = wrapEngineInstance(inst)
  const simHost = createSimHostFromInstance(simInstance, {
    clock: systemClock,
    timer: atomicsTimer.timer,
  })

  // docs/plan/15b-ring-connection-and-replica-rendering.md Scope: "the sim worker creates one
  // RingConnection at startup and accepts it" -- gated on `message.link` (Orchestrator ruling 1:
  // "the sim worker accepts a connection when the SAB set it boots with actually carries a client
  // link, and not otherwise"). Steps 1-3 left this line out entirely because every existing
  // `sim`-kind test page (`sim-worker.ts`, `gc-sim.ts`, `gc-topology.ts`, `gc-echo.ts`,
  // `topology.ts`) would otherwise always have one connection accepted at startup, and
  // `Host::connect` queues `Record::Player{Joined, Connected}` -- delivered at the very first
  // `tick()` -- which `fx-puts`'s own `on_player` handler turns into a real state write, changing
  // `sim_hash()` relative to `puts_idle_100`'s existing, accepted golden (zero connections ever).
  // None of those pages ever set `host.connect` (`client.ts`), so `message.link` is `undefined`
  // there and this stays a no-op for them by construction, not by a flag someone has to remember
  // not to set -- exactly the ruling's own reasoning. `simInstance.rxBytes()`/`txBytes()` size the
  // connection's own preallocated buffers from the real `Rx`/`Tx` region capacities this instance
  // just declared, rather than a magic number duplicated from `host::mod`'s `SIM_RX_BYTES`/
  // `SIM_TX_BYTES`.
  const connection =
    message.link === true
      ? new RingConnection(
          message.sabs.uplink,
          message.sabs.downlink,
          { maxUplinkBytes: simInstance.rxBytes(), maxDownlinkBytes: simInstance.txBytes() },
          { control: shell.control, index: WORKER_CLIENT },
        )
      : null
  if (connection) simHost.accept(connection)

  let lastStepReq = Atomics.load(shell.control.words, CB_SIM_STEP_REQ)
  // ADR 0030's `AtomicsTimer.poll()` fix (Deviations, "the highest-risk item"; Orchestrator ruling
  // 3): `poll()` fires its registered callback unconditionally on every `body()` pass, which is
  // correct only while nothing but the pacing timeout itself wakes this worker. Steps 1-3 landed
  // this comparison ready but provably inert (nothing woke `WORKER_HOST` externally in any
  // topology that existed then); this range is what makes it live, since a linked client's own
  // uplink `RingProducer` (`worker/client.ts`'s net pump) now wakes this worker on every batch it
  // pushes -- a genuine external wake, exactly what the fix exists for. `W_WAKE` (`sab/control.ts`)
  // only ever changes through an explicit `ControlBlock.wake()` call -- the timeout branch of
  // `Atomics.wait` never touches it -- so comparing this call's `wokenBy` against the value seen
  // last call is an *exact* test, not a heuristic: unchanged means nothing called `wake()` since
  // the last pass (a genuine timer fire, safe to hand to `atomicsTimer.poll()`); changed means some
  // producer (a linked client's uplink push, `CB_SIM_STEP_REQ`, a future presence/action ring) woke
  // this worker, and `poll()` is skipped for that pass so it does not also run a spurious tick.
  // `connected-paced.spec.ts`'s `poll_skips_a_spurious_tick_on_a_ring_wake` (Tests added) fails if
  // this comparison is ever removed -- the "fix nothing exercises" defect this repo keeps repeating.
  //
  // docs/decisions/0032-atomics-timer-bounds-external-wakes.md (M16d): the same comparison
  // is also what tells `AtomicsTimer` how its wait ended: `poll()` (timed out) credits the wait to
  // the timer's proven bound and fires once the deadline is reached; `interrupt()` (woken) credits
  // nothing and fires only if a clock read proves the deadline passed. Without that, a
  // producer waking this worker more often than once per interval restarted the full wait every
  // time and no tick ran at all (`sim_ticks_steadily_under_external_wakes`, same spec file).
  let lastWokenBy: number | null = null

  // Production topology, or a test page that opts in with `test.pace` (docs/plan/
  // 13b-tick-timing-allocation.md, Order of work 1): a test/dev page normally never calls this and
  // drives every tick itself through `CB_SIM_STEP_REQ` instead. `pace` exists so a zero-GC page can
  // arm real-time pacing (`onFire` via `AtomicsTimer`) while `test` stays present (`gcHook`/the
  // parked test-call channel still need it) -- safe to combine with manual `CB_SIM_STEP_REQ`
  // driving on the same page only because such a page asserts allocation, never a resulting hash.
  if (!message.test || message.test.pace === true) simHost.start()

  function body(wokenBy: number): void {
    if (gcHook) applyGcHook(shell.control, shell.index)
    // Drains every pending uplink message unconditionally, every wake (Scope: "its Atomics.wait
    // loop also wakes on the uplink ring's wake word") -- cheap when there is nothing queued
    // (`RingConnection.drainUplink`'s own loop breaks on the first empty `popInto`), and this is
    // what turns a client's `writeCameraAndWake`-style push into a real `sim_admit` call rather
    // than waiting for the next real tick's own wake.
    if (connection) connection.drainUplink()
    const stepReq = Atomics.load(shell.control.words, CB_SIM_STEP_REQ)
    if (stepReq !== lastStepReq) {
      const delta = (stepReq - lastStepReq) >>> 0
      lastStepReq = stepReq
      simHost.stepTick(delta)
    }
    if (wokenBy === lastWokenBy) atomicsTimer.poll()
    else atomicsTimer.interrupt()
    lastWokenBy = wokenBy
    Atomics.store(shell.control.words, CB_SIM_TICKS_RUN, simHost.counters.ticksRun)
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
  }

  return {
    body,
    timeoutMs: atomicsTimer.timeoutMs,
    testCall: (m) => {
      if (m.name === SIM_COUNTERS_CALL) {
        const result = new Uint8Array(SIM_COUNTERS_BYTES)
        encodeCounters(simHost.counters, result)
        return { type: 'test-result', id: m.id, value: 0, result }
      }
      if (m.name === NET_COUNTERS_CALL) {
        // `RingConnection.downlinkRetries` (`ring-connection.ts`): JS-side state this sim worker's
        // own `connection` holds, unreachable through any ABI export (`engine/test`'s
        // `netCounters`, same synthetic-name shape as `SIM_COUNTERS_CALL`, above).
        const result = new Uint8Array(NET_COUNTERS_BYTES)
        new DataView(result.buffer).setUint32(0, connection?.downlinkRetries ?? 0, true)
        return { type: 'test-result', id: m.id, value: 0, result }
      }
      return handleTestCall(inst, m)
    },
  }
}
