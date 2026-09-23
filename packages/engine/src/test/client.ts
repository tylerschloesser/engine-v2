// `engine/test`: the production-topology counterparts of `src/test/harness.ts`'s M03 helpers, this
// time driving a real `createClient()` result (docs/plan/06b-workers-and-spawn.md, Seams). Never
// imported by production code.

import { Status } from '../abi.js'
import { writeCameraBlock } from '../camera/block.js'
import type { CameraState } from '../camera/state.js'
import type { ActionOutcome, Client, ClientTestHandle, WorkerEntry } from '../client.js'
import { clientTestHandle } from '../client.js'
import { createResyncingClock, type ResyncingClock } from '../clock.js'
import {
  CB_FRAME_REQ,
  CB_SIM_STEP_REQ,
  CB_TEST_CONTROL,
  Ready,
  W_ACK,
  W_MEM_GROWS,
  W_MEM_PAGES,
  W_PARKED,
  W_READY,
  W_WAKE,
  W_YIELD,
  WORKER_CLIENT,
  WORKER_HOST,
  workerWord,
} from '../sab/control.js'
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../sab/layout.js'
import { RingConsumer, type RingStats } from '../sab/ring.js'
import { TripleReader } from '../sab/triple.js'
import type { SimHostCounters } from '../server.js'
import type { FromWorker, ToWorker } from '../worker/protocol.js'
import {
  isolateName,
  NET_COUNTERS_CALL,
  SIM_COUNTERS_BYTES,
  SIM_COUNTERS_CALL,
} from '../worker/protocol.js'
import type { Harness } from './harness.js'
import type { ManualClock } from './manual-clock.js'
import { StepControl } from './step-block.js'

/** The spike's ack-timeout guard (`spikes/zero-gc-webgpu/public/main.js`), reused by `stepFrame`
 * (Planning decisions "Stepped frames in tests"). Iteration-count only, not wall-clock (docs/plan/
 * 16e-park-timeout-diagnosis.md, CI round: a periodic `performance.now()` check -- even one gated
 * behind a coarse iteration mask, so it never fired on a *quiet* success path -- still fired, and
 * boxed, on a success path that was merely *slow*: a sibling isolate's own `burst` negative control
 * measurably delays this worker's ack without ever failing it, so the spin can legitimately cross a
 * periodic check many times before succeeding, and CI's software-mode budgets (`sim`'s `main` row is
 * exactly 0) have no room for that. Reverted to counting spins alone -- no `now()` call anywhere on
 * this path until the loop has already decided to fail. */
