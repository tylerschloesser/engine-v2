// `engine/test`: the production-topology counterparts of `src/test/harness.ts`'s M03 helpers, this
// time driving a real `createClient()` result (docs/plan/06b-workers-and-spawn.md, Seams). Never
// imported by production code.

import { Status } from '../abi.js'
import { writeCameraBlock } from '../camera/block.js'
import type { CameraState } from '../camera/state.js'
import type { Client, ClientTestHandle, WorkerEntry } from '../client.js'
import { clientTestHandle } from '../client.js'
import { createResyncingClock, type ResyncingClock } from '../clock.js'
import {
  CB_FRAME_REQ,
  CB_SIM_STEP_REQ,
  CB_TEST_CONTROL,
  W_ACK,
  W_MEM_GROWS,
  W_MEM_PAGES,
  W_PARKED,
  W_WAKE,
  W_YIELD,
  WORKER_CLIENT,
  WORKER_HOST,
  workerWord,
} from '../sab/control.js'
import { RingConsumer, type RingStats } from '../sab/ring.js'
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

/** Like `allEqual` but treats a `net`-kind worker as always resumed (docs/plan/
 * 08b-gen-workers-and-queue.md, Deviations: found by this milestone's `gen.html`, the first page to
 * combine a `net` worker -- `host: { kind: 'remote', ... }`, the only host kind `fx-worldgen` can
 * use, since it has no `Sim` role -- with a real `resumeWorkers()` call). `net` never enters
 * `runBlockingLoop` (`worker/net.ts`: `setup()` returns `null`, so it has no `#loop`), and
 * `Shell.resume()` only stores `W_PARKED = 0` when a loop exists (`worker/shell.ts`), so a `net`
 * worker's `W_PARKED` stays 1 forever -- by its own design ("always reachable the way a parked one
 * is", `worker/net.ts`'s own doc comment), not a hang. `allEqual(h, W_PARKED, 0)` would poll forever
 * whenever a `net` worker is spawned; a plain indexed loop, not `Array.prototype.every` with an
 * inline arrow (same discipline as `allEqual`, immediately above). */
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
  return pollUntil(() => allResumed(h), 'resumeWorkers')
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
  // `allEqual`/`allResumed`, above): this runs inside a zero-GC page's own measured `drive()` call
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
      throw new Error('stepSimTickSync: the sim worker did not ack the step request')
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
