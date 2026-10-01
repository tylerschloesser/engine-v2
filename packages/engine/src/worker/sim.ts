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
// (Deviations). The same `pacingEnabled` decision also picks *which timer service* `SimHost` is
// built with (a no-op `every()` for a test/dev page): `SimHost.resume()` (docs/plan/
// 28b-reconnect-and-lifecycle.md step 4, "a `Hello` while paused resumes the timer") calls the
// exact same `arm()` `start()` does, reachable from a fresh, never-`start()`ed `SimHost`'s own
// first real `Hello` regardless of topology -- a real timer there would arm the race above through
// a path this gate alone cannot see (found live, a real CI-only regression: docs/plan/
// 28b-reconnect-and-lifecycle.md, Deviations).
//
// `W_ACK` is still stored on every real wake regardless of `gcHook` (a plain `Atomics.store`,
// allocation-free, kept from the M06b stub this replaces): `asHarness.stepTick()`'s own generic
// wake-then-wait-for-ack lockstep (`test/client.ts`) needs it, the same way `gen`'s own body()
// does.
import { Role } from '../abi.js'
import { systemClock, systemScheduler } from '../clock.js'
import { MAGIC, parseBuildHash32 } from '../host/handshake.js'
import { Persistence, WorldLoadError } from '../host/persistence.js'
import { loadSessionTable } from '../host/sessions.js'
import { EngineTrap } from '../loader.js'
import { RingConnection } from '../ring-connection.js'
import {
  CB_FORCE_SNAPSHOT_REQ,
  CB_SIM_STEP_REQ,
  CB_SIM_TICK_US,
  CB_SIM_TICKS_RUN,
  W_ACK,
  WORKER_CLIENT,
  workerWord,
} from '../sab/control.js'
import {
  createSimHostFromInstance,
  type HandshakeDeps,
  type RecoveryDeps,
  type SimHostCounters,
  wrapEngineInstance,
} from '../server.js'
import { deleteWorld, exportWorld, importWorld, unpackArchive } from '../storage/archive.js'
import { memoryStorage } from '../storage/memory.js'
import { type OpfsStorage, OpfsUnavailable, opfsStorage } from '../storage/opfs.js'
import type { Storage } from '../storage/types.js'
import { worldKeys } from '../storage/types.js'
import { WORLD_LOCK_WAIT_MS } from '../world-lock.js'
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
import { asNumberList } from './test-trap.js'

/** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: the Web Lock name a persisted world's
 * sim worker holds for its whole life (Planning decision 6: "Import ... takes lock `world:<id>` for
 * the duration" -- the same convention, so a running world and a pending import of its own id
 * contend on the identical lock). */
function worldLockName(worldId: string): string {
  return `world:${worldId}`
}

/** Web Lock acquisition without ever blocking this worker: one *waiting* exclusive request, aborted
 * after `waitMs` (`AbortSignal.timeout`; `0`: only if free right now), resolving `true` the moment it
 * is granted and `false` when the wait ran out. The lock itself stays held until the worker is gone -- the standard "hold a lock
 * for an arbitrary duration" idiom (`navigator.locks.request`'s callback keeps it for as long as the
 * promise it returns is pending; this one never settles). A persisted world holds its lock for the sim
 * worker's whole life (Planning decision 6); a closing document's worker releases it by dying. */
