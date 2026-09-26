// Messages between `client.ts` (main) and `worker.ts`'s `run()` (docs/plan/06b-workers-and-spawn.md,
// Seams: "the only steady use of postMessage besides fatal and resume"). Types only, erased at
// compile time.
import type { InstanceConfig } from '../loader.js'
import { WORKER_GEN1 } from '../sab/control.js'
import type { SabSet } from '../sab/layout.js'
import type { WorldConfig } from '../sim-config.js'

export type WorkerKind = 'client' | 'sim' | 'gen' | 'net'

/** The isolate name budgets and controls use (docs/plan/06b-workers-and-spawn.md, orchestrator
 * decision 1): `'client' | 'sim' | 'gen0' | 'gen1' | 'net'`; `'main'` is reserved for the page
 * thread. Shared by `worker.ts` (sets `self.__engineIsolateName`) and `test/client.ts`'s
 * `asHarness` (names `Harness.workerNames` the same way), so a CDP `Runtime.evaluate` of
 * `self.__engineIsolateName` always agrees with what the test driver expects. */
export function isolateName(kind: WorkerKind, index: number): string {
  if (kind === 'gen') return index === WORKER_GEN1 ? 'gen1' : 'gen0'
  return kind
}

/** Test-only behaviour carried in the setup message, never read by a production build that omits
 * `engine/test` (docs/plan/06b-workers-and-spawn.md, Consumes: M04's `gcHook`). */
export type TestFlags = {
  /** Drives the `echo` zero-GC page's SAB -> region -> region -> SAB round trip (Tests added). */
  echo?: boolean
  /** `false` exercises the URL fallback (the worker calls `instantiateStreaming` itself) instead
   * of a posted `Module` (Planning decisions "Posted `Module` first, URL as fallback"). */
  postModule?: boolean
  /** M04's negative-control hook (`applyStepControl`), applied once per tick/frame this worker
   * runs, read fresh from the control block's `Control` word set up the same way `step-block.ts`
   * does it for the test harness. */
  gcHook?: boolean
  /** `worker/sim.ts` only (docs/plan/13b-tick-timing-allocation.md, Order of work 1): arms
   * `simHost.start()` (real-time pacing, `onFire` via `AtomicsTimer`) even though `test` is
   * present, so a zero-GC page can prove the production pacing path itself is allocation-free --
   * distinct from the blanket `!message.test` gate M13 built, which a page still driving ticks
   * deterministically through `CB_SIM_STEP_REQ` (`gc-sim.ts`) must keep clear of (Deviations: why
   * arming both at once is safe for a page that never asserts a resulting hash). */
  pace?: boolean
  /** `worker/sim.ts` only (docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4,
   * `no_opfs_falls_back_durable_false`): skips the OPFS probe entirely and opens with
   * `memoryStorage()`/`durable: false` directly, the same outcome a real OPFS-less browser would
   * reach -- deterministic (no dependency on whether a test's own OPFS stub reaches the worker's own
   * global scope), unlike stubbing `navigator.storage.getDirectory` from outside the page. */
  noOpfs?: boolean
  /** `worker/sim.ts` only (docs/plan/23-persistence-opfs-and-lifecycle.md, coordinator fix round
   * 1): overrides `PersistenceOptions.snapshotEveryTicks` (default 1,200, 0005 Cadence) so a real,
   * continuously-paced behavioural test can observe several periodic OPFS snapshots inside a few
   * seconds instead of 1,200 real ticks at 20 Hz. */
  snapshotEveryTicks?: number
  /** `worker/sim.ts` only (docs/plan/23-persistence-opfs-and-lifecycle.md step 6,
   * `neg_control_snapshot_allocates`): wraps the persisted world's own `Storage.append` so every
   * call also allocates one throwaway object, and forces one synthetic `append` call per real tick
   * (to a dummy debug key `Persistence`/the game never touch) so the control actually trips every
   * tick regardless of whether that tick's own gameplay produced a loggable frame (0029: a control
   * that never fires is a defect in the instrument, never something to fix by widening). Sim worker
   * only, by construction (no other kind ever gets `message.world`). */
  leakyStorageAppend?: boolean
}

