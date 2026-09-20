// `engine/test`: the production-topology counterparts of `src/test/harness.ts`'s M03 helpers, this
// time driving a real `createClient()` result (docs/plan/06b-workers-and-spawn.md, Seams). Never
// imported by production code.

import { writeCameraBlock } from '../camera/block.js'
import type { CameraState } from '../camera/state.js'
import type { Client, ClientTestHandle, WorkerEntry } from '../client.js'
import { clientTestHandle } from '../client.js'
import {
  CB_FRAME_REQ,
  CB_TEST_CONTROL,
  W_ACK,
  W_MEM_GROWS,
  W_MEM_PAGES,
  W_PARKED,
  W_WAKE,
  W_YIELD,
  WORKER_CLIENT,
  workerWord,
} from '../sab/control.js'
import { RingConsumer, type RingStats } from '../sab/ring.js'
import type { FromWorker, ToWorker } from '../worker/protocol.js'
import { isolateName } from '../worker/protocol.js'
import type { Harness } from './harness.js'
import type { ManualClock } from './manual-clock.js'
import { StepControl } from './step-block.js'

/** The spike's ack-timeout guard (`spikes/zero-gc-webgpu/public/main.js`), reused by `stepFrame`
 * (Planning decisions "Stepped frames in tests"). */
const SPIN_LIMIT = 2_000_000_000
const POLL_TIMEOUT_MS = 10_000

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Polls `predicate` on a macrotask (main never blocks, 0015 §2), rejecting after
 * `POLL_TIMEOUT_MS` so a stuck worker fails a test instead of hanging the runner. */
function pollUntil(predicate: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = now()
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (now() - start > POLL_TIMEOUT_MS) {
        reject(new Error(`${what}: timed out after ${POLL_TIMEOUT_MS} ms`))
        return
      }
      setTimeout(tick, 0)
    }
    tick()
  })
}

/** Every ring `SharedArrayBuffer` in a `SabSet` (`untilQuiescent`'s "every ring `PUSHED ==
 * POPPED`"). */
function ringSabs(client: Client): SharedArrayBuffer[] {
  const { sabs } = clientTestHandle(client)
  return [
    sabs.uploadRing,
    sabs.actionRing,
    sabs.inputRing,
    sabs.uiRing,
    sabs.uplink,
    sabs.downlink,
    ...sabs.genRequest,
    ...sabs.genResult,
  ]
}

function ringDrained(sab: SharedArrayBuffer): boolean {
  const stats: RingStats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer(sab).stats(stats)
  return stats.pushed === stats.popped
}

/** `Array.prototype.every` with an inline arrow allocates a fresh callback closure on every call
 * (`.claude/rules/hot-paths.md`'s "no per-iteration closures/`Array.prototype` callbacks", and
 * `src/test/**` is exempt from the *rule* but not from this being a real cost on this path: fix
 * round 2, docs/plan/06b-workers-and-spawn.md, Deviations). `parkWorkers`/`resumeWorkers` are
 * called from inside `installGcPage`'s own measured window (`harness.park()`/`resume()`), and
 * `pollUntil` below calls its `predicate` once per macrotask until it is true -- normally 1-3
 * ticks, but under CPU contention a worker's own OS thread can take many more event-loop turns to
 * flip its `W_PARKED` word, so a per-tick closure allocation here scales with contention, not with
 * frame count, and no amount of warm-up removes it. `allEqual` below is a named function created
 * once per call (not per tick) and uses a plain indexed loop, matching the rest of this file's own
 * discipline (`stepFrame`'s spin, `asHarness.stepTick`). */
function allEqual(h: ClientTestHandle, field: number, want: number): boolean {
  for (let i = 0; i < h.workers.length; i++) {
    const w = h.workers[i] as WorkerEntry
    if (Atomics.load(h.control.words, workerWord(w.index, field)) !== want) return false
  }
  return true
}

/** Parks every spawned worker: `W_YIELD = 1` then a wake, polling `W_PARKED` (main never blocks on
 * a `SharedArrayBuffer`, so this is a macrotask poll, not `Atomics.wait`). */
export function parkWorkers(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  for (const w of h.workers) {
    Atomics.store(h.control.words, workerWord(w.index, W_YIELD), 1)
    h.control.wake(w.index)
  }
  return pollUntil(() => allEqual(h, W_PARKED, 1), 'parkWorkers')
}

/** Resumes every parked worker: `W_YIELD = 0`, `{ type: 'resume' }` (a parked worker is not
 * blocked, so this is the one way to reach it: Planning decisions "`yield` protocol"). */
export function resumeWorkers(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  for (const w of h.workers) {
    Atomics.store(h.control.words, workerWord(w.index, W_YIELD), 0)
    w.worker.postMessage({ type: 'resume' })
  }
  return pollUntil(() => allEqual(h, W_PARKED, 0), 'resumeWorkers')
}