function requestWorldLock(worldId: string, waitMs: number): Promise<boolean> {
  return new Promise((resolveGranted) => {
    navigator.locks
      .request(
        worldLockName(worldId),
        waitMs > 0
          ? { mode: 'exclusive', signal: AbortSignal.timeout(waitMs) }
          : { mode: 'exclusive', ifAvailable: true },
        (lock) =>
          new Promise<void>(() => {
            resolveGranted(lock !== null)
          }),
      )
      .catch(() => resolveGranted(false)) // AbortError: still held by someone else after `waitMs`
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
              const imported = await importWorld(storage, m.bytes, opts)
              // Deviations, fix round: `Storage.write`'s own fast path (an already-open scratch
              // handle) returns before its queued rename/reopen lands (Planning decision 2) --
              // `importWorld`'s own write loop only drains *that* queue when a later write's own
              // slow path happens to run first (`#writeViaFreshHandle`'s "drain the previous pending
              // chain" step). A one-key archive, or one whose last key lands on the fast path, can
              // otherwise report success before the rename is durable -- invisible to this same
              // adapter's own `read`/`list` (both consult `#writtenPending` first) but a real race
              // against any *other* reader of the raw OPFS tree (`world-dump-worker.ts`, a real
              // world's own next sim worker). `flush()` (0005: "resolves when everything handed over
              // so far is durable") drains it for real before this responds.
              await storage.flush()
              resolve(imported)
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
  // docs/plan/24b-upgrade-and-migration.md: set only when `Persistence.open` itself took the
  // upgrade path -- fires `simHost.onRecovered({reason: 'upgrade', ...})` once, right after
  // `simHost` exists (M24's own `onRecovered` field is set by the caller, never before then).
  let openedUpgrade: { reason: 'direct' | 'migrated'; droppedTailRecords: number } | undefined
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
    // A respawned worker (docs/plan/37-robustness-events.md step 2) takes the lock the dead one held:
    // main terminated it a moment ago, and the browser releases the lock when that thread is gone,
    // which is not instant: the same wait as a start after a reload.
    const locked = await requestWorldLock(world.worldId, world.lockWaitMs ?? WORLD_LOCK_WAIT_MS)
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
      openedUpgrade = opened.upgrade

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
      // docs/plan/24b-upgrade-and-migration.md: `kind === 'incompatible'` is carved out of the
      // broad `'load-failed'` bucket above into its own `'save-incompatible'` code (Traps: "other
      // open failures stay 'load-failed'") -- both keep this same degraded-worker fallback
      // (`exportWorld`/`deleteWorld` still reachable), only the reported code/detail differ.
      if (e instanceof WorldLoadError && e.kind === 'incompatible' && e.reason !== undefined) {
        shell.post({
          type: 'start-failed',
          code: 'save-incompatible',
          detail: `Persistence.open: ${message}`,
          reason: e.reason,
          stored: e.stored ?? e.running,
          running: e.running,
        })
      } else {
        shell.post({
          type: 'start-failed',
          code: 'load-failed',
          detail: `Persistence.open: ${message} (kind ${kind})`,
        })
      }
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
  // docs/plan/24-recovery-and-migration.md: `SimHost.recover()`'s own dependencies -- `instance` is
  // kept in sync by `recover()` itself on every successful recovery, so this file's own `testCall`
  // fallback (`handleTestCall`, below) always reaches the *current* raw instance instead of a stale,
  // dead one after a recovery.
  const recoveryDeps: RecoveryDeps = { instance: inst, newInstance }
  // docs/plan/28-sessions-and-reconnect.md step 5: the real handshake, wired for this worker's own
  // linked (single-player) topology too -- Scope: "single-player takes the same path", exit
  // criterion 1: "no provisional-join code path remains in the sim host" (of the two production
  // call sites, `createWorldServer` already wired this in steps 1-2; this was the one left over,
  // and the Open gate failures item this milestone's own bisect traced to it: a client instance
  // that never gets a real `Welcome` never has its `own_player` corrected off its `PlayerId(0)`
  // placeholder, so `Replica::region_hash`'s own `self.store.player(self.own_player)` term
  // diverges from the host's). Gated on `message.link` (the same "no flag to turn off" convention
  // every other linked-only piece of this file already follows): every non-linked `sim`-kind test
  // page (`sim-worker.ts`, `gc-sim.ts`, `gc-topology.ts`, `gc-echo.ts`, `topology.ts`) never calls
  // `accept()` at all, so building this costs them nothing and changes nothing. A persisted world
  // (`message.world`) reuses its own already-open `storage`; an unpersisted single-player session
  // (the common case: no `host.persist`) gets an ephemeral, throwaway table over `memoryStorage()`
  // -- correct either way, since 0013's session table only ever needs to survive one connection's
  // own reconnects within this worker's life, and a fresh `memoryStorage()` per boot is exactly
  // what "no cross-device recovery, single-player included" already implies.
  let handshake: HandshakeDeps | undefined
  if (message.link === true) {
    const sessionStorage = worldStorage ?? memoryStorage()
    const sessionWorldId = runningWorldId ?? 'local'
    const sessions = await loadSessionTable(sessionStorage, worldKeys(sessionWorldId))
    const gameCfg = message.config.game as { buildHash?: string } | null
    handshake = {
      // 0013: "single-player uses the same path with an empty key" -- `WorldConfig.joinKey` is not
      // threaded into a linked-but-unpersisted sim worker's own config this milestone (Non-scope:
      // remote/multi-player join keys are M29's), so this mirrors the client's own always-empty
      // `joinKey: ''` for this topology (`client.ts`'s `clientGame`, Scope).
      joinKey: '',
      maxPlayers: 8,
      buildHash: parseBuildHash32(gameCfg?.buildHash ?? ''),
      sessions,
    }
  }
  // docs/plan/28b-reconnect-and-lifecycle.md step 4 gate fix (real CI regression, found live):
  // "a test/dev page normally never calls [`start()`]" (this file's own module doc comment, and
  // the `simHost.start()` gate below) used to be the *only* thing standing between a test/dev page
  // and real-time `AtomicsTimer` pacing -- true right up until step 4 added `host.resume()`'s own
  // "a Hello while paused resumes the timer" call (`server.ts`'s `pumpHandshakes`, 0013 "A new
  // connection resumes the timer"), reached through this file's own real handshake (wired since
  // M28's own step 5, above) on every connection's first `Hello`, on a *fresh* `SimHost` that has
  // never called `start()` at all (`running` starts `false` regardless of `message.test`) --
  // bypassing the gate below entirely and arming the real timer for every real-handshake test page,
  // racing `onFire`'s own catch-up loop against `CB_SIM_STEP_REQ`-driven ticks (`connected-terrain.
  // spec.ts`'s `overlay_tile_reaches_screen`, CI-only under `GC_MODE=software`: extra, real-time
  // ticks landed between the test's own explicit `stepTick(0)` calls, painting tile (0, 0) before
  // its own "strictly before any host tick" checkpoint; several `gc`-suite `neg object` controls
  // failed the same way, an unexpected tick inside their own measured window). `SimHost.resume()`
  // and `.start()` both call the same `arm()` (`server.ts`), which just calls whatever `timer.
  // every()` it was given -- so the fix is the same decision `simHost.start()`'s own gate already
  // makes, reused for *which timer service* this `SimHost` is even built with, not only for whether
  // `start()` happens to be called: a test/dev page that never opts into `test.pace` gets a no-op
  // `timer.every()` (`net-harness.ts`'s own stub precedent), so `resume()`/`start()`/`arm()` still
  // run and flip `running`/`paused` correctly (`CB_SIM_STEP_REQ`-driven ticking, and every other
  // pure-bookkeeping reader of `running`, is unaffected), but never register a real callback with
  // `atomicsTimer` -- exactly the pre-existing invariant every test/dev page already relied on
  // before step 4, restored for the one path (`resume()` from a fresh, never-`start()`ed `SimHost`)
  // step 4 did not know it needed to preserve.
  const pacingEnabled = !message.test || message.test.pace === true
  const timer = pacingEnabled ? atomicsTimer.timer : { every: () => () => {} }
  const simHost = createSimHostFromInstance(
    simInstance,
    { clock: systemClock, timer, scheduler: systemScheduler },
    persistence,
    initialTicksRun,
    recoveryDeps,
    handshake,
  )
  // docs/plan/24-recovery-and-migration.md: the fatal report, through M06b's `shell.fatal`, with the
  // tick prefixed (Scope: "wiring into ... the sim worker (fatal report via `shell.fatal` with the
  // tick prefixed)").
  // docs/plan/37-robustness-events.md step 3: the world is wedged (or its storage failed), which is
  // not the worker dying. Say so with `sim-fatal` (main raises `client.onFatal`) and stay alive: the
  // body below runs no more ticks, no file is touched, and `exportWorld` still reaches the storage.
  let fatalSeen = false
  simHost.onFatal = (f) => {
    fatalSeen = true
    shell.post({ type: 'sim-fatal', tick: f.tick, message: f.message })
  }
  // docs/plan/28b-reconnect-and-lifecycle.md step 2 (0005 Panic recovery 2): the same per-call-site
  // wiring `server.ts`'s own `createWorldServer` uses -- every successful `recover()` (a live panic,
  // during single-player play) bumps the epoch and resyncs the one linked connection with it.
  simHost.onRecovered = () => {
    simHost.bumpEpoch()
    simHost.resyncAll()
  }
  // docs/plan/24b-upgrade-and-migration.md: fired once, for the upgrade `Persistence.open` itself
  // just performed (never a post-panic recovery) -- the real production handler just wired above
  // is already live by the time this runs, so this is not a no-op (only relevant here since
  // load-time `Persistence.open` decides the upgrade path before any connection exists to resync --
  // `resyncAll()` itself is a no-op with none open yet).
  // docs/plan/37-robustness-events.md step 2: this worker replaces one that died. The ordinary load
  // path above has already run (snapshot and log tail); a new session epoch tells the clients their
  // old one is over (0005 Panic recovery 2).
  if (message.respawn === true) simHost.bumpEpoch()
  if (openedUpgrade) {
    simHost.onRecovered?.({
      reason: 'upgrade',
      tick: initialTicksRun,
      skipped: openedUpgrade.droppedTailRecords,
    })
  }

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
  if (connection && message.respawn === true) connection.skipUplinkUntilFirstByte(MAGIC & 0xff)
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
  // Same `pacingEnabled` decision the `timer` passed to `createSimHostFromInstance` above already
  // made (kept as one flag, not two independent conditions that could drift).
  if (pacingEnabled) simHost.start()

  // `TestFlags.killSimWorkerAtTick` / `failStorageAtTick` (docs/plan/37-robustness-events.md): the
  // first listed tick is this worker's; `client.ts` hands a respawned worker the rest.
  const killAtTick = asNumberList(message.test?.killSimWorkerAtTick)?.[0] ?? null
  const failStorageAt = message.test?.failStorageAtTick ?? null
  let storageFailed = false
  const leakyAppendArmed = message.test?.leakyStorageAppend === true
  // M36's bench HUD (`CB_SIM_TICK_US`); only a bench page's setup carries it.
  const timing = message.test?.timing === true

  function body(wokenBy: number): void {
    if (fatalSeen) {
      // A wedged world runs nothing more (and may be woken by a stray ring push): ack and return.
      Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
      return
    }
    try {
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
      if (timing) {
        // M36's bench HUD: the duration of a pass that ran a tick (admit and frames included),
        // stored before `CB_SIM_TICKS_RUN` so main never reads a count ahead of its duration.
        const ticksBefore = simHost.counters.ticksRun
        const t0 = systemClock.now()
        if (wokenBy === lastWokenBy) atomicsTimer.poll()
        else atomicsTimer.interrupt()
        if (simHost.counters.ticksRun !== ticksBefore) {
          Atomics.store(
            shell.control.words,
            CB_SIM_TICK_US,
            Math.round((systemClock.now() - t0) * 1000),
          )
        }
      } else if (wokenBy === lastWokenBy) atomicsTimer.poll()
      else atomicsTimer.interrupt()
      lastWokenBy = wokenBy
      Atomics.store(shell.control.words, CB_SIM_TICKS_RUN, simHost.counters.ticksRun)
      Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
      if (failStorageAt !== null && !storageFailed && simHost.counters.ticksRun >= failStorageAt) {
        // What a failing OPFS write reports (0005 Storage): `Storage.onError`, which `Persistence`
        // forwards to `SimHost`, which raises `onFatal`.
        storageFailed = true
        worldStorage?.onError?.(new Error('failStorageAtTick: injected storage failure'))
      }
      if (killAtTick !== null && simHost.counters.ticksRun >= killAtTick) {
        // As if an uncaught error had ended this worker (`TestFlags.killSimWorkerAtTick`): main sees a
        // `fatal` after `ready`, which for the sim worker means respawn. The wake is already acked.
        shell.fatal(`killSimWorkerAtTick: sim worker killed at tick ${simHost.counters.ticksRun}`)
        return
      }
      // Planning decision 2, wired for real (M23 fix round 1: `shell.runAsync` now actually leaves
      // this pass's own enclosing loop instead of starving `fn` -- see `worker/shell.ts`). Polled after
      // every pass, cheap on the (overwhelmingly common) `null` read: `pendingAsync()` itself allocates
      // nothing (`opfs.ts`'s own doc comment), and `fn` here is a closure `write()` already built, not
      // one created by this call (`.claude/rules/hot-paths.md`).
      const pending = opfsAdapter?.pendingAsync()
      if (pending) shell.runAsync(pending)
      // docs/plan/28-sessions-and-reconnect.md step 5 (`SimHost.hasInFlightHandshakes`'s own doc
      // comment has the mechanism): the exact same "leave the Atomics.wait-blocked loop, await,
      // re-enter" pattern as `pendingAsync()` above, for a secret digest/session-table write a
      // valid `Hello` just started off this same pass (`connection.drainUplink()`, above).
      if (simHost.hasInFlightHandshakes) {
        shell.runAsync(() => simHost.handshakesSettled())
      }
    } catch (e) {
      // docs/plan/24-recovery-and-migration.md (0005 Panic recovery 2): a trap anywhere in this
      // pass (an admit, a tick, a snapshot -- any `SimInstance`/`Persistence` call whose underlying
      // export threw) no longer falls through to `runBlockingLoop`'s own `shell.fatal` catch
      // (`worker/shell.ts`'s `runBodyOnce`): it is caught here first and handed to `SimHost.
      // recover()`, off the blocking loop (`shell.runAsync`, sanctioned for exactly this: "leaves
      // the blocking loop, awaits `fn`, then re-enters it"). `recover()` itself reports `onFatal`
      // (wired above, to `shell.fatal`) when it gives up; a successful recovery needs no further
      // action here -- the next real wake resumes ticking on the fresh instance.
      if (!(e instanceof EngineTrap)) throw e
      // This wake is still acked (same two stores the happy path ends with, above): recovery
      // continues asynchronously from here, but a caller waiting on this exact wake's own `W_ACK`
      // (`engine/test`'s `stepSimTickSync`) must not spin until it hits its own timeout only
      // because this pass happened to be the one that discovered the trap.
      Atomics.store(shell.control.words, CB_SIM_TICKS_RUN, simHost.counters.ticksRun)
      Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
      shell.runAsync(async () => {
        await simHost.recover()
      })
    }
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
      return handleTestCall(recoveryDeps.instance, m)
    },
  }
}