export type SetupMessage = {
  type: 'setup'
  kind: WorkerKind
  /** This worker's index into the control block (`sab/control.ts`'s `WORKER_*` constants). */
  index: number
  /** Posted by default (Planning decisions); absent when `test.postModule === false`. */
  module?: WebAssembly.Module
  /** Present only when `module` is absent: the worker calls `instantiateStreaming` itself. */
  wasmUrl?: string
  sabs: SabSet
  config: InstanceConfig
  test?: TestFlags
  /** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: the real `WorldConfig` a persisted
   * single-player world was opened with, present only for the `sim`-kind spawn and only when
   * `ClientOptions.host = { kind: 'local', persist: true, ... }` (`client.ts`'s `start()`) --
   * additive, like `link` below: no existing `sim`-kind test page sets `host.persist`, so none of
   * them gain this field or the OPFS/Web-Lock startup order it gates in `worker/sim.ts`. Only the
   * three fields `Persistence.open`/`worldKeys` actually need, not the full `ClientOptions.host.world`
   * (`params` is stored verbatim in the manifest; `buildHash` feeds `sim_segment_header`'s identity
   * indirectly through `engine_init`, already carried by `config`, but `Persistence` also keeps its
   * own JSON copy for `ManifestV1.created`/`.params`). */
  world?: { worldId: string; buildHash: string; params: WorldConfig['params'] }
  /**
   * docs/plan/15b-ring-connection-and-replica-rendering.md, Orchestrator ruling 1: whether this
   * topology's `sim`/`client` link the uplink/downlink ring pair -- a topology fact carried on
   * the setup message both of them receive identically, not a `test`-scoped flag (`TestFlags`
   * above is explicitly test-only; this is real production config, present or absent whether or
   * not `test` is). `true` only when `ClientOptions.host` is `{ kind: 'local', connect: true,
   * ... }` (`client.ts`'s `start()`); absent/`false` on every existing `sim`-kind test page
   * (Planning decisions "sim-kind pages keep zero-connection topology by construction": those
   * pages never set `host.connect`, so they get the default -- no flag to remember, nothing to
   * turn off). `worker/sim.ts`'s `setup()` creates and accepts a `RingConnection` only when this
   * is `true`; `worker/client.ts`'s `setup()` builds its own net pump (downlink drain, uplink
   * poll) only then either. Ignored by `gen`/`net`.
   */
  link?: boolean
}

/**
 * Main -> worker, parked-only: one generic test-gated call channel (docs/plan/
 * 08b-gen-workers-and-queue.md, orchestrator decision 1 at the step-5 boundary), used by
 * `engine/test`'s `callParked` instead of a new `SabSet` field or a query-specific message. `a`/`b`
 * are the export's arguments in order (0 or 2 args covers every export named by this milestone;
 * `undefined` means "not passed", not "pass 0"). Answered only by a worker whose setup message
 * carried `test` (`worker/test-call.ts`) and only while it is parked (a worker blocked in
 * `Atomics.wait` receives no events, 0015 §2).
 */
export type TestCallMessage = {
  type: 'test-call'
  id: number
  name: string
  a?: number
  b?: number
  resultBytes?: number
}

/**
 * `SIM_COUNTERS_CALL`: the `test-call` `name` `worker/sim.ts`'s own `testCall` handler answers
 * directly instead of forwarding to `handleTestCall` (docs/plan/13-sim-host-tick-loop.md, step 5):
 * `SimHostCounters` is JS-side `SimHost` state, not an ABI export `handleTestCall` could ever reach
 * through `EngineInstance`. Leading double underscore, same convention as `worker.ts`'s own
 * `__engineWorkerKind`/`__engineIsolateName` debug globals: never a real ABI export name, so it can
 * never collide with one. Shared here (not duplicated) so `worker/sim.ts` and `test/client.ts`'s
 * `simCounters` agree on the exact string without either importing the other. */
export const SIM_COUNTERS_CALL = '__sim_counters'
/** Byte layout `simCounters` decodes: five little-endian `u32`s, `SimHostCounters`'s own field
 * order (`server.ts`). */
export const SIM_COUNTERS_BYTES = 20

