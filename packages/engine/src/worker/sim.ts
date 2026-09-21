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

  const atomicsTimer = createAtomicsTimer(systemClock)
  const simHost = createSimHostFromInstance(wrapEngineInstance(inst), {
    clock: systemClock,
    timer: atomicsTimer.timer,
  })

  let lastStepReq = Atomics.load(shell.control.words, CB_SIM_STEP_REQ)

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
    atomicsTimer.poll()
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