const SPIN_LIMIT = 2_000_000_000
const POLL_TIMEOUT_MS = 10_000

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Per-worker state for a timeout's failure message (docs/plan/16e-park-timeout-diagnosis.md,
 * Provides): built only when a wait is about to fail, never on the success path. Distinguishes the
 * four causes a bare "timed out" message cannot (Scope: (a) a worker stuck inside `body()`, (b) a
 * lost wake, (c) main's own poll/spin starved, (d) a dead worker). */
type WorkerDiag = {
  isolate: string
  W_YIELD: number
  W_PARKED: number
  W_WAKE: number
  W_ACK: number
  dead: boolean
}

function diagWorkers(h: ClientTestHandle): WorkerDiag[] {
  const out: WorkerDiag[] = []
  for (const w of h.workers) {
    out.push({
      isolate: isolateName(w.kind, w.index),
      W_YIELD: Atomics.load(h.control.words, workerWord(w.index, W_YIELD)),
      W_PARKED: Atomics.load(h.control.words, workerWord(w.index, W_PARKED)),
      W_WAKE: Atomics.load(h.control.words, workerWord(w.index, W_WAKE)),
      W_ACK: Atomics.load(h.control.words, workerWord(w.index, W_ACK)),
      dead: Atomics.load(h.control.words, workerWord(w.index, W_READY)) === Ready.Dead,
    })
  }
  return out
}

/** `${what}: timed out ...` message body shared by `pollUntil` and every spin-wait ack loop below
 * (Provides: "the enriched `parkWorkers` failure message" -- this is its exact shape). Called only
 * from the reject branch, never the success path. */
function describeTimeout(
  h: ClientTestHandle,
  what: string,
  limitMs: number,
  stats: { turns: number; elapsedMs: number; longestGapMs: number },
): string {
  const workers = diagWorkers(h)
  return (
    `${what}: timed out after ${limitMs} ms ` +
    `(turns=${stats.turns}, elapsedMs=${stats.elapsedMs.toFixed(1)}, ` +
    `longestGapMs=${stats.longestGapMs.toFixed(1)}) workers=${JSON.stringify(workers)}`
  )
}

/**
 * The per-worker-diagnostic message for one of this file's three spin-wait ack loops, once `spins`
 * has already exceeded `SPIN_LIMIT` (docs/plan/16e-park-timeout-diagnosis.md, CI round): called
 * *only* on that already-failing path, exactly once, so this is the one place these loops ever call
 * `now()` -- no periodic wall-clock check remains (removed after CI's software-mode `sim`/
 * `no_ui_change` budgets caught real allocation attributed to `main` from a *slow-but-succeeding*
 * spin under a sibling isolate's own `burst` control: a check gated behind a coarse iteration mask
 * still fires, and boxes, more than once whenever the spin legitimately runs long, which a sibling's
 * own burst control does on purpose). A synchronous spin never yields to the event loop, so it has
 * no macrotask "turns" the way `pollUntil` does, and recording a start timestamp to compute a real
 * "elapsed since entry" would itself cost a `now()` call on every entry, including the success path
 * -- so this reports `spins` (the iteration count) and the single `now()` reading taken here as
 * "detectedAtMs", not an elapsed duration, alongside the same per-worker `workers` listing
 * `describeTimeout` builds.
 */
function spinTimeoutMessage(h: ClientTestHandle, what: string, spins: number): string {
  const workers = diagWorkers(h)
  return (
    `${what}: timed out after ${spins} spins (limit ${SPIN_LIMIT}, detectedAtMs=${now().toFixed(1)}) ` +
    `workers=${JSON.stringify(workers)}`
  )
}

/** Polls `predicate` on a macrotask (main never blocks, 0015 §2), rejecting after
 * `POLL_TIMEOUT_MS` so a stuck worker fails a test instead of hanging the runner. `h` is read only
 * in the reject branch, to build the per-worker diagnostic (`describeTimeout`) -- the success path
 * (predicate true within a few turns, the overwhelming common case) allocates nothing new beyond
 * what already ran before this milestone. */
function pollUntil(predicate: () => boolean, what: string, h: ClientTestHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = now()
    let turns = 0
    let last = start
    let longestGapMs = 0
    const tick = (): void => {
      const t = now()
      if (turns > 0) {
        const gap = t - last
        if (gap > longestGapMs) longestGapMs = gap
      }
      last = t
      turns++
      if (predicate()) {
        resolve()
        return
      }
      if (t - start > POLL_TIMEOUT_MS) {
        reject(
          new Error(
            describeTimeout(h, what, POLL_TIMEOUT_MS, {
              turns,
              elapsedMs: t - start,
              longestGapMs,
            }),
          ),
        )
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
 * discipline (`stepFrame`'s spin, `asHarness.stepTick`).
 *
 * **`parkWorkers` sends one `wake()` per worker, once, deliberately not retried** (M17c, docs/plan/
 * 17c-client-park-stall.md, fix round 2): a first attempt here re-woke every not-yet-parked worker
 * on every poll turn, which was the wrong layer to fix at -- a harness that keeps re-signalling
 * until a worker parks hides exactly the class of protocol defect this milestone actually found (a
 * park request the worker's own loop structurally could not observe, not a one-off dropped OS-level
 * notify): `worker/shell.ts`'s `runBlockingLoop` checked `W_YIELD` only *after* a wait returned, so
 * a park signal landing before that loop's own *first* wait (inside `Shell.resume()`'s own gap
 * between reading `W_WAKE` and calling here, or symmetrically at `worker.ts`'s first entry or
 * `Shell.runAsync`'s re-entry) had already been folded into that first wait's own baseline, with no
 * further wake ever coming to un-stick it -- retrying the *signal* here could not have fixed that;
 * the loop itself had to check its own flag before blocking, not after. Fixed at that layer
 * (`runBlockingLoop`'s own doc comment); `parkWorkers`'s 10 s message is what actually measures a
 * regression of this kind, which a self-healing poll would instead have silently hidden. */
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
  return pollUntil(() => allEqual(h, W_PARKED, 1), 'parkWorkers', h)
}

/** Like `allEqual` but treats a `net`-kind worker as always resumed (docs/plan/
 * 08b-gen-workers-and-queue.md, Deviations: found by this milestone's `gen.html`, the first page to
 * combine a `net` worker -- `host: { kind: 'remote', ... }`, the only host kind `fx-worldgen` can
 * use, since it has no `Sim` role -- with a real `resumeWorkers()` call). `net` never enters
 * `runBlockingLoop` (`worker/net.ts`: `setup()` returns `null`, so it has no `#loop`), and
 * `Shell.resume()` only stores `W_PARKED = 0` when a loop exists (`worker/shell.ts`), so a `net`
 * worker's `W_PARKED` stays 1 forever -- by its own design ("always reachable the way a parked one
 * is", `worker/net.ts`'s own doc comment), not a hang. Checking `W_PARKED === 0` for every worker
 * unconditionally would poll forever whenever a `net` worker is spawned; a plain indexed loop, not
 * `Array.prototype.every` with an inline arrow (same discipline as `allEqual`, above). */
function allResumed(h: ClientTestHandle): boolean {
  for (let i = 0; i < h.workers.length; i++) {
    const w = h.workers[i] as WorkerEntry
    if (w.kind === 'net') continue
    if (Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) !== 0) return false
  }
  return true
}

/** Resumes every *parked* worker: `W_YIELD = 0`, `{ type: 'resume' }` (a parked worker is not
 * blocked, so this is the one way to reach it: Planning decisions "`yield` protocol"). Skips a
 * worker whose `W_PARKED` is not currently 1 (docs/plan/08b-gen-workers-and-queue.md, Deviations):
 * a worker blocked in `Atomics.wait` cannot process a `postMessage` at all, so sending it a
 * `resume` anyway would not be a no-op -- the message sits queued until that worker's *next* park,
 * at which point it fires and un-parks it again immediately, racing whatever the caller of that
 * next `parkWorkers()` was trying to do (`gen.idle`, called more than once in a row, found this the
 * hard way: `parkWorkers`'s own poll saw `W_PARKED` flicker 1/0 and never stabilised). Calling
 * `resumeWorkers` on an already-running client is therefore safe and cheap: nothing is sent, and
 * `allResumed`'s poll is already true. */
export function resumeWorkers(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  for (const w of h.workers) {
    if (Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) !== 1) continue
    Atomics.store(h.control.words, workerWord(w.index, W_YIELD), 0)
    w.worker.postMessage({ type: 'resume' })
  }
  return pollUntil(() => allResumed(h), 'resumeWorkers', h)
}

/** Resolves once every worker has acknowledged every request and is parked (Seams): the client's
 * `W_ACK` has caught up with `CB_FRAME_REQ`, every ring is drained, then every worker is parked. */
export async function untilQuiescent(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  const hasClient = h.workers.some((w) => w.kind === 'client')
  await pollUntil(
    () => {
      if (
        hasClient &&
        Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)) !==
          Atomics.load(h.control.words, CB_FRAME_REQ)
      ) {
        return false
      }
      return ringSabs(client).every(ringDrained)
    },
    'untilQuiescent',
    h,
  )
  await parkWorkers(client)
}

// docs/plan/15d-client-clock-allocation.md: `clockLike.now()` used to be read fresh on every call
// -- a fractional double, which V8 boxes as a new `HeapNumber` on every read (the same defect class
// 0030 fixed on the sim worker; measured here, `gc-sim-paced`'s `main`: ~11.96 B/frame,
// `stepFrame@client-*.js` the only entry, Deviations). Unlike 0030's own finding, this box is not
// purely an interpreter-tier artefact: it showed up at ~12 B/*read* under forced `--no-opt
// --no-sparkplug` **and**, once the read moved into `createResyncingClock`'s own accumulator, under
// default V8 too (Deviations) -- so the fix here is squarely about *frequency*, not tier. The real
// clock is read only once every `RESYNC_FRAMES` calls (`createResyncingClock`, `clock.ts`); between
// reads `frameTimeMs` accumulates this call's own `dtMs` with integer arithmetic, corrected back to
// the real elapsed time at every resync -- bounded, periodically-corrected drift, not a
// free-running synthetic clock, so a caller pacing against real elapsed time (`connected-paced.ts`'s
// uplink rate limit) still gets it. `RESYNC_FRAMES = 30`, not 0030's own `RESYNC_TICKS = 8`: chosen
// by measurement (Deviations) so the amortised cost (~0.4 B/frame) keeps `gc-sim-paced`'s
// re-derived `main` budget at its existing 30 rather than raising it -- 8 would have amortised to
// ~1.5 B/frame, enough to push the derived figure to 31. One entry per `Client`, created lazily on
// that client's first `stepFrame` call.
const RESYNC_FRAMES = 30
const frameClocks = new WeakMap<Client, ResyncingClock>()

/**
 * Advances the injected clock, writes the camera block, increments `CB_FRAME_REQ`, wakes the
 * client worker and spins on `W_ACK` (Planning decisions "Stepped frames in tests"; the spike's own
 * lockstep). Throws if no `client`-kind worker was spawned, or if it never acks.
 */
export function stepFrame(client: Client, dtMs: number): void {
  const h = clientTestHandle(client)
  const clockLike = h.clock as unknown as { advance?(ms: number): void }
  clockLike.advance?.(dtMs)
  let rc = frameClocks.get(client)
  if (!rc) {
    rc = createResyncingClock(h.clock, RESYNC_FRAMES)
    frameClocks.set(client, rc)
  }
  h.cameraState.frameTimeMs = rc.next(dtMs)
  writeCameraBlock(h.cameraWriter, h.cameraState)
  const req = (Atomics.add(h.control.words, CB_FRAME_REQ, 1) + 1) >>> 0
  h.control.wake(WORKER_CLIENT)
  let spins = 0
  while (Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)) !== req) {
    if (++spins > SPIN_LIMIT) {
      throw new Error(
        spinTimeoutMessage(h, 'stepFrame: the client worker did not ack the frame request', spins),
      )
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

/**
 * The synchronous core of `stepTick` (below): bumps `CB_SIM_STEP_REQ` by `n`, wakes the sim-kind
 * worker (`WORKER_HOST`) and spins on its own `W_ACK` -- `stepFrame`'s own "wake, then spin until
 * acked" idiom, confirming the request has already been served (`worker/sim.ts`'s `body()` runs
 * the `n` ticks synchronously before it next acks) before returning. Exported separately
 * (Deviations: a fourth name past the brief's own three) so a zero-GC page's synchronous `drive()`
 * loop (`gc-sim.ts`) can call it directly, without `stepTick`'s own trailing `untilQuiescent` -- a
 * `parkWorkers` round trip has no place inside a measured allocation window. Throws synchronously
 * if no `sim`-kind worker was spawned, or if it never acks.
 */
export function stepSimTickSync(client: Client, n = 1): void {
  const h = clientTestHandle(client)
  // A plain indexed loop, not `Array.prototype.some` with an inline arrow (same discipline as
  // `allEqual`/`allResumed`, above): this runs inside a zero-GC page's own measured `drive()`
  // call
  // every frame (`gc-sim.ts`/`gc-connected-terrain.ts`), and an inline-arrow `.some()` here was the
  // whole of `main`'s +28 B/frame in the interpreter tier (docs/plan/15f-step-sim-tick-sync-
  // allocation.md).
  let hasSim = false
  for (let i = 0; i < h.workers.length; i++) {
    if ((h.workers[i] as WorkerEntry).kind === 'sim') {
      hasSim = true
      break
    }
  }
  if (!hasSim) {
    throw new Error('stepSimTickSync: no sim-kind worker was spawned')
  }
  Atomics.add(h.control.words, CB_SIM_STEP_REQ, n)
  h.control.wake(WORKER_HOST)
  const want = Atomics.load(h.control.words, workerWord(WORKER_HOST, W_WAKE))
  let spins = 0
  while (Atomics.load(h.control.words, workerWord(WORKER_HOST, W_ACK)) < want) {
    if (++spins > SPIN_LIMIT) {
      throw new Error(
        spinTimeoutMessage(
          h,
          'stepSimTickSync: the sim worker did not ack the step request',
          spins,
        ),
      )
    }
  }
}

/**
 * Runs `n` ticks on the sim-kind worker deterministically, bypassing real-time pacing entirely
 * (docs/plan/13-sim-host-tick-loop.md, Scope: "A `CB_*` step-tick request word serves `stepTick`"):
 * `stepSimTickSync` (above), then resolves with `untilQuiescent(client)`, which also settles every
 * worker back to parked (a precondition `worldHash`/`simCounters`'s own `callParked` calls
 * require).
 */
export function stepTick(client: Client, n = 1): Promise<void> {
  stepSimTickSync(client, n)
  return untilQuiescent(client)
}

/**
 * docs/plan/16-action-round-trip.md: a `host.connect: true` page's own bootstrap. `Client.ready`
 * now also waits for `session_state = 1`, which the client worker only ever sets after it applies
 * a real host frame -- and a page whose own ticks are test-driven (no `test.flags.pace`) produces
 * one only by driving the sim itself, which normally happens through a test hook this same page
 * would expose only *after* `await client.ready` resolves. Deadlock, found and fixed live: cut B's
 * `connected`/`connected-terrain`/`gc-connected-terrain` pages each awaited `client.ready` before
 * wiring their own `__stepTick`/`drive()` -- nothing outside the page could reach a hook that did
 * not exist yet, and nothing inside it drove a tick either. `pumpUntilLive` is the fix for any such
 * page: call it once, in place of a bare `await client.ready`, before any test hook is wired.
 *
 * **Awaits `ClientTestHandle.workersReady` first, before ever calling `stepSimTickSync`** --
 * gate-round correction: an earlier version of this function used a caught `stepSimTickSync`
 * throw as its own "are the workers up yet" probe, retrying the call itself until it stopped
 * throwing. That call blocks the main thread in a tight spin until the sim worker acks, and
 * `clientTestHandle(client).workers` (what decided whether to attempt it) is populated well
 * *before* a worker has actually finished its own async setup (module instantiation, the `{ type:
 * 'ready' }` handshake) -- so the first attempt reliably started too early, blocked the main
 * thread for the rest of that setup, and *that block was itself what delayed the workers*: a
 * `connect: true` page measured 11.28 s in that one spin, ending exactly when every worker's own
 * `engine_init ok` log finally appeared, immediately after the spin gave up (hit its own iteration
 * limit) and yielded the thread back. Main-thread-blocking work has to wait for a real "workers up"
 * signal, not a proxy that can itself be the thing preventing that signal from ever arriving.
 *
 * Once workers are confirmed up, retries `stepSimTickSync` on a macrotask, racing `client.ready`
 * itself so the loop stops pumping the instant a real session-live poll succeeds. One real sim
 * tick applies `sim_connect`'s own queued `Joined` record (a real write, whatever `Game::on_player`
 * does with it), so `Host::build_frame` has something to send on the very first tick regardless of
 * camera state; the client worker's netPump wakes off the downlink ring itself (M15b), independent
 * of `CB_FRAME_REQ`/`stepFrame`, and `client.ready`'s own poll picks up the clock block once that
 * frame is applied. A page with a real-time-paced sim (`test.flags.pace`, `connected-paced.ts`)
 * needs none of this: the sim ticks on its own, so a bare `await client.ready` already resolves.
 */
export async function pumpUntilLive(client: Client): Promise<void> {
  await clientTestHandle(client).workersReady
  let live = false
  client.ready.then(() => {
    live = true
  })
  while (!live) {
    stepSimTickSync(client, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await client.ready
}

/**
 * docs/plan/16-action-round-trip.md Provides: pre-encoded `dispatch`, for a zero-GC window that
 * must not encode JSON inside the measured window (0016 §2) -- `jsonBytes` is caller-supplied,
 * already-UTF-8 bytes of one action's JSON, written through the exact same producer/scratch
 * `client.dispatch` itself uses (`ClientTestHandle.writeActionRecord`, never a second, independent
 * `RingProducer` racing it over the same SPSC `actionRing`). Unlike `dispatch`, this does not read
 * the clock block or manage the `seq` counter at all: the caller supplies both `seq` and the
 * bytes, and this throws the same `Error("engine: action queue full")` `dispatch` throws when the
 * physical ring has no room, but never the "before ready" check (a caller driving `dispatchRaw` in
 * a measured window already knows the session is live).
 */
export function dispatchRaw(client: Client, seq: number, jsonBytes: Uint8Array): void {
  const h = clientTestHandle(client)
  if (!h.writeActionRecord(seq, jsonBytes)) {
    throw new Error('engine: action queue full')
  }
}

const uiBoxes = new WeakMap<Client, { current: unknown }>()

/**
 * docs/plan/16b-ui-observation-and-clock.md Provides: the most recent value `client.onUi` has
 * delivered so far (`undefined` before the first one), read-back counterpart of `onUi` for a test
 * that just wants "what does the page currently see" rather than a log of every value in order
 * (`Ui` is coalesced to the newest per drain by construction, so a log would only ever grow by one
 * distinct entry per real change anyway). Subscribes exactly once per `Client` (lazily, on first
 * call, the same shape `actionResults` below uses), so a call made after a value already arrived
 * and was coalesced away still sees every value from that point on.
 */
export function lastUi<Ui = unknown>(client: Client): Ui | undefined {
  let box = uiBoxes.get(client)
  if (!box) {
    box = { current: undefined }
    const captured = box
    client.onUi((ui) => {
      captured.current = ui
    })
    uiBoxes.set(client, box)
  }
  return box.current as Ui | undefined
}

const actionResultLogs = new WeakMap<
  Client,
  Array<{ seq: number; result: ActionOutcome<unknown> }>
>()

/**
 * docs/plan/16-action-round-trip.md Provides: every `{ seq, result }` `client.onActionResult` has
 * delivered so far, in ring order -- the read-back counterpart of `dispatch`/`dispatchRaw` a test
 * needs without hand-rolling its own listener. Subscribes exactly once per `Client` (lazily, on
 * first call: `client.onActionResult` itself is the only way to observe the UI-ring drain, so this
 * is a thin accumulator over it, not a second, independent drain) and returns the same live array
 * on every call -- callers read its current contents, they do not own or clear it.
 */
export function actionResults(
  client: Client,
): Array<{ seq: number; result: ActionOutcome<unknown> }> {
  let log = actionResultLogs.get(client)
  if (!log) {
    log = []
    const captured = log
    client.onActionResult((seq, result) => {
      captured.push({ seq, result })
    })
    actionResultLogs.set(client, captured)
  }
  return log
}

/** `EngineInstance.readU64Hex`'s own byte order (`loader.ts`), replicated here over a plain
 * `Uint8Array` copy: `callParked`'s reply is a copy of `Result` region bytes, not a live
 * `EngineInstance` this file could call `readU64Hex` on directly. */
function hex64(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 7; i >= 0; i--) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return hex
}

/** The `role=sim` instance's own state hash (16-digit lowercase hex, `sim_hash`'s own format):
 * requires the sim worker parked (`stepTick`'s own end state; a bare `callParked` precondition). */
export async function worldHash(client: Client): Promise<string> {
  const { value, result } = await callParked(client, 'sim', 'sim_hash', [], 8)
  if (value !== Status.Ok) {
    throw new Error(`worldHash: sim_hash failed: status ${value}`)
  }
  return hex64(result)
}

/** `SimHost.counters` (`server.ts`), read out of the sim worker's own JS-side state through the
 * synthetic `test-call` name `worker/sim.ts`'s `testCall` handles directly (`worker/protocol.ts`'s
 * `SIM_COUNTERS_CALL`): requires the sim worker parked, same precondition as `worldHash`. */
export async function simCounters(client: Client): Promise<SimHostCounters> {
  const { result } = await callParked(client, 'sim', SIM_COUNTERS_CALL, [], SIM_COUNTERS_BYTES)
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  return {
    ticksRun: view.getUint32(0, true),
    ticksDropped: view.getUint32(4, true),
    tickOverruns: view.getUint32(8, true),
    chunksWarmed: view.getUint32(12, true),
    genOnMiss: view.getUint32(16, true),
  }
}

/** docs/plan/15b-ring-connection-and-replica-rendering.md, `engine/test`: `host::Host::region_
 * hash(conn)` (`sim_region_hash`, an ABI export reached directly by name through `callParked` --
 * no wrapper in `server.ts`, the same way `worldHash` reaches `sim_hash`). Requires the sim worker
 * parked. */
export async function hostRegionHash(client: Client, conn = 0): Promise<string> {
  const { value, result } = await callParked(client, 'sim', 'sim_region_hash', [conn], 8)
  if (value !== Status.Ok) {
    throw new Error(`hostRegionHash: sim_region_hash failed: status ${value}`)
  }
  return hex64(result)
}

/** docs/plan/16b-ui-observation-and-clock.md, `engine/test` (coordinator gate, M16b cut 2):
 * `UiObserver::{calls, records}` (`client_ui_stats`) -- `calls` is how many times `ClientSide::ui`
 * actually ran, `records` is how many of those calls wrote a real kind-1 record. Requires the
 * client worker parked. */
export async function uiObserverStats(client: Client): Promise<{ calls: number; records: number }> {
  const { value, result } = await callParked(client, 'client', 'client_ui_stats', [], 8)
  if (value !== Status.Ok) {
    throw new Error(`uiObserverStats: client_ui_stats failed: status ${value}`)
  }
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  return { calls: view.getUint32(0, true), records: view.getUint32(4, true) }
}

/** docs/plan/16b-ui-observation-and-clock.md, `engine/test`: forces `UiObserver::mark_dirty()`
 * (`client_ui_mark_dirty`, a test-only ABI export -- see that milestone's Deviations, "the dirty
 * flag has no browser-reachable setter yet"), the same "reached directly by name through
 * `callParked`" shape as `replicaHash`/`hostRegionHash`. Requires the client worker parked. No
 * production caller exists yet (M18's `FrameCx.uiDirty()` is the real one). */
export async function markUiDirty(client: Client): Promise<void> {
  const { value } = await callParked(client, 'client', 'client_ui_mark_dirty', [], 0)
  if (value !== Status.Ok) {
    throw new Error(`markUiDirty: client_ui_mark_dirty failed: status ${value}`)
  }
}

/** docs/plan/15b-ring-connection-and-replica-rendering.md, `engine/test`: `client::Replica::
 * region_hash()` (`client_region_hash`). Requires the client worker parked. */
export async function replicaHash(client: Client): Promise<string> {
  const { value, result } = await callParked(client, 'client', 'client_region_hash', [], 8)
  if (value !== Status.Ok) {
    throw new Error(`replicaHash: client_region_hash failed: status ${value}`)
  }
  return hex64(result)
}

/** docs/plan/15b-ring-connection-and-replica-rendering.md, `engine/test`: this milestone's own
 * "M15 counters + `downlinkRetries`" bundle for one connection -- `host::ConnCounters` (a real ABI
 * export, `sim_conn_counters`, reached directly by name), the underlying ring's own `drops`/
 * `pushed`/`popped` for both `uplink` and `downlink` (read straight out of the shared `SabSet`
 * buffers from main, the same way `ringDrained` above already does -- no worker round trip), and
 * `RingConnection.downlinkRetries` (`worker/sim.ts`'s own synthetic `NET_COUNTERS_CALL`, the one
 * piece with no ABI export at all). Requires the sim worker parked (the two `sim`-targeted calls
 * do); the ring reads do not.
 */
export type NetCounters = {
  bytesDown: number
  frames: number
  chunkEntersPristine: number
  chunkSnapshots: number
  chunkLeaves: number
  bytesUp: number
  downlinkRetries: number
  uplink: RingStats
  downlink: RingStats
}

function readU64LE(view: DataView, offset: number): number {
  // JS `number` losslessly represents every value this milestone's own counters ever reach (a
  // browser test's own byte/frame counts, nowhere near 2^53): `getBigUint64` would cross a
  // `BigInt` back through this file's own arithmetic for no benefit here.
  const lo = view.getUint32(offset, true)
  const hi = view.getUint32(offset + 4, true)
  return hi * 2 ** 32 + lo
}

export async function netCounters(client: Client, conn = 0): Promise<NetCounters> {
  const { value, result } = await callParked(client, 'sim', 'sim_conn_counters', [conn], 48)
  if (value !== Status.Ok) {
    throw new Error(`netCounters: sim_conn_counters failed: status ${value}`)
  }
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  const { result: netResult } = await callParked(client, 'sim', NET_COUNTERS_CALL, [], 4)
  const downlinkRetries = new DataView(
    netResult.buffer,
    netResult.byteOffset,
    netResult.byteLength,
  ).getUint32(0, true)
  const { sabs } = clientTestHandle(client)
  const uplink: RingStats = { drops: 0, pushed: 0, popped: 0 }
  const downlink: RingStats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer(sabs.uplink).stats(uplink)
  new RingConsumer(sabs.downlink).stats(downlink)
  return {
    bytesDown: readU64LE(view, 0),
    frames: readU64LE(view, 8),
    chunkEntersPristine: readU64LE(view, 16),
    chunkSnapshots: readU64LE(view, 24),
    chunkLeaves: readU64LE(view, 32),
    bytesUp: readU64LE(view, 40),
    downlinkRetries,
    uplink,
    downlink,
  }
}

/** docs/plan/17-drawlist-and-sprites.md, `engine/test`: one 32-bit FNV-1a pass over `bytes[offset,
 * offset+len)`, seeded with `seed`. Two independent seeds (below) give `drawListHash` a 64-bit-wide
 * hash without `BigInt` (`.claude/rules/hot-paths.md`'s own "no `BigInt`... per call" bullet is
 * about a per-frame/per-message path, which this test-only helper is not, but there is no reason to
 * reach for it here either). */
function fnv1a32(bytes: Uint8Array, offset: number, len: number, seed: number): number {
  let h = seed
  for (let i = 0; i < len; i++) {
    h ^= bytes[offset + i] as number
    h = Math.imul(h, 0x0100_0193)
  }
  return h >>> 0
}

const FNV32_SEED_LO = 0x811c_9dc5
const FNV32_SEED_HI = 0x1000_193b

/** docs/plan/17-drawlist-and-sprites.md, M17 cut-1 gate ("native-vs-`.wasm` equality, not
 * self-consistency"): a hash that is a **pure function of replica + camera**, deliberately
 * excluding `frame_seq` (header offset 0, a session-local call counter -- a `.wasm` instance driven
 * through several real ticks before the assertion has a different one than a native one-shot
 * `extract`+`sort_into`, even when every replicated/camera-derived byte agrees) and `frame_time_ms`
 * (offset 96, wall-clock-derived). Hashes `record_count`+`window_origin`+`layer_count` (header
 * `[4, 48)`, contiguous), `dropped` (`[88, 92)`), then `recordCount * 32` body bytes: two
 * independent 32-bit FNV-1a passes combined into 16 lowercase hex digits (`sim_hash`/`worldHash`'s
 * own format). **Exact twin of `crates/engine/src/client/drawlist.rs`'s `hash_region`** (same
 * seeds, same field order, `u32` XOR-then-`wrapping_mul` == JS `^=` then `Math.imul`) --
 * `fixtures/drawables/tests/drawlist_golden.rs` and `tests/wasm/drawlist.test.ts` both read the
 * same checked-in `fixtures/drawables/tests/golden/drawables_hash.hash` and must agree with it. */
export function hashDrawListFields(
  header: Uint8Array,
  body: Uint8Array,
  recordCount: number,
): string {
  const usedBodyBytes = Math.min(recordCount * 32, body.length)
  let lo = fnv1a32(header, 4, 44, FNV32_SEED_LO)
  lo = fnv1a32(header, 88, 4, lo)
  lo = fnv1a32(body, 0, usedBodyBytes, lo)
  let hi = fnv1a32(header, 4, 44, FNV32_SEED_HI)
  hi = fnv1a32(header, 88, 4, hi)
  hi = fnv1a32(body, 0, usedBodyBytes, hi)
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')
}

/** `hashDrawListFields` over the newest `drawList` triple-buffer slot. Reads the SAB directly, no
 * worker round trip (`netCounters`'s own ring reads are the precedent): the triple buffer is
 * main-thread-readable by design (0015 §2). */
export function drawListHash(client: Client): string {
  const { sabs } = clientTestHandle(client)
  const reader = new TripleReader(sabs.drawList, DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
  const slot = reader.acquire()
  const header = reader.headerView(slot)
  const body = reader.bodyView(slot)
  const recordCount = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    4,
    true,
  )
  return hashDrawListFields(header, body, recordCount)
}

/** One decoded `Draw` record (0018 §2), for `drawListRecords` below. */
export type DrawRecord = {
  pos: [number, number]
  size: [number, number]
  kind: number
  spriteId: number
  layer: number
  flags: number
  color: number
  param: number
  pickId: number
}

/** docs/plan/17-drawlist-and-sprites.md, `engine/test`: decodes every `Draw` record of the newest
 * `drawList` slot into `out` (cleared first), returning the count. Test-only (allocates one object
 * per record; `src/test/**` is exempt, `.claude/rules/hot-paths.md`). */
export function drawListRecords(client: Client, out: DrawRecord[]): number {
  const { sabs } = clientTestHandle(client)
  const reader = new TripleReader(sabs.drawList, DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
  const slot = reader.acquire()
  const header = reader.headerView(slot)
  const body = reader.bodyView(slot)
  const recordCount = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    4,
    true,
  )
  out.length = 0
  for (let i = 0; i < recordCount; i++) {
    const base = i * 32
    const view = new DataView(body.buffer, body.byteOffset + base, 32)
    const kindSprite = view.getUint16(16, true)
    out.push({
      pos: [view.getFloat32(0, true), view.getFloat32(4, true)],
      size: [view.getFloat32(8, true), view.getFloat32(12, true)],
      kind: kindSprite >>> 12,
      spriteId: kindSprite & 0x0fff,
      layer: view.getUint8(18),
      flags: view.getUint8(19),
      color: view.getUint32(20, true),
      param: view.getFloat32(24, true),
      pickId: view.getUint32(28, true),
    })
  }
  return recordCount
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
      // `< want`, not `!== want` (docs/plan/08b-gen-workers-and-queue.md, Deviations: found by
      // `gc-gen.ts`, the first zero-GC page whose `gen` target also has real, independent ring
      // traffic waking it -- a `genRequest`/`genResult` commit wakes `gen0` the same way this
      // synthetic tick does). `W_WAKE` is a monotonic counter shared by every wake source for this
      // worker; a real wake racing this tick's own wake can coalesce into one body() call, whose
      // single `W_ACK` store then *overshoots* `want` (acks a later value that already covers it).
      // An exact-match poll then spins forever, having already missed the value it was waiting for;
      // "has this worker acked at least as far as the wake I just issued" is what the caller
      // actually needs; `W_ACK` only ever moves forward.
      while (Atomics.load(h.control.words, workerWord(w.index, W_ACK)) < want) {
        if (++spins > SPIN_LIMIT) {
          throw new Error(
            spinTimeoutMessage(
              h,
              `asHarness.stepTick: worker '${w.kind}${w.index}' did not ack`,
              spins,
            ),
          )
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