/** `worker/sim.ts`'s own `testCall` handler (docs/plan/15b-ring-connection-and-replica-
 * rendering.md, `engine/test`'s `netCounters`): the one piece of a linked connection's own JS-side
 * counters with no ABI export at all (`RingConnection.downlinkRetries`) -- `sim_conn_counters`
 * (the `host::ConnCounters` half) is a real ABI export instead, reached through `callParked`
 * directly by name. Same naming convention as `SIM_COUNTERS_CALL`. */
export const NET_COUNTERS_CALL = '__net_counters'
/** One little-endian `u32`: `RingConnection.downlinkRetries`. */
export const NET_COUNTERS_BYTES = 4

/** docs/plan/23-persistence-opfs-and-lifecycle.md, coordinator fix round 1: a minimal, page-local
 * debug call for the periodic-OPFS-snapshot behavioural test (`world.spec.ts`'s own
 * `paced_session_lands_periodic_snapshots`) -- `Persistence.counters` plus the OPFS adapter's own
 * `snapshotDeferred` (`OpfsStorage`, Planning decision 2), neither reachable through an ABI export.
 * Same naming convention as `SIM_COUNTERS_CALL`; scoped to this one test, not exported from
 * `engine/test` -- step 6's own `persistenceCounters()` (Seams, for steps 5-7) is the real, public
 * seam and may replace this call entirely. */
export const PERSISTENCE_DEBUG_CALL = '__persistence_debug'
/** Six little-endian `u32`s: `PersistenceCounters`'s own field order (`logBytes`, `frames`,
 * `snapshots`, `lastSnapshotBytes`, `syncs`), then `snapshotDeferred`. */
export const PERSISTENCE_DEBUG_BYTES = 24

/** docs/plan/23-persistence-opfs-and-lifecycle.md Seams (Provides): `client.onStorage`'s own
 * argument shape, verbatim. Declared here (not in `client.ts`) so `SimLifecycleMessage` below can
 * reference it without `worker/protocol.ts` importing `client.ts` (which already imports this file
 * -- a cycle); `client.ts` re-exports it unchanged, the same "no renamed Provides" convention
 * `sim-config.ts`'s/`storage/types.ts`'s own types already follow. */
export type StorageStatus = { durable: boolean; persisted: boolean; usage: number; quota: number }

/** Gate fix (docs/plan/23-persistence-opfs-and-lifecycle.md, "Open gate failures" 2): the one
 * `FromWorker` type posted before this worker's blocking loop ever starts (`worker.ts`'s own
 * `post({ type: 'ready' })`, right after `setup()` resolves) -- the worker -> main half of 0015 §2's
 * "setup" phase (the `Module`/SABs/config are the main -> worker half). Checked by
 * `protocol.test.ts`'s `postmessage_type_literals_are_allowlisted` against every `type: '...'` literal
 * found in `src/worker/**` and `worker.ts` (excluding this file's own type *declarations*, which name
 * both directions): this is what replaces the "M06b's grep criterion" this file used to just assert
 * "in prose", below. */
export const SETUP_PHASE_MESSAGE_TYPES: readonly string[] = ['ready']

/** Every `FromWorker` type a worker may post once its blocking loop has started (0015 §2: "fatal
 * errors and lifecycle", plus this milestone's own world-op results and every `test-call` reply) --
 * the other half of the allowlist `postmessage_type_literals_are_allowlisted` checks. */
export const POST_SETUP_MESSAGE_TYPES: readonly string[] = [
  'fatal',
  'test-result',
  'test-error',
  'storage',
  'start-failed',
  'export-world-result',
  'import-world-result',
  'delete-world-result',
  'world-op-error',
]

/** docs/plan/23-persistence-opfs-and-lifecycle.md Seams (Provides): the sim worker's own lifecycle
 * notifications beyond `ready`/`fatal` (0015 §2: `postMessage` after setup carries lifecycle only --
 * this milestone's own two new types, checked by name against `POST_SETUP_MESSAGE_TYPES` above, an
 * automated allowlist -- not, as an earlier draft of this comment put it, "M06b's grep criterion"
 * extended "in prose"; gate fix 2 replaced that one-time checklist line with a real test). `storage`
 * fires at load (Planning decision 5: "`client.onStorage` fires at load, after the `persist()`
 * answer, and after each hidden-boundary snapshot") -- `created` is not part of the pinned
 * `StorageStatus` shape itself (Seams gives that verbatim) but is carried alongside it so main knows
 * whether this world was just created (Planning decision 5's own gate: "only when `Persistence.open`
 * reported `created`") without a second round trip. `start-failed` is a start failure short of a
 * trap (`EngineStartError`'s new `'world-busy'` code, Seams): posted once, before the worker also
 * calls `shell.fatal` and dies (the world cannot be opened at all with the lock held elsewhere) --
 * `client.ts`'s `setupWorker` settles `client.ready`'s rejection from this message, ignoring the
 * `fatal` that follows once already settled. */
