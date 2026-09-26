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
import { Persistence, WorldLoadError } from '../host/persistence.js'
import { RingConnection } from '../ring-connection.js'
import {
  CB_FORCE_SNAPSHOT_REQ,
  CB_SIM_STEP_REQ,
  CB_SIM_TICKS_RUN,
  W_ACK,
  WORKER_CLIENT,
  workerWord,
} from '../sab/control.js'
import { createSimHostFromInstance, type SimHostCounters, wrapEngineInstance } from '../server.js'
import { deleteWorld, exportWorld, importWorld, unpackArchive } from '../storage/archive.js'
import { memoryStorage } from '../storage/memory.js'
import { type OpfsStorage, OpfsUnavailable, opfsStorage } from '../storage/opfs.js'
import type { Storage } from '../storage/types.js'
import { createAtomicsTimer } from './atomics-timer.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateFactoryForSetup } from './instantiate.js'
import type { SetupMessage, SimWorldOpMessage, StorageStatus } from './protocol.js'
import {
  NET_COUNTERS_BYTES,
  NET_COUNTERS_CALL,
  PERSISTENCE_DEBUG_BYTES,
  PERSISTENCE_DEBUG_CALL,
  SIM_COUNTERS_BYTES,
  SIM_COUNTERS_CALL,
} from './protocol.js'
import type { LoopState, Shell } from './shell.js'
import { handleTestCall } from './test-call.js'

/** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: the Web Lock name a persisted world's
 * sim worker holds for its whole life (Planning decision 6: "Import ... takes lock `world:<id>` for
 * the duration" -- the same convention, so a running world and a pending import of its own id
 * contend on the identical lock). */
function worldLockName(worldId: string): string {
  return `world:${worldId}`
}

/** Web Lock acquisition without ever blocking this worker (`{ mode: 'exclusive', ifAvailable: true
 * }`): resolves `true`/`false` the instant the browser knows whether the lock was free, while the
 * lock itself (if granted) stays held until the returned `release` function is called -- the
 * standard "hold a lock for an arbitrary duration" idiom (`navigator.locks.request`'s own callback
 * keeps the lock for as long as the promise it returns is pending). Never releases on its own: a
 * persisted world holds its lock for the sim worker's whole life (Planning decision 6), released
 * only by whatever later milestone tears the worker down cleanly (Non-scope here, same as M23's own
 * "clean boundaries" not covering worker respawn, M24/M37). */
function requestWorldLock(worldId: string): Promise<boolean> {
  return new Promise((resolveGranted) => {
    navigator.locks.request(
      worldLockName(worldId),
      { mode: 'exclusive', ifAvailable: true },
      (lock) => {
        return new Promise<void>(() => {
          // Never resolves: holding the lock for the worker's whole life, deliberately (above).
          resolveGranted(lock !== null)
        })
      },
    )
  })
}

/** docs/plan/23-persistence-opfs-and-lifecycle.md steps 1-2 (Deviations): OPFS's own probe --
 * `opfsStorage` rejects with `OpfsUnavailable` on a browser with no working OPFS (0005 "Browser":
 * "No OPFS (Safari private mode): an in-memory adapter and `durable: false`"). Returns the adapter
 * plus whether it is durable, never throwing for that one, expected failure mode. */
async function openWorldStorage(
  worldId: string,
  noOpfs: boolean,
): Promise<{ storage: Storage; durable: boolean }> {
  if (noOpfs) return { storage: memoryStorage(), durable: false }
  try {
    return { storage: await opfsStorage(worldId), durable: true }
  } catch (e) {
    if (!(e instanceof OpfsUnavailable)) throw e
    return { storage: memoryStorage(), durable: false }
  }
}

/** docs/plan/23-persistence-opfs-and-lifecycle.md step 6, `neg_control_snapshot_allocates`:
 * `globalThis` property write, not a bare local -- the same reasoning `worker/gc-hook.ts`'s own
 * `sinkHolder` doc comment gives (a bundler tree-shakes an unread local all the way down to
 * nothing; a write to a property it cannot prove has no outside reader survives). */
type SinkHolder = { __engineSimLeakSink?: unknown }
const leakSinkHolder = globalThis as unknown as SinkHolder

