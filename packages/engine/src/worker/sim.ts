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
import { CB_SIM_STEP_REQ, W_ACK, workerWord } from '../sab/control.js'
import { createSimHostFromInstance, type SimHostCounters, wrapEngineInstance } from '../server.js'
import { createAtomicsTimer } from './atomics-timer.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import { SIM_COUNTERS_BYTES, SIM_COUNTERS_CALL } from './protocol.js'
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

  // `createAtomicsTimer()` no longer takes a clock (docs/plan/13b-tick-timing-allocation.md): it
  // never reads one -- `systemClock` still reaches `SimHost` two lines below, which is the only
  // clock read left on this worker's own tick path (amortised there, not per wake).
  const atomicsTimer = createAtomicsTimer()
  const simHost = createSimHostFromInstance(wrapEngineInstance(inst), {
    clock: systemClock,
    timer: atomicsTimer.timer,
  })

  // docs/plan/15b-ring-connection-and-replica-rendering.md Scope: "the sim worker creates one
  // RingConnection at startup and accepts it". **Not done in this range** (steps 1-3's own cut
  // line): every existing browser page that spawns a `sim`-kind worker over `fx-puts` (`sim-
  // worker.ts`, `gc-sim.ts`, `gc-topology.ts`, `gc-echo.ts`, `topology.ts`) would then always have
  // one connection accepted at startup, and `Host::connect` queues `Record::Player{Joined,
  // Connected}` -- delivered at the very first `tick()` -- which `fx-puts`'s own `on_player`
  // handler turns into a real state write (`w.put_player(who, Player::default())`,
  // `fixtures/puts/src/lib.rs`). That changes `sim_hash()` relative to `puts_idle_100`'s existing,
  // accepted golden (zero connections ever), which `sim-worker.spec.ts`'s `sim_worker_steps_and_
  // hashes` compares `stepTick(100)`'s hash against byte-for-byte. Wiring this unconditionally
  // here would silently break that already-accepted test (or force re-blessing its golden, the
  // orchestrator's decision, not this range's -- "never weaken, skip, or change an existing
  // golden without asking"). `SimHost.accept`/`RingConnection` are both built and independently
  // tested this range (`server.ts`, `ring-connection.ts`, `tests/wasm/puts.test.ts`'s
  // `host_accepts_ring_connection_and_hashes_match`, over their own fresh instances) -- only this
  // one line of *production* wiring is left for whoever builds the client worker loop (step 4),
  // since only then does a real second party exist to connect, and a golden/topology decision (a
  // dedicated fixture or scenario with an accepted connection, distinct from `puts_idle_100`) can
  // be made deliberately rather than as a side effect.
  let lastStepReq = Atomics.load(shell.control.words, CB_SIM_STEP_REQ)
  // ADR 0030's `AtomicsTimer.poll()` revisited (Deviations, "the highest-risk item"): `poll()`
  // fires its registered callback unconditionally on every `body()` pass, which was correct only
  // while nothing but the pacing timeout itself ever wakes this worker (true today; still true
  // after this fix -- no ring wake is wired above). The *next* range to wire an uplink ring's
  // producer to wake this worker (`WORKER_HOST`) must not have to revisit this file to avoid a
  // spurious tick per external wake, so the fix lands now, ready and inert: `W_WAKE` (`sab/
  // control.ts`) only ever changes through an explicit `ControlBlock.wake()` call -- the timeout
  // branch of `Atomics.wait` never touches it -- so comparing this call's `wokenBy` against the
  // value seen last call is an *exact* test, not a heuristic: unchanged means nothing called
  // `wake()` since the last pass, i.e. this call happened only because the deadline elapsed (a
  // genuine timer fire, safe to hand to `atomicsTimer.poll()`); changed means some producer (a
  // future uplink ring, `CB_SIM_STEP_REQ`, a future presence/action ring) woke this worker, and
  // `poll()` is skipped for that pass so it does not also run a spurious tick. Provably inert
  // today: `CB_SIM_STEP_REQ`'s own wake (`test/client.ts`'s `stepSimTickSync`) is the only thing
  // that ever changes `W_WAKE` for `WORKER_HOST` in any existing topology, and real-time pacing
  // (the only consumer of `atomicsTimer.poll()`) is armed only for `!message.test`, which no
  // existing page sets -- so `poll()` is a no-op regardless of this comparison in every test that
  // exists today; this range's own `pnpm test wasm`/`pnpm test unit` runs (267/42/157 passing,
  // unchanged) are consistent with that.
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
    const stepReq = Atomics.load(shell.control.words, CB_SIM_STEP_REQ)
    if (stepReq !== lastStepReq) {
      const delta = (stepReq - lastStepReq) >>> 0
      lastStepReq = stepReq
      simHost.stepTick(delta)
    }
    if (wokenBy === lastWokenBy) atomicsTimer.poll()
    lastWokenBy = wokenBy
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
      return handleTestCall(inst, m)
    },
  }
}