/** Resolves once every worker has acknowledged every request and is parked (Seams): the client's
 * `W_ACK` has caught up with `CB_FRAME_REQ`, every ring is drained, then every worker is parked. */
export async function untilQuiescent(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  const hasClient = h.workers.some((w) => w.kind === 'client')
  await pollUntil(() => {
    if (
      hasClient &&
      Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)) !==
        Atomics.load(h.control.words, CB_FRAME_REQ)
    ) {
      return false
    }
    return ringSabs(client).every(ringDrained)
  }, 'untilQuiescent')
  await parkWorkers(client)
}

/**
 * Advances the injected clock, writes the camera block, increments `CB_FRAME_REQ`, wakes the
 * client worker and spins on `W_ACK` (Planning decisions "Stepped frames in tests"; the spike's own
 * lockstep). Throws if no `client`-kind worker was spawned, or if it never acks.
 */
export function stepFrame(client: Client, dtMs: number): void {
  const h = clientTestHandle(client)
  const clockLike = h.clock as unknown as { advance?(ms: number): void; now(): number }
  clockLike.advance?.(dtMs)
  h.cameraState.frameTimeMs = clockLike.now()
  writeCameraBlock(h.cameraWriter, h.cameraState)
  const req = (Atomics.add(h.control.words, CB_FRAME_REQ, 1) + 1) >>> 0
  h.control.wake(WORKER_CLIENT)
  let spins = 0
  while (Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)) !== req) {
    if (++spins > SPIN_LIMIT) {
      throw new Error('stepFrame: the client worker did not ack the frame request')
    }
  }
}

/** Sets the camera state `stepFrame` will next write to the camera block; takes effect on the next
 * `stepFrame` call, not immediately (Seams). */
export function setCamera(
  client: Client,
  opts: { x: number; y: number; tilesAcross: number },
): void {
  const { cameraState } = clientTestHandle(client)
  cameraState.centreX = opts.x
  cameraState.centreY = opts.y
  cameraState.tilesAcross = opts.tilesAcross
}

export type { CameraState }

/** `callParked`'s answer: `value` is the export's return value, `result` a copy of the first
 * `resultBytes` bytes of that worker's own `Result` region. */
export type TestCallResult = { value: number; result: Uint8Array }

let nextTestCallId = 1

function findWorkerEntry(h: ClientTestHandle, isolate: string): WorkerEntry {
  for (const w of h.workers) {
    if (isolateName(w.kind, w.index) === isolate) return w
  }
  throw new Error(`callParked: no worker named '${isolate}'`)
}

/**
 * Reads a worker's own instance state from main through the parked-only `test-call` channel
 * (docs/plan/08b-gen-workers-and-queue.md, orchestrator decision 1 at the step-5 boundary): calls
 * ABI export `name` with `args` (0, 1 or 2 numbers) on the `isolate`-named worker and returns its
 * return value plus a copy of the first `resultBytes` bytes of `Result`. Rejects immediately,
 * without sending anything, when that worker's `W_PARKED` is not 1 -- a worker blocked in
 * `Atomics.wait` receives no events, so a call sent to one that is not parked would only resolve
 * once it happens to park for some other reason, which is not a wait this helper should hide.
 */
export function callParked(
  client: Client,
  isolate: string,
  name: string,
  args?: number[],
  resultBytes?: number,
): Promise<TestCallResult> {
  const h = clientTestHandle(client)
  const w = findWorkerEntry(h, isolate)
  if (Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) !== 1) {
    return Promise.reject(new Error(`callParked: worker '${isolate}' is not parked`))
  }
  const id = nextTestCallId++
  const msg: ToWorker = {
    type: 'test-call',
    id,
    name,
    ...(args !== undefined && args.length > 0 ? { a: args[0] as number } : {}),
    ...(args !== undefined && args.length > 1 ? { b: args[1] as number } : {}),
    ...(resultBytes !== undefined && resultBytes > 0 ? { resultBytes } : {}),
  }
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent<FromWorker>): void => {
      const reply = ev.data
      if (reply.type === 'test-result' && reply.id === id) {
        w.worker.removeEventListener('message', onMessage as EventListener)
        resolve({ value: reply.value, result: reply.result })
      } else if (reply.type === 'test-error' && reply.id === id) {
        w.worker.removeEventListener('message', onMessage as EventListener)
        reject(new Error(reply.message))
      }
    }
    w.worker.addEventListener('message', onMessage as EventListener)
    w.worker.postMessage(msg)
  })
}

const WASM_PAGE_BYTES = 65536