/** Wraps `storage.append` so every call also allocates one throwaway object (`TestFlags.
 * leakyStorageAppend`), test-only and never calling the real underlying `append` (Deviations: real
 * OPFS `append`'s own fast path turned out to cost ~28 B/call on its own here, an unrelated,
 * previously-unmeasured finding -- `sim clean`'s own idle world never exercises it at all, since
 * `fx-puts` never dirties without a real action -- which would otherwise swamp this control's own
 * signal; recorded, not chased further, since this milestone's own question is the *snapshot*
 * event, not steady-state `append`). Reassigning an own property on the adapter instance, not
 * touching its prototype: every other method (`OpfsStorage`'s own `pendingAsync`/`scratchReady`/
 * `snapshotDeferred`, or `MemoryStorage.crashClone`) is unaffected, and this world's own
 * `Persistence` (which never calls `append` here: `fx-puts` under `gc-sim.ts` logs nothing) is
 * unaffected either way. */
function applyLeakyAppendHook(storage: Storage): void {
  storage.append = (key: string): void => {
    leakSinkHolder.__engineSimLeakSink = { key }
  }
}

/** `neg_control_snapshot_allocates`'s own per-tick trigger: a synthetic `append` call to a key
 * `Persistence`/the game never touch, so the control trips every tick regardless of whether that
 * tick's own gameplay produced a loggable frame (0029: it must actually fire, not merely be armed).
 */
const LEAK_PROBE_KEY = 'debug/leak-probe'
const LEAK_PROBE_BYTES = new Uint8Array(1)

/** `client.onStorage`'s own argument (Planning decision 5): `persisted`/`usage`/`quota` read fresh
 * from `navigator.storage` every call (off the tick path -- called only at load and at a
 * hidden-boundary pause, never per tick); `durable` is the fixed per-session value `openWorldStorage`
 * already decided. Missing `estimate()`/`persisted()` (a browser too old to have them, though every
 * browser this milestone supports does) degrade to `0`/`false` rather than throwing. */
async function readStorageStatus(durable: boolean): Promise<StorageStatus> {
  const persisted =
    typeof navigator.storage?.persisted === 'function' ? await navigator.storage.persisted() : false
  let usage = 0
  let quota = 0
  if (typeof navigator.storage?.estimate === 'function') {
    const estimate = await navigator.storage.estimate()
    usage = estimate.usage ?? 0
    quota = estimate.quota ?? 0
  }
  return { durable, persisted, usage, quota }
}

/**
 * docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Rules and traps ("serialize them"): one
 * FIFO promise chain per sim worker, shared by `sim-pause`/`sim-resume` and every export/import/
 * delete request, so the two families never interleave their own `SimHost`/`Storage` calls -- an
 * export requested while a hidden-boundary pause is mid-flight (or the reverse) always runs one to
 * completion before the other starts. A failure inside one queued `fn` is swallowed here (each `fn`
 * already reports its own outcome, `shell.post`/`shell.fatal`); this catch only keeps the chain alive
 * for whatever is queued behind it.
 */
function makeOpQueue(): (fn: () => Promise<void>) => void {
  let chain: Promise<void> = Promise.resolve()
  return (fn) => {
    chain = chain.then(fn, fn).catch(() => {})
  }
}

/**
 * docs/plan/23-persistence-opfs-and-lifecycle.md step 5: the export/import/delete handler, shared
 * between a normally-loaded world and one whose `Persistence.open` itself failed (Deviations,
 * `'load-failed'` -- `persistence`/`simHost` are both `null` there, so this closes only over
 * `storage`/`runningWorldId`, never touching either). `storage`'s own OPFS root is shared by every
 * adapter instance opened against it (`storage/archive.ts`'s own doc comment), so `import`/`delete`
 * reach an arbitrary *other* world's keys through this same, already-open handle -- no second
 * `opfsStorage()` call is ever made here.
 */