export type SimLifecycleMessage =
  | { type: 'storage'; status: StorageStatus; created: boolean }
  | { type: 'start-failed'; code: 'world-busy' | 'load-failed'; detail: string }

/** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: main -> sim worker, parked-only (like
 * `TestCallMessage`, whose own doc comment gives the reason: a worker blocked in `Atomics.wait`
 * receives no events, 0015 §2) -- the hidden/visible clean-boundary protocol. `client.ts` parks the
 * sim worker (`W_YIELD` + wake, polling `W_PARKED`) before sending `sim-pause`; the sim worker's own
 * `simControl` handler (`worker/sim.ts`) awaits `SimHost.pause()` there and posts a `storage` message
 * back as the pause's own completion ack (Planning decision 5), then stays parked. `sim-resume` needs
 * no separate park step (the worker is already parked from `sim-pause`): the handler calls
 * `SimHost.resume()` then `shell.resume()` itself, in one message, so main sends exactly one message
 * either way. */
export type SimControlMessage = { type: 'sim-pause' } | { type: 'sim-resume' }

/**
 * docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Rules and traps: main -> sim worker,
 * parked-only like `SimControlMessage` (same reason: a blocked worker receives no events, 0015 §2).
 * A *separate* family from `SimControlMessage`, not a third variant of it (Deviations: named here so
 * the choice is on the record) -- `client.ts` funnels *both* families through one FIFO queue on the
 * sim worker itself (`worker/sim.ts`'s own `enqueueWorldOp`) before either one ever touches
 * `SimHost`/`Storage`, so an export requested while a hidden-boundary pause is mid-flight (or the
 * reverse) is always well-defined: whichever request the worker's event loop saw first runs to
 * completion before the other starts, never interleaved. `export-world` always targets the running
 * world (no id: `client.exportWorld()` takes none, Seams); `import-world`/`delete-world` name an
 * arbitrary id via `worldId`, since OPFS's root is shared by every open adapter instance (`storage/
 * archive.ts`'s own doc comment) -- the running world's already-open handles are enough to reach any
 * other world's keys too, so no second `opfsStorage()` instance is ever opened for these.
 */
export type SimWorldOpMessage =
  | { type: 'export-world' }
  | { type: 'import-world'; bytes: Uint8Array; worldId?: string; overwrite?: boolean }
  | { type: 'delete-world'; worldId: string }

/** Sim worker -> main, one per `SimWorldOpMessage` (Seams: `client.exportWorld`/`importWorld`/
 * `deleteWorld`'s own promises settle from these). `bytes` on `export-world-result` is a fresh
 * `Uint8Array` (the packed archive), transferred back (`postMessage`'s transfer list) rather than
 * structured-cloned, matching Planning decision 6's "transfers the buffer back". */
export type SimWorldOpResult =
  | { type: 'export-world-result'; bytes: Uint8Array }
  | { type: 'import-world-result'; worldId: string }
  | { type: 'delete-world-result' }
  | { type: 'world-op-error'; message: string }

export type ToWorker =
  | SetupMessage
  | { type: 'resume' }
  | { type: 'stop' }
  | TestCallMessage
  | SimControlMessage
  | SimWorldOpMessage

export type FromWorker =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  /** `test-call`'s reply: `value` is the export's return value, `result` a copy of the first
   * `resultBytes` bytes of `Result` (empty when 0 or absent). */
  | { type: 'test-result'; id: number; value: number; result: Uint8Array }
  /** `test-call`'s reply for an unknown export, a missing instance (e.g. the `net` kind), or a
   * trap. */
  | { type: 'test-error'; id: number; message: string }
  | SimLifecycleMessage
  | SimWorldOpResult