/**
 * `engine/test`: adapts a real `createClient()` result to the `Harness` shape `installGcPage`/
 * `zeroGcSuite` (M04) already drive, so the same generated zero-GC suite runs unchanged against a
 * production topology (docs/plan/06b-workers-and-spawn.md, Seams; orchestrator decision 4).
 * `park`/`resume` map to the `yield` protocol (`parkWorkers`/`resumeWorkers` above), `stepFrame` to
 * this file's own `stepFrame` (its `W_ACK` lockstep), `stepTick` wakes every `sim`/`gen` worker and
 * locksteps on their own `W_ACK` the same way (they have no ring traffic of their own to
 * synchronise on before M13/M08b: `worker/sim.ts`/`worker/gen.ts` store it on every real wake for
 * exactly this), and `setWorkerControl` writes `CB_TEST_CONTROL` (`sab/control.ts`).
 * `memoryBytes`/`memGrows` read `W_MEM_PAGES`/`W_MEM_GROWS` directly out of shared memory: no
 * message needed, unlike the M03/M04 harness. `hash`/`admit`/`messageTick` have no production
 * counterpart yet and reject if ever called; `errors()` is always empty (a running client has no
 * ongoing fault-reporting channel past `ready`/`fatal` yet -- Deviations).
 */
export function asHarness(client: Client): Harness {
  const h = clientTestHandle(client)
  const names = h.workers.map((w) => isolateName(w.kind, w.index))
  const byName = new Map<string, WorkerEntry>()
  h.workers.forEach((w, i) => {
    byName.set(names[i] as string, w)
  })
  const tickTargets = h.workers.filter((w) => w.kind === 'sim' || w.kind === 'gen')
  // Preallocated scratch, reused every `stepTick()` call (`.claude/rules/hot-paths.md`): this runs
  // inside the gc suite's measured window on `main`, same discipline as `stepFrame` above even
  // though `src/test/**` is exempt from the rule itself.
  const tickWant = new Int32Array(tickTargets.length)

  function findWorker(name: string): WorkerEntry {
    const w = byName.get(name)
    if (!w) throw new Error(`asHarness: no worker named '${name}'`)
    return w
  }

  function stepTick(): void {
    for (let i = 0; i < tickTargets.length; i++) {
      const w = tickTargets[i] as WorkerEntry
      h.control.wake(w.index)
      tickWant[i] = Atomics.load(h.control.words, workerWord(w.index, W_WAKE))
    }
    for (let i = 0; i < tickTargets.length; i++) {
      const w = tickTargets[i] as WorkerEntry
      const want = tickWant[i] as number
      let spins = 0
      while (Atomics.load(h.control.words, workerWord(w.index, W_ACK)) !== want) {
        if (++spins > SPIN_LIMIT) {
          throw new Error(`asHarness.stepTick: worker '${w.kind}${w.index}' did not ack`)
        }
      }
    }
  }

  return {
    clock: h.clock as unknown as ManualClock,
    workerNames: names,

    stepTick,
    stepFrame(dtMs) {
      stepFrame(client, dtMs)
    },

    resume() {
      return resumeWorkers(client)
    },
    park() {
      return parkWorkers(client)
    },
    untilQuiescent() {
      return untilQuiescent(client)
    },

    hash() {
      return Promise.reject(new Error('asHarness: hash() has no production counterpart yet'))
    },
    admit() {
      return Promise.reject(new Error('asHarness: admit() has no production counterpart yet'))
    },
    messageTick() {
      return Promise.reject(new Error('asHarness: messageTick() has no production counterpart yet'))
    },

    async memoryBytes() {
      const out: Record<string, number> = {}
      for (let i = 0; i < h.workers.length; i++) {
        const w = h.workers[i] as WorkerEntry
        out[names[i] as string] =
          Atomics.load(h.control.words, workerWord(w.index, W_MEM_PAGES)) * WASM_PAGE_BYTES
      }
      return out
    },
    async memGrows() {
      const out: Record<string, number> = {}
      for (let i = 0; i < h.workers.length; i++) {
        const w = h.workers[i] as WorkerEntry
        out[names[i] as string] = Atomics.load(h.control.words, workerWord(w.index, W_MEM_GROWS))
      }
      return out
    },

    markIsolates() {
      // A no-op: CDP marks every isolate directly (`tests/browser/gc/instrument.ts`, orchestrator
      // decision 3), since a production worker cannot call `performance.mark` itself and this
      // milestone adds no new `postMessage` type to ask one to.
      return Promise.resolve()
    },
    setWorkerControl(name, control) {
      const w = findWorker(name)
      const enc = control === StepControl.None ? 0 : (((w.index + 1) << 8) | control) >>> 0
      Atomics.store(h.control.words, CB_TEST_CONTROL, enc)
    },
    workerGcExposed() {
      // The `gc` Playwright project launches Chromium with `--js-flags=--expose-gc` process-wide
      // (docs/decisions/0016 §3), so every realm including a production worker's has `gc` exposed;
      // there is no message to ask a production worker to report this itself (Deviations).
      const out: Record<string, boolean> = {}
      for (const name of names) out[name] = true
      return out
    },

    errors() {
      // A running client has no ongoing fault-reporting channel yet (Deviations): `setupWorker`'s
      // `onmessage`/`onerror` only listen until `ready`/`fatal` settles the spawn promise.
      return []
    },
    dispose() {
      client.destroy()
    },
  }
}