function makeWorldOpHandler(
  shell: Shell,
  runningWorldId: string,
  storage: Storage,
  simHost: { pause(): Promise<void>; resume(): void; readonly running: boolean } | null,
): (m: SimWorldOpMessage) => Promise<void> {
  return async (m) => {
    try {
      if (m.type === 'export-world') {
        // Planning decision 6: "the worker pauses, takes a snapshot if dirty, awaits `flush()`,
        // packs, and transfers the buffer back" -- but only when it is not *already* paused (a
        // settled or in-flight hidden-boundary pause, `sim-pause`'s own handler on this same queue):
        // `SimHost.pause()` is itself a no-op when not running, so calling it unconditionally would
        // be harmless for correctness, but calling `resume()` afterward regardless would wrongly
        // wake a world the hidden boundary meant to keep paused. `wasRunning` is read once, before
        // either call, and gates both symmetrically.
        const wasRunning = simHost?.running ?? false
        if (wasRunning) await simHost?.pause()
        try {
          const bytes = await exportWorld(storage, runningWorldId)
          shell.post({ type: 'export-world-result', bytes })
        } finally {
          if (wasRunning) simHost?.resume()
        }
      } else if (m.type === 'import-world') {
        // Planning decision 6: "takes lock `world:<id>` for the duration" -- `<id>` is the *target*
        // id, which for an omitted `opts.worldId` is only known once the archive itself is unpacked
        // (`unpackArchive`, no storage touched). Peeking it here, before the lock, then calling
        // `importWorld` again under the lock costs one extra decompress of a human-rate, off-the-
        // tick-path payload -- simpler and just as correct as splitting `importWorld` into a
        // peek-then-write pair for one caller.
        const peeked = await unpackArchive(m.bytes)
        const targetId = m.worldId ?? peeked.worldId
        if (targetId === runningWorldId) {
          throw new Error(
            `importWorld: refuses the running world's own id (${runningWorldId}, Planning decision 6)`,
          )
        }
        const opts: { worldId?: string; overwrite?: boolean } = { worldId: targetId }
        if (m.overwrite !== undefined) opts.overwrite = m.overwrite
        const result = await new Promise<{ worldId: string }>((resolve, reject) => {
          navigator.locks.request(`world:${targetId}`, { mode: 'exclusive' }, async () => {
            try {
              resolve(await importWorld(storage, m.bytes, opts))
            } catch (e) {
              reject(e)
            }
          })
        })
        shell.post({ type: 'import-world-result', worldId: result.worldId })
      } else if (m.type === 'delete-world') {
        // Deviations: refuses the running world's own id, but only when a live `SimHost` is
        // actually ticking it -- a load-failed world (`simHost === null`, this handler's own
        // degraded-path caller) has nothing to protect: `export_works_after_load_failure` deletes
        // exactly this id, on purpose, once its own `client.ready` has already rejected.
        if (simHost !== null && m.worldId === runningWorldId) {
          throw new Error(
            `deleteWorld: refuses the running world's own id (${runningWorldId}) -- it is open`,
          )
        }
        if (m.worldId === runningWorldId) {
          // Reachable only from the degraded/load-failed path (`simHost === null` above): this
          // worker already holds `world:<runningWorldId>` for its whole life (`requestWorldLock`'s
          // own doc comment, a promise that never resolves) -- requesting it again here would
          // deadlock forever waiting on a lock this same worker itself holds. Already effectively
          // exclusive by virtue of that Web Lock; no second one needed.
          await deleteWorld(storage, m.worldId)
        } else {
          await new Promise<void>((resolve, reject) => {
            navigator.locks.request(`world:${m.worldId}`, { mode: 'exclusive' }, async () => {
              try {
                await deleteWorld(storage, m.worldId)
                resolve()
              } catch (e) {
                reject(e)
              }
            })
          })
        }
        shell.post({ type: 'delete-world-result' })
      }
    } catch (e) {
      shell.post({ type: 'world-op-error', message: e instanceof Error ? e.message : String(e) })
    }
  }
}

function encodeCounters(c: SimHostCounters, out: Uint8Array): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, c.ticksRun >>> 0, true)
  view.setUint32(4, c.ticksDropped >>> 0, true)
  view.setUint32(8, c.tickOverruns >>> 0, true)
  view.setUint32(12, c.chunksWarmed >>> 0, true)
  view.setUint32(16, c.genOnMiss >>> 0, true)
}

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  const newInstance = await instantiateFactoryForSetup(shell, message, Role.Sim)
  const gcHook = message.test?.gcHook === true

  // docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: "Sim worker start-up order: Web Lock
  // -> OPFS probe -> Persistence.open -> tick loop", gated entirely on `message.world` (present only
  // for a persisted local host, `client.ts`'s own `host.persist` doc comment) -- every existing
  // `sim`-kind test/dev page omits `host.persist`, so `message.world` is `undefined` there and this
  // whole block is a no-op by construction, exactly `link`'s own precedent. `setup()` itself runs
  // before `runBlockingLoop` ever starts (`worker.ts`: `ready` is posted, then the loop begins), so
  // every `await` below runs in the worker's ordinary event loop, not through `shell.runAsync`.
  let inst = newInstance()
  let persistence: Persistence | undefined
  let initialTicksRun = 0
  let worldDurable = false
  // Planning decision 2: the sim worker body runs the queued rename/reopen through `shell.runAsync`
  // in the gap after the current tick pass -- only ever set when `openWorldStorage` actually opened
  // OPFS (`durable === true`; a `memoryStorage()` fallback has no such queue, `pendingAsync()` is
  // OPFS-only).
  let opfsAdapter: OpfsStorage | undefined
  // docs/plan/23-persistence-opfs-and-lifecycle.md step 5: kept for the export/import/delete
  // handler below (built once persistence has actually opened) -- distinct from `opfsAdapter`
  // (`undefined` on the `noOpfs`/memory-storage fallback, where export/import/delete still work).
  let worldStorage: Storage | undefined
  let runningWorldId: string | undefined

  if (message.world) {
    const world = message.world
    const locked = await requestWorldLock(world.worldId)
    if (!locked) {
      shell.post({
        type: 'start-failed',
        code: 'world-busy',
        detail: `world ${world.worldId} is already open elsewhere (its Web Lock is held)`,
      })
      throw new Error(`worker/sim: world ${world.worldId} is busy`)
    }

    const { storage, durable } = await openWorldStorage(
      world.worldId,
      message.test?.noOpfs === true,
    )
    worldDurable = durable
    if (durable) opfsAdapter = storage as OpfsStorage
    worldStorage = storage
    runningWorldId = world.worldId
    if (message.test?.leakyStorageAppend === true) applyLeakyAppendHook(storage)

    try {
      const opened = await Persistence.open(storage, world, newInstance, {
        ...(message.test?.snapshotEveryTicks !== undefined
          ? { snapshotEveryTicks: message.test.snapshotEveryTicks }
          : {}),
      })
      persistence = opened.persistence
      inst = opened.sim
      initialTicksRun = opened.tick

      shell.post({
        type: 'storage',
        status: await readStorageStatus(durable),
        created: opened.outcome === 'created',
      })
    } catch (e) {
      // docs/plan/23-persistence-opfs-and-lifecycle.md step 5 (Deviations, `'load-failed'`): unlike
      // `world-busy` above, this worker's own OPFS/Web-Lock handles are real and undamaged -- only
      // the *load* failed. Deliberately broad (any error from `Persistence.open`, not only
      // `WorldLoadError`'s own identity mismatch): a corrupt manifest (`JSON.parse` itself throwing
      // a plain `SyntaxError`, `export_works_after_load_failure`'s own scenario) is just as much "a
      // save the game cannot load" as an identity mismatch, and Q9's answer (this milestone's own
      // default, PLAN.md header) draws no distinction -- `exportWorld`/`deleteWorld` must still work
      // either way (Scope). Non-scope this milestone (M24b owns the upgrade/`SaveIncompatible` path):
      // reported, not handled, and nothing is written; the worker stays alive with a degraded,
      // non-ticking loop instead of dying like `world-busy` does.
      const kind = e instanceof WorldLoadError ? e.kind : 'load-error'
      const message = e instanceof Error ? e.message : String(e)
      shell.post({
        type: 'start-failed',
        code: 'load-failed',
        detail: `Persistence.open: ${message} (kind ${kind})`,
      })
      const enqueue = makeOpQueue()
      const worldOp = makeWorldOpHandler(shell, world.worldId, storage, null)
      return {
        body: () => {},
        timeoutMs: () => Number.POSITIVE_INFINITY,
        worldOp: (m) => enqueue(() => worldOp(m)),
      }
    }
  }

  // docs/decisions/0032-atomics-timer-bounds-external-wakes.md (M16d): the timer takes a clock
  // again, but reads it only while external wakes interrupt its wait (about once per tick then) and
  // never on an uninterrupted pass; `SimHost`'s resync (0030) is the other reader.
  const atomicsTimer = createAtomicsTimer(systemClock)
  const simInstance = wrapEngineInstance(inst)
  const simHost = createSimHostFromInstance(
    simInstance,
    { clock: systemClock, timer: atomicsTimer.timer },
    persistence,
    initialTicksRun,
  )

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
  // docs/plan/23-persistence-opfs-and-lifecycle.md step 6: `CB_FORCE_SNAPSHOT_REQ`'s own "last seen"
  // counter, the same diff-against-last-value shape as `lastStepReq` above.
  let lastForceSnapshotReq = Atomics.load(shell.control.words, CB_FORCE_SNAPSHOT_REQ)
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

  const leakyAppendArmed = message.test?.leakyStorageAppend === true

  function body(wokenBy: number): void {
    if (gcHook) applyGcHook(shell.control, shell.index)
    // `neg_control_snapshot_allocates`'s own per-tick trigger (above): unconditional, every real
    // wake, so the wrapped `append`'s own throwaway allocation actually fires inside the measured
    // window regardless of gameplay.
    if (leakyAppendArmed) worldStorage?.append(LEAK_PROBE_KEY, LEAK_PROBE_BYTES)
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
    // docs/plan/23-persistence-opfs-and-lifecycle.md step 6, Planning decision 1: `engine/test.
    // forceSnapshot()`'s own request word -- a real, deterministic snapshot inside a zero-GC page's
    // measured window, bypassing `sim_dirty()`'s own cadence guard the periodic path uses (this is a
    // *test* forcing exactly one snapshot event, not the production cadence). A no-op when this
    // world has no `persistence` (every page but a persisted one, `message.world`'s own gate).
    const forceSnapshotReq = Atomics.load(shell.control.words, CB_FORCE_SNAPSHOT_REQ)
    if (forceSnapshotReq !== lastForceSnapshotReq) {
      lastForceSnapshotReq = forceSnapshotReq
      persistence?.snapshotNow()
    }
    if (wokenBy === lastWokenBy) atomicsTimer.poll()
    else atomicsTimer.interrupt()
    lastWokenBy = wokenBy
    Atomics.store(shell.control.words, CB_SIM_TICKS_RUN, simHost.counters.ticksRun)
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
    // Planning decision 2, wired for real (M23 fix round 1: `shell.runAsync` now actually leaves
    // this pass's own enclosing loop instead of starving `fn` -- see `worker/shell.ts`). Polled after
    // every pass, cheap on the (overwhelmingly common) `null` read: `pendingAsync()` itself allocates
    // nothing (`opfs.ts`'s own doc comment), and `fn` here is a closure `write()` already built, not
    // one created by this call (`.claude/rules/hot-paths.md`).
    const pending = opfsAdapter?.pendingAsync()
    if (pending) shell.runAsync(pending)
  }

  // docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: `sim-pause`/`sim-resume`, present
  // only for a persisted world (`message.world`, same gate as the startup order above) --
  // `exactOptionalPropertyTypes` (root `tsconfig.base.json`) rejects an explicit `undefined` for an
  // optional field, so the field itself is only ever added via this conditional spread, never set to
  // `undefined`. Reached only while this worker is parked (`SimControlMessage`'s own doc comment):
  // main parks it (`W_YIELD` + wake, polling `W_PARKED`) before sending `sim-pause`; `sim-resume`
  // needs no separate park step, since `sim-pause`'s own handler never calls `shell.resume()` itself
  // -- the worker stays parked until `sim-resume` arrives.
  //
  // Step 5 (Rules and traps, "serialize them"): both `sim-pause`/`sim-resume` and every export/
  // import/delete request now run through the *same* `enqueueOp` FIFO chain, so the two families
  // never interleave their own `SimHost`/`Storage` calls.
  const enqueueOp = message.world ? makeOpQueue() : undefined
  const worldOpHandler =
    message.world && worldStorage && runningWorldId
      ? makeWorldOpHandler(shell, runningWorldId, worldStorage, simHost)
      : undefined
  const simControl =
    message.world && enqueueOp
      ? (m: Parameters<NonNullable<LoopState['simControl']>>[0]): void => {
          enqueueOp(async () => {
            if (m.type === 'sim-pause') {
              await simHost.pause()
              // Planning decision 5: "`client.onStorage` fires ... after each hidden-boundary
              // snapshot" -- this ack is also what `client.ts`'s own `pauseHostWorker` awaits to know
              // the pause has genuinely settled (never before `flush()` resolves).
              shell.post({
                type: 'storage',
                status: await readStorageStatus(worldDurable),
                created: false,
              })
            } else if (m.type === 'sim-resume') {
              simHost.resume()
              shell.resume()
            }
          })
        }
      : undefined
  const worldOp =
    enqueueOp && worldOpHandler
      ? (m: SimWorldOpMessage): void => {
          enqueueOp(() => worldOpHandler(m))
        }
      : undefined

  return {
    body,
    timeoutMs: atomicsTimer.timeoutMs,
    ...(simControl ? { simControl } : {}),
    ...(worldOp ? { worldOp } : {}),
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
      if (m.name === PERSISTENCE_DEBUG_CALL) {
        const result = new Uint8Array(PERSISTENCE_DEBUG_BYTES)
        const view = new DataView(result.buffer)
        const c = persistence?.counters
        view.setUint32(0, c?.logBytes ?? 0, true)
        view.setUint32(4, c?.frames ?? 0, true)
        view.setUint32(8, c?.snapshots ?? 0, true)
        view.setUint32(12, c?.lastSnapshotBytes ?? 0, true)
        view.setUint32(16, c?.syncs ?? 0, true)
        view.setUint32(20, opfsAdapter?.snapshotDeferred ?? 0, true)
        return { type: 'test-result', id: m.id, value: 0, result }
      }
      return handleTestCall(inst, m)
    },
  }
}
