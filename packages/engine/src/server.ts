// The sim host (docs/plan/13-sim-host-tick-loop.md): one TypeScript module driving a `role=sim`
// instance identically in the sim worker and on a server (docs/decisions/0015 "Server" row) --
// only `Connection`, `Storage` and the clock differ. Shared module: no `node:`/DOM imports here
// (packages/engine/src/CLAUDE.md).
//
// Types `Connection`, `MsgClass`, `HostServices`, `WorldConfig`, `Storage` are declared exactly as
// docs/decisions/0009-transport-and-hosting.md / docs/decisions/0005-persistence-and-recovery.md.
// `storage` was unused through M13-M21b; docs/plan/22-persistence-log-and-snapshots.md steps 4-6
// make it real (`createSimHost` below builds a `Persistence` from it).

import { RegionId, Role, Status } from './abi.js'
import { Persistence } from './host/persistence.js'
import {
  Phase,
  RECOVERY_GOOD_TICKS_RESET,
  RECOVERY_LOOP_LIMIT,
  type RecoveryDeps,
  readProgressCursor,
  runPanicRecovery,
} from './host/recovery.js'
import type { EngineInstance } from './loader.js'
import { instantiate } from './loader.js'
import { buildSimInstanceConfig, type WorldConfig } from './sim-config.js'
import type { Storage } from './storage/types.js'

// `host/recovery.ts` (docs/plan/24-recovery-and-migration.md): re-exported unchanged, same
// "no renamed Provides" convention as the re-exports above.
export type { RecoveryDeps } from './host/recovery.js'
// `sim-config.ts`'s own pure helpers (Seams: no renamed Provides -- still `server.ts`'s own export
// surface, just built elsewhere so `client.ts` can import them without also importing `loader.ts`,
// `main.no_wasm_instantiate`'s own rule).
export { buildSimInstanceConfig, seedToHexU64, type WorldConfig } from './sim-config.js'
// `storage/archive.ts` (docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Seams: "TS functions
// from `engine/server`"): re-exported unchanged, same "no renamed Provides" convention.
export {
  ArchiveFormatError,
  deleteWorld,
  exportWorld,
  importWorld,
  WorldExistsError,
} from './storage/archive.js'
// `storage/types.ts`'s own home for `Storage`/`worldKeys` (docs/plan/
// 22-persistence-log-and-snapshots.md steps 4-6): re-exported unchanged, same "no renamed Provides"
// convention as the `sim-config.ts` re-exports above.
export type { Storage } from './storage/types.js'

// ---------------------------------------------------------------------------------------------
// 0009 / 0005 types, declared exactly (types only).
// ---------------------------------------------------------------------------------------------

export const MsgClass = { ReliableOrdered: 0, LatestWins: 1 } as const
export type MsgClass = (typeof MsgClass)[keyof typeof MsgClass]

export interface Connection {
  /** Engine-owned buffer, valid only during the call. */
  send(cls: MsgClass, bytes: Uint8Array): void
  close(code: number): void
  onMessage: ((bytes: Uint8Array) => void) | null
  onClose: ((code: number) => void) | null
  readonly datagrams: boolean
  readonly bufferedAmount?: number
}

export interface HostServices {
  wasm: WebAssembly.Module
  storage: Storage
  clock: { now(): number }
  timer: { every(ms: number, fn: () => void): () => void }
  onIdle?: () => void
}

// ---------------------------------------------------------------------------------------------
// Pacing constants.
// ---------------------------------------------------------------------------------------------

/** `host::MAX_CONNS` (`host::warm::MAX_VIEWS`, `crates/engine/src/host/mod.rs`): the sim role's
 * own fixed connection-table size, one cap reused rather than two (M15 Deviations). Not read from
 * config or any ABI export (docs/plan/15b-ring-connection-and-replica-rendering.md Deviations:
 * `ConnId` is a plain, host-picked `u32 < MAX_CONNS`, and `host::Host::connect` enforces this
 * bound itself with a native `assert!`) -- mirrored here as a plain constant, the same relationship
 * `DEFAULT_TICK_HZ` already has to `TickRate::HZ_20`. */
export const MAX_CONNS = 8

/** 0005 "Idle pause is replay-safe": "the host runs at most 5 catch-up ticks per wakeup". */
export const MAX_CATCHUP_TICKS = 5
/** 0008 §2 "Sim host warmer": the between-tick warm budget. */
export const WARM_BUDGET_MS = 2
/** docs/plan/13b-tick-timing-allocation.md (ADR amending M13): how many ticks pass between the
 * real clock reads that drive `tickOverruns`/`ticksDropped`/the chunk warmer -- see `resync`'s own
 * doc comment for why this number and the byte math behind it. */
export const RESYNC_TICKS = 8

/**
 * `Game::TICK_RATE`'s own default (`TickRate::HZ_20`, 0006). 0009 fixes tick rate as "a compile-
 * time constant of the game crate ... not config", so `WorldConfig` carries no such field; instead
 * `SimHost` reads the real rate once, at construction, from the `tick_hz` ABI export (`Instance::
 * tick_hz`, `Host<G>`/`GameInstance<G>` overriding the trait's `20` default with `G::TICK_RATE.
 * hz_value()`) -- a game that never overrides `TICK_RATE` still gets exactly 20. Kept here only as
 * the fallback tick rate `createSimHostFromInstance` rounds to whole milliseconds from
 * (`Math.round(1000 / hz)`, "the pacing arithmetic stays in integer milliseconds").
 */
const DEFAULT_TICK_HZ = 20

// ---------------------------------------------------------------------------------------------
// `SimInstance`: the sim-role export surface `SimHost` drives.
// ---------------------------------------------------------------------------------------------

/**
 * A thin, easily-fakeable seam over the sim-role ABI exports, distinct from the full
 * `EngineInstance` (`call0`/regions/`mem`/...). "a fake instance under Vitest" (Tests added, step
 * 2 of docs/plan/13-sim-host-tick-loop.md) means a hand-written object shaped like this, not a
 * hand-rolled `EngineInstance`; `wrapEngineInstance` below is the real adapter step 3's
 * WASM-under-Node test drives instead.
 */
export interface SimInstance {
  /** `Status` (numeric). */
  simGenesis(): number
  /** `Status` (numeric). */
  simTick(): number
  /**
   * `sim_seal_frame()`'s result: `len === 0` when there is nothing to log (Non-scope this
   * milestone: `sim_seal_frame` always returns 0, M22 gives it real content); `bytes` is present
   * and has `len` elements only when `len > 0` -- a view valid only during the call (0005's own
   * `Storage.append` contract, which this feeds).
   */
  simSealFrame(): { len: number; bytes?: Uint8Array }
  /** 16-digit lowercase hex, `EngineInstance.readU64Hex`'s own format. */
  simHash(): string
  /** `1` if a chunk was generated, `0` if nothing was cold. */
  simWarmOne(): number
  /** `Instance::tick_hz`'s own value ("20 Hz is hardcoded" gap): `G::TICK_RATE.hz_value()` for a
   * real game, `20` (the trait default) for anything that never overrides it. Read once, by
   * `createSimHostFromInstance`, at construction -- not on every tick. */
  tickHz(): number
  /** docs/plan/15b-ring-connection-and-replica-rendering.md: admits `conn` into the sim role's
   * connection table (`sim_connect`, forwarding to `host::Host::connect`). `Status` (numeric). */
  simConnect(conn: number): number
  /** docs/plan/24-recovery-and-migration.md, Traps ("Connections stay open across recovery"):
   * re-attaches `conn` (`sim_reattach`, forwarding to `host::Host::reattach`) with the same
   * deterministic `PlayerId` a live `simConnect` would assign, but queues no `Record::Player` event
   * and touches no game state -- recovery's own call, distinct from `simConnect`. `Status`
   * (numeric). */
  simReattach(conn: number): number
  /** docs/plan/24-recovery-and-migration.md fix round 1 (Planning decisions 2): queues
   * `Rejected(Engine(EngineFault))` for `seq` directly onto `conn`'s own (already-reattached)
   * connection and raises its dedup floor to at least `seq` (`sim_fault_ack`, forwarding to
   * `host::Host::fault_ack`). `Status` (numeric); tolerates an unknown `conn`. */
  simFaultAck(conn: number, seq: number): number
  /** docs/plan/15b-ring-connection-and-replica-rendering.md: frees `conn`'s slot (`sim_disconnect`,
   * `host::Host::disconnect`). `Status` (numeric); tolerates an unknown/already-freed `conn`. */
  simDisconnect(conn: number): number
  /** docs/plan/15b-ring-connection-and-replica-rendering.md: copies `bytes` (the whole buffer --
   * only its first `len` bytes are read on the Rust side, `Host::sim_admit`'s own contract) into
   * the sim role's own `Rx` region and calls `sim_admit(conn, len)`. `Status` (numeric). */
  simAdmit(conn: number, bytes: Uint8Array, len: number): number
  /** docs/plan/15b-ring-connection-and-replica-rendering.md: builds `conn`'s frame into the sim
   * role's own `Tx` region (`sim_build_frame`), returning its byte length (`0` = nothing to say,
   * `Host::build_frame`'s own "nothing to say" convention) -- throws on a negative/error status,
   * the same convention `simSealFrame` uses for `sim_seal_frame`. `bytes` is a view over the `Tx`
   * region valid only until the next call that touches it (the same "engine-owned buffer" contract
   * 0009's `Connection.send` already carries); present only when `len > 0`. */
  simBuildFrame(conn: number): { len: number; bytes?: Uint8Array }
  /** docs/plan/15b-ring-connection-and-replica-rendering.md: the sim role's own `Rx`/`Tx` region
   * capacities in bytes, read once so a `RingConnection`'s preallocated buffers can be sized to
   * match exactly instead of a magic number duplicated between Rust and TS. `0` when the region is
   * absent (a role/instance with no such region, e.g. a hand-rolled fixture `SimInstance`). */
  rxBytes(): number
  txBytes(): number
}

/** The real adapter: `SimInstance` over a real `EngineInstance` (role `Sim`). */
export function wrapEngineInstance(inst: EngineInstance): SimInstance {
  // Preallocated once, mutated and returned by reference on every `simSealFrame()` call
  // (`.claude/rules/hot-paths.md`: "preallocate scratch objects at init and mutate them"; step 6's
  // own zero-GC page, `gc-sim.ts`, is what found a fresh `{ len: 0 }` object literal here costing
  // ~16 B/frame -- every tick this milestone ever runs, since `sim_seal_frame` always returns 0
  // until M22, Deviations). `bytes` is only ever read synchronously, inside `runOneTick`'s own
  // call, matching its own doc comment ("a view valid only during the call"), so overwriting it in
  // place on the next call is safe.
  const sealResult: { len: number; bytes?: Uint8Array } = { len: 0 }
  // Same discipline as `sealResult` above, for `simBuildFrame` (docs/plan/
  // 15b-ring-connection-and-replica-rendering.md): one object, mutated in place every call.
  const frameResult: { len: number; bytes?: Uint8Array } = { len: 0 }
  return {
    simGenesis: () => inst.call0(inst.x.sim_genesis),
    simTick: () => inst.call0(inst.x.sim_tick),
    simSealFrame: () => {
      const raw = inst.call0(inst.x.sim_seal_frame)
      if (raw < 0) throw new Error(`sim_seal_frame failed: status ${-raw}`)
      if (raw === 0) {
        sealResult.len = 0
        delete sealResult.bytes
        return sealResult
      }
      const region = inst.region(RegionId.Persist)
      if (!region) throw new Error('sim_seal_frame: len > 0 but the Persist region is absent')
      sealResult.len = raw
      // The whole persistent region view (created once by `inst.region()`, `.claude/rules/
      // hot-paths.md`), not `region.u8.subarray(0, raw)`: the real length travels alongside on
      // `.len`, exactly like `simAdmit`'s own "whole buffer, real length as a separate number"
      // discipline (`ring-connection.ts`'s own copy-discipline doc comment, `src/CLAUDE.md`).
      sealResult.bytes = region.u8
      return sealResult
    },
    simHash: () => {
      const status = inst.call0(inst.x.sim_hash)
      if (status !== Status.Ok) throw new Error(`sim_hash failed: status ${status}`)
      return inst.readU64Hex(RegionId.Result, 0)
    },
    simWarmOne: () => inst.call0(inst.x.sim_warm_one),
    tickHz: () => inst.call0(inst.x.tick_hz),
    simConnect: (conn) => inst.call1(inst.x.sim_connect, conn),
    simReattach: (conn) => inst.call1(inst.x.sim_reattach, conn),
    simFaultAck: (conn, seq) => inst.call2(inst.x.sim_fault_ack, conn, seq),
    simDisconnect: (conn) => inst.call1(inst.x.sim_disconnect, conn),
    simAdmit: (conn, bytes, len) => {
      const region = inst.region(RegionId.Rx)
      if (!region) throw new Error('sim_admit: the Rx region is absent')
      // Whole fixed buffer, not `bytes.subarray(0, len)`: `sim_admit`'s own Rust-side contract
      // only ever reads the first `len` bytes of `Rx`, so copying the rest (unread garbage) costs
      // nothing but a `.set()` call (`.claude/rules/hot-paths.md`: never `subarray()` here).
      region.u8.set(bytes)
      return inst.call2(inst.x.sim_admit, conn, len)
    },
    simBuildFrame: (conn) => {
      const raw = inst.call1(inst.x.sim_build_frame, conn)
      if (raw < 0) throw new Error(`sim_build_frame failed: status ${-raw}`)
      if (raw === 0) {
        frameResult.len = 0
        delete frameResult.bytes
        return frameResult
      }
      const region = inst.region(RegionId.Tx)
      if (!region) throw new Error('sim_build_frame: len > 0 but the Tx region is absent')
      frameResult.len = raw
      // Orchestrator ruling 2: the whole persistent `Tx` region view, not `region.u8.subarray(0,
      // raw)` -- this branch is live every real tick once a connection exists (step 4), so it is
      // exactly what step 6's zero-GC panning window measures. `runOneTick`'s own `connection.
      // send(cls, bytes, len)` call is what carries `.len` past `Connection.send`'s fixed
      // `(cls, bytes)` shape (0009); `RingConnection.send`'s own optional third parameter reads it
      // instead of `bytes.length` when given.
      frameResult.bytes = region.u8
      return frameResult
    },
    rxBytes: () => inst.region(RegionId.Rx)?.len ?? 0,
    txBytes: () => inst.region(RegionId.Tx)?.len ?? 0,
  }
}

// ---------------------------------------------------------------------------------------------
// `SimHost`.
// ---------------------------------------------------------------------------------------------

export interface SimHostCounters {
  ticksRun: number
  ticksDropped: number
  tickOverruns: number
  chunksWarmed: number
  /**
   * A tick's own on-miss chunk generation (0008 §2 "Sim host, synchronous on cache miss"): no ABI
   * export surfaces this count to TS yet, so it stays 0 this milestone (Deviations records the
   * gap; nothing in Scope adds the export it would need).
   */
  genOnMiss: number
}

export interface SimHost {
  /** Runs `sim_genesis()` once (a second `start()` after `stop()` does not re-run it) and arms
   * the pacing timer. */
  start(): void
  /** docs/plan/22b-persistence-load-and-fs.md step 3: disarms the pacing timer, then (0005
   * Cadence: "at every clean boundary the host can detect") snapshots if dirty, prunes old
   * snapshots and awaits `flush()` when a `Persistence` is wired in -- resolves once everything is
   * durable. Counters are left as they are. A `SimHost` with no `persistence` (`worker/sim.ts`'s
   * own real topology, still unwired: this milestone's own Deviations) resolves immediately. */
  stop(): Promise<void>
  /** docs/plan/22b-persistence-load-and-fs.md step 3: disarms the pacing timer (0005: "a paused
   * host stops calling `sim_tick`, nothing is logged"), then the same snapshot-if-dirty/prune/flush
   * sequence as `stop()` (0013 World lifecycle: zero-player pause). The paused wall-clock interval
   * is invisible to `resume()`'s pacing. */
  pause(): Promise<void>
  /** Re-arms the pacing timer with a fresh resync anchor, so the interval `pause()` covered is
   * never counted as falling behind. */
  resume(): void
  /** Runs `n` ticks synchronously through the same tick procedure `onFire` uses, bypassing the
   * pacing timer entirely (a manual driver for tests and `engine/test`'s `stepTick`). */
  stepTick(n?: number): void
  hash(): string
  /**
   * docs/plan/24-recovery-and-migration.md (0005 Panic recovery 2-4): call this once the caller has
   * observed the current instance trap (an `EngineTrap` from any `SimInstance` call). Disarms
   * pacing, then re-derives a fresh instance from storage (`Persistence.recover`, reusing
   * `Persistence.loadLatest`); a repeat trap during that replay writes a `Skip` record and retries
   * (Planning decisions 1) or, if wedged (`Tick`/`OnPlayer`/`Replay`), reports `onFatal` and leaves
   * every file untouched. On success, re-attaches every still-open connection (`SimInstance.
   * simReattach`, no new log record, no game-state change) and resumes pacing if it was running
   * before. The loop guard (Planning decisions 3, `RECOVERY_LOOP_LIMIT`/`RECOVERY_GOOD_TICKS_RESET`
   * in `host/recovery.ts`) refuses a recovery attempt outright once too many have happened without
   * enough good ticks between them. Requires a `Persistence` and `recoveryDeps`
   * (`createSimHostFromInstance`'s own optional 5th argument) -- without either, every trap is
   * immediately fatal (nothing to recover from).
   */
  recover(): Promise<'resumed' | 'skipped' | 'fatal'>
  /** Fires exactly once per successful `recover()` call (`'upgrade'` is M24b's own reason; this
   * milestone only ever passes `'panic'`). `null` until set by the caller (`worker/sim.ts` leaves it
   * unset: M28b wires `bumpEpoch()`/`resyncAll()` here). */
  onRecovered: ((r: { reason: 'panic' | 'upgrade'; tick: number; skipped: number }) => void) | null
  /** Fires when `recover()` gives up (no persistence configured, the loop guard tripped, or the
   * world is wedged under this build). `null` until set by the caller (the sim worker maps this to
   * `shell.fatal` with the tick prefixed). */
  onFatal: ((f: { tick: number; message: string }) => void) | null
  /** docs/plan/23-persistence-opfs-and-lifecycle.md step 5: whether the pacing timer is currently
   * armed -- `worker/sim.ts`'s own export-request handler reads this to decide whether it needs to
   * `pause()`/`resume()` around a snapshot-for-export itself, or whether the world is already paused
   * (a hidden-boundary pause in flight or settled) and must be left exactly as it is. */
  readonly running: boolean
  readonly counters: SimHostCounters
  logSink: ((bytes: Uint8Array) => void) | null
  /**
   * docs/plan/15b-ring-connection-and-replica-rendering.md Scope: admits `connection` into the
   * sim role's connection table. Allocates the next free `ConnId` (0-based, `< MAX_CONNS`, the
   * same fixed cap `host::Host::connect` itself enforces), calls `sim_connect`, and wires
   * `connection.onMessage`/`onClose` so every uplink message this connection ever delivers reaches
   * `sim_admit` and a close reaches `sim_disconnect` automatically. Returns the `ConnId`. Throws if
   * every slot is already taken (single-player never exceeds one connection; a real capacity limit
   * for multiplayer is M27+, Non-scope here).
   *
   * The per-connection frame pass ("after each tick `sim_build_frame(conn)` -> `connection.send
   * (MsgClass.ReliableOrdered, view)` when `len > 0`", Scope) happens automatically, every tick,
   * for every accepted connection, from inside this host's own tick procedure -- nothing further
   * to call per connection once `accept` has returned.
   */
  accept(connection: Connection): number
}

type TimerServices = Pick<HostServices, 'clock' | 'timer'>

/** The shared implementation, over an already-built [`SimInstance`] -- real or fake.
 * `persistence` (docs/plan/22-persistence-log-and-snapshots.md steps 4-6) is optional so every
 * existing caller (`worker/sim.ts`'s own two-argument call, this file's own tests) keeps working
 * unmodified: when given, `logSink` is wired to `persistence.appendFrame` and `persistence.
 * afterTick(tick)` runs once per completed tick, right after `sim_tick()` succeeds. */
export function createSimHostFromInstance(
  sim: SimInstance,
  services: TimerServices,
  persistence?: Persistence,
  /** docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: seeds `counters.ticksRun` from a
   * `Persistence.open()` load's own `tick` result -- additive (a 4th optional parameter, default
   * `0`, every existing 3-argument caller unaffected), not a renamed seam. Without this, a reloaded
   * world's own `logSink`/`afterTick(counters.ticksRun)` call would restart counting from tick 0
   * (Deviations: real bug found here), clobbering `Persistence`'s own already-correctly-seeded
   * `this.tick` with a wrong, small value on the very first tick after a load -- corrupting every
   * `keys.snap(tick)` key it writes from then on. */
  initialTicksRun = 0,
  /** docs/plan/24-recovery-and-migration.md: enables `SimHost.recover()`. Optional, additive (a
   * 5th argument, every existing 2-4-argument caller unaffected) -- without it (or without
   * `persistence`), `recover()` always reports `onFatal` immediately (nothing to recover from). */
  recoveryDeps?: RecoveryDeps,
): SimHost {
  // Read once, here, not per tick (`SimInstance.tickHz`'s own doc comment): "the pacing arithmetic
  // stays in integer milliseconds" -- `Math.round`, not the raw division, so an odd rate (e.g. 30
  // Hz) still paces on a whole-millisecond boundary instead of carrying a fractional one through
  // the resync arithmetic below. `|| DEFAULT_TICK_HZ` covers only a `tickHz()` of `0` (division by
  // zero): a real ABI export never returns that (the trait default is `20`).
  const tickMs = Math.round(1000 / (sim.tickHz() || DEFAULT_TICK_HZ))
  const counters: SimHostCounters = {
    ticksRun: initialTicksRun,
    ticksDropped: 0,
    tickOverruns: 0,
    chunksWarmed: 0,
    genOnMiss: 0,
  }
  let genesisDone = false
  let running = false
  let stopTimer: (() => void) | null = null

  // docs/plan/24-recovery-and-migration.md, Planning decisions 3 (the loop guard): "more than 3
  // recoveries without 1,200 successfully ticked ticks in between is fatal". `recoveryCount` is how
  // many `recover()` calls have happened since the last time `goodTicksSinceRecovery` reached
  // `RECOVERY_GOOD_TICKS_RESET`; `runOneTick` (below) is the only place that increments the latter.
  let recoveryCount = 0
  let goodTicksSinceRecovery = 0
  // docs/plan/24-recovery-and-migration.md fix round 1 (Planning decisions 2): the `conn` whose own
  // `sim.simAdmit()` call is currently in flight, set right before the call and cleared right after
  // it returns normally -- so if it throws instead (an `Admit`-phase trap), this is left holding the
  // one piece of information only the *live* caller has (the Progress cursor's own `record` is the
  // `seq`, but never the `conn`): which connection was mid-admit when the instance died. `recover()`
  // reads and clears it every time, regardless of whether the trap actually turns out to be
  // `Admit`-phase (a trap during, say, `sim_tick()` never touches this in the first place).
  let inFlightAdmitConn: number | null = null

  // docs/plan/15b-ring-connection-and-replica-rendering.md: one slot per `ConnId`, `null` when
  // free. Reused array, sized once at construction (`.claude/rules/hot-paths.md`), never
  // reallocated: `accept`/a future disconnect only ever write existing slots.
  const conns: (Connection | null)[] = new Array(MAX_CONNS).fill(null)

  // docs/plan/13b-tick-timing-allocation.md (Deviations; ADR amending M13's per-tick decision):
  // `runOneTickTimed`'s own two `services.clock.now()` reads and `onFire`'s own one (below) each
  // boxed a fresh `HeapNumber` per tick in the interpreter tier -- a fractional double is never a
  // Smi, so no amount of JS-side care after the read removed it, and even one such read per tick
  // exceeds the strict 8 B/frame budget on its own (0016 §1: a guarantee that holds only when V8
  // wins a compilation race is not a guarantee). Fix: the real clock is read only once every
  // `RESYNC_TICKS` ticks (`resync`, below); between resyncs, a tick is assumed to cost exactly
  // `tickMs` and no clock is read at all. That assumption drifts by however long the tick's own
  // work actually took, bounded to at most `RESYNC_TICKS` ticks' worth before the next resync
  // measures the real elapsed time and erases it.
  /** Integer milliseconds (`Math.floor`, never a fractional double), the real clock's value at the
   * last resync -- every tick between resyncs is priced against this without reading the clock
   * again. Unset until the first tick ever runs (`syncInitialized`); `start()`/`resume()` clear it
   * so a paused interval is never counted as falling behind. */
  let syncBaseMs = 0
  let ticksSinceSync = 0
  let syncInitialized = false

  function ensureGenesis(): void {
    if (genesisDone) return
    const status = sim.simGenesis()
    if (status !== Status.Ok && status !== Status.AlreadyInitialised) {
      throw new Error(`sim_genesis failed: status ${status}`)
    }
    genesisDone = true
  }

  function ensureSyncBase(): void {
    if (syncInitialized) return
    syncBaseMs = Math.floor(services.clock.now())
    syncInitialized = true
  }

  /** The tick procedure (Scope: "one function, the only caller of the tick exports"): `len =
   * sim_seal_frame()`; if `len > 0` call `logSink`; `sim_tick()`; then the per-connection frame
   * pass (docs/plan/15b-ring-connection-and-replica-rendering.md Scope: "after each tick
   * `sim_build_frame(conn)` -> `connection.send(...)` when `len > 0`"), once per accepted
   * connection, in `ConnId` order. No clock read here any more (Deviations): a tick's own overrun
   * is no longer measured individually. */
  function runOneTick(): void {
    const seal = sim.simSealFrame()
    // `seal.bytes` is the whole persistent `Persist` region view (Orchestrator ruling 2), but
    // `logSink`'s own contract (`SimHost.logSink`'s doc comment: "exactly `len` bytes") is fixed at
    // one argument -- unlike `simBuildFrame`'s `bytes`+separate `.len` pair, `Storage.append`
    // (`Persistence.appendFrame`, docs/plan/22-persistence-log-and-snapshots.md steps 4-6) has no
    // second parameter to carry a real length past the whole-region view, so this is the one place
    // a `subarray()` is unavoidable rather than a `.claude/rules/hot-paths.md` violation waiting to
    // be found: it only ever runs on a tick that actually logged something (`seal.len > 0`), never
    // on an idle tick, and no zero-GC page wires a real `Storage` through this milestone (Non-scope:
    // that is whichever milestone first arms `Persistence` inside `worker/sim.ts`, flagged in this
    // milestone's own Deviations for that milestone to measure).
    if (seal.len > 0 && host.logSink) {
      host.logSink((seal.bytes as Uint8Array).subarray(0, seal.len))
    }
    const status = sim.simTick()
    if (status !== Status.Ok) throw new Error(`sim_tick failed: status ${status}`)
    counters.ticksRun++
    // docs/plan/24-recovery-and-migration.md, Planning decisions 3: "1,200 successfully ticked
    // ticks in between" resets the loop guard's own count -- every real completed tick counts,
    // whether or not it happened to log anything.
    goodTicksSinceRecovery++
    if (goodTicksSinceRecovery >= RECOVERY_GOOD_TICKS_RESET) recoveryCount = 0
    // docs/plan/22-persistence-log-and-snapshots.md steps 4-6: the tick procedure's own persistence
    // hook, right after `sim_tick()` succeeds -- `counters.ticksRun` is the same completed-tick
    // count `Persistence.afterTick`'s own doc comment names as its `tick` argument.
    persistence?.afterTick(counters.ticksRun)
    for (let conn = 0; conn < MAX_CONNS; conn++) {
      const connection = conns[conn]
      if (!connection) continue
      // `RingConnection.pumpRetries()`'s own doc comment (docs/plan/
      // 15b-ring-connection-and-replica-rendering.md): every tick, not only one whose
      // `simBuildFrame` produced a fresh frame -- otherwise a connection that once fell behind a
      // full downlink ring stays behind forever once the world goes idle (no more fresh frames to
      // piggyback a retry on). A generic 0009 `Connection` carries no such method; the same
      // optional-property pattern `SimHost.accept`'s own `onMessage` uses for `lastMessageLength`.
      const withRetries = connection as Connection & { pumpRetries?: () => void }
      withRetries.pumpRetries?.()
      const frame = sim.simBuildFrame(conn)
      if (frame.len > 0) {
        // `frame.bytes` is the whole persistent `Tx` region view (Orchestrator ruling 2), not a
        // per-tick `subarray`; `frame.len` is the real length, carried past `Connection.send`'s
        // fixed `(cls, bytes)` shape (0009) the same optional-property way `pumpRetries`/
        // `lastMessageLength` already do. A generic `Connection` that ignores the third argument
        // falls back to `bytes.length` (`RingConnection.send`'s own default), which would be wrong
        // here (`bytes` is the *whole* region) -- every real `Connection` this milestone builds is
        // a `RingConnection`, so this is always exercised with a real length.
        const withLen = connection as Connection & {
          send: (cls: MsgClass, bytes: Uint8Array, len?: number) => void
        }
        withLen.send(MsgClass.ReliableOrdered, frame.bytes as Uint8Array, frame.len)
      }
    }
  }

  /** Runs the chunk warmer for at most `WARM_BUDGET_MS` from `nowMs` (resync's own reading, already
   * an integer). docs/plan/16d-sim-pacing-under-external-wakes.md, CI round 3: the first chunk is
   * warmed on that reading rather than a fresh one, and the deadline stays an integer, so a resync
   * with nothing to warm reads the clock once (in `resync`) and boxes nothing else; each chunk
   * actually warmed costs one more read, to police the budget. Before this, every resync also read
   * the clock in this loop's condition and boxed a fractional `now + WARM_BUDGET_MS`, and a warming
   * backlog that happened to overlap a zero-GC window (on a slower runner) added a read per chunk
   * on top: `sim` read 8.64 B/frame on CI against the strict 8. */
  function warm(nowMs: number): void {
    const deadline = nowMs + WARM_BUDGET_MS
    for (;;) {
      if (sim.simWarmOne() !== 1) return
      counters.chunksWarmed++
      if (services.clock.now() >= deadline) return
    }
  }

  /** The only place `services.clock.now()` is read on the tick path (Deviations): compares real
   * elapsed time over the last `ticksSinceSync` ticks against what they were budgeted to cost.
   * Behind schedule, catches up to `MAX_CATCHUP_TICKS` extra ticks synchronously (M13's own cap,
   * evaluated once per resync window instead of once per wake) and drops the rest. `tickOverruns`
   * now counts a window that ran long as a whole, not an individual slow tick -- the ADR's own
   * "changed decision" line.
   *
   * `RESYNC_TICKS` (8) chosen by measurement (Deviations): one `clock.now()` read costs ~11.92 B in
   * the interpreter tier; this function's own read plus `warm`'s loop condition below read the
   * clock twice per resync (~23.84 B, the same order as the two-reads-per-tick figure this
   * replaces), which amortised over 8 ticks is 23.84 / 8 = 2.98 B/tick -- real margin under the
   * strict 8 B/frame budget for the rest of the loop's own overhead. At 20 Hz that is a 400 ms
   * resync window: bounded, self-correcting drift, versus an uncorrected one at any window size. */
  function resync(): void {
    // Floored once (CI round 3, `warm`'s doc comment): every value derived from it below stays an
    // integer, so the read's own box is the only allocation here.
    const now = Math.floor(services.clock.now())
    const expected = ticksSinceSync * tickMs
    const elapsed = now - syncBaseMs
    const overshoot = elapsed - expected
    let accountedTicks = ticksSinceSync
    let caughtUp = false
    if (overshoot > 0) {
      counters.tickOverruns++
      const behindTicks = (overshoot - (overshoot % tickMs)) / tickMs // exact: stays a Smi
      if (behindTicks > 0) {
        const runCount = Math.min(behindTicks, MAX_CATCHUP_TICKS)
        for (let i = 0; i < runCount; i++) runOneTick()
        caughtUp = runCount > 0
        const dropped = behindTicks - runCount
        if (dropped > 0) counters.ticksDropped += dropped
        accountedTicks += runCount + dropped
      }
    }
    syncBaseMs += accountedTicks * tickMs
    ticksSinceSync = 0
    // A window that had to catch up has already spent its idle time on ticks: no warming this time
    // (the old loop re-read the clock after the catch-up and usually found the budget gone).
    if (!caughtUp) warm(now)
  }

  /** Runs exactly one tick and resyncs against the real clock every `RESYNC_TICKS` ticks -- the one
   * function both `onFire` (armed pacing) and `stepTick` (manual/test driving) call, so a real
   * single-player session and `stepSimTickSync`-driven zero-GC coverage share one accounting path. */
  function runPacedTick(): void {
    ensureSyncBase()
    runOneTick()
    ticksSinceSync++
    if (ticksSinceSync >= RESYNC_TICKS) resync()
  }

  /** Pacing (Scope): `AtomicsTimer` calls this on every real wake while armed. It no longer checks
   * a deadline itself (`worker/atomics-timer.ts`'s own Deviations note says why the check moved) --
   * assuming every wake is one tick's worth of elapsed time is what `resync` corrects for. */
  function onFire(): void {
    runPacedTick()
  }

  function arm(): void {
    stopTimer = services.timer.every(tickMs, onFire)
  }

  function disarm(): void {
    if (stopTimer) {
      stopTimer()
      stopTimer = null
    }
  }

  const host: SimHost = {
    start() {
      if (running) return
      ensureGenesis()
      // A fresh resync anchor (Deviations): the first tick after this arms sets `syncBaseMs` from
      // real "now" at that moment, so neither the time this call itself took nor (on a second
      // `start()` after `stop()`) time spent stopped is ever counted as falling behind.
      syncInitialized = false
      ticksSinceSync = 0
      running = true
      arm()
    },
    async stop() {
      disarm()
      running = false
      persistence?.snapshotIfDirty()
      await persistence?.pruneSnapshots()
      await persistence?.flush()
    },
    async pause() {
      if (!running) return
      disarm()
      running = false
      persistence?.snapshotIfDirty()
      await persistence?.pruneSnapshots()
      await persistence?.flush()
    },
    resume() {
      if (running) return
      ensureGenesis()
      // Same reasoning as `start()`: a fresh anchor makes the paused wall-clock interval invisible
      // to pacing (0005 "Idle pause is replay-safe"), with no separate `pausedAt` bookkeeping needed
      // now that nothing computes a duration from it.
      syncInitialized = false
      ticksSinceSync = 0
      running = true
      arm()
    },
    stepTick(n = 1) {
      ensureGenesis()
      for (let i = 0; i < n; i++) runPacedTick()
    },
    hash() {
      return sim.simHash()
    },
    async recover() {
      const wasRunning = running
      disarm()
      running = false
      const trapTick = counters.ticksRun
      // Planning decisions 2: read (and consume) the *original* dead instance's own Progress
      // cursor and in-flight admit conn *before* anything below reassigns `recoveryDeps.instance`
      // to the fresh one -- this is the only place either is still readable. Consumed regardless of
      // what `phase` turns out to be (a trap unrelated to `Admit` leaves `admitConnAtTrap` at
      // whatever it already was -- always `null` in that case, since a live tick never runs inside
      // an `onMessage` call).
      const originalCursor = recoveryDeps ? readProgressCursor(recoveryDeps.instance) : null
      const admitConnAtTrap = inFlightAdmitConn
      inFlightAdmitConn = null
      if (!recoveryDeps || !persistence) {
        host.onFatal?.({
          tick: trapTick,
          message: 'recovery unavailable: no persistence configured for this world',
        })
        return 'fatal'
      }
      if (recoveryCount >= RECOVERY_LOOP_LIMIT) {
        host.onFatal?.({
          tick: trapTick,
          message: `recovery loop guard: more than ${RECOVERY_LOOP_LIMIT} recoveries without ${RECOVERY_GOOD_TICKS_RESET} ticked ticks in between`,
        })
        return 'fatal'
      }
      recoveryCount++
      goodTicksSinceRecovery = 0
      const result = await runPanicRecovery(persistence, recoveryDeps.newInstance)
      if (result.kind === 'fatal') {
        host.onFatal?.({ tick: result.tick, message: result.message })
        return 'fatal'
      }
      recoveryDeps.instance = result.sim
      sim = wrapEngineInstance(result.sim)
      genesisDone = true
      counters.ticksRun = result.tick
      // A fresh resync anchor, same reasoning as `start()`/`resume()`: the trap-and-recover
      // interval is never counted as falling behind.
      syncInitialized = false
      ticksSinceSync = 0
      // Traps ("Connections stay open across recovery"): every still-open connection is re-attached
      // to the fresh instance, no new log record, no game-state change (`Host::reattach`'s own doc
      // comment) -- its queued `EngineFault` ack (if any) then rides out on that connection's own
      // next `simBuildFrame` call, from the very next `runOneTick`.
      for (let conn = 0; conn < MAX_CONNS; conn++) {
        if (conns[conn]) sim.simReattach(conn)
      }
      // Planning decisions 2: an `Admit`-phase trap is never logged (0004: an admission rejection
      // is not a record at all), so replay never revisits it and `pending_fault_acks` (the
      // `ApplyRecord`/`Skip` case's own delivery mechanism) never sees it either -- this is the one
      // case recovery itself must queue the ack for, using what only the live caller ever knew
      // (`admitConnAtTrap`) plus what the dead instance's own Progress cursor recorded (`record` =
      // the `seq` being admitted, Seams). Runs *after* re-attach, since `sim_fault_ack` needs the
      // connection's own `ConnSlot` to already exist.
      if (originalCursor?.phase === Phase.Admit && admitConnAtTrap !== null) {
        sim.simFaultAck(admitConnAtTrap, originalCursor.record)
      }
      if (wasRunning) {
        running = true
        arm()
      }
      host.onRecovered?.({ reason: 'panic', tick: result.tick, skipped: result.skipped })
      return result.skipped > 0 ? 'skipped' : 'resumed'
    },
    onRecovered: null,
    onFatal: null,
    get running() {
      return running
    },
    counters,
    logSink: null,
    accept(connection: Connection): number {
      let conn = -1
      for (let i = 0; i < MAX_CONNS; i++) {
        if (!conns[i]) {
          conn = i
          break
        }
      }
      if (conn < 0) {
        throw new Error(`SimHost.accept: no free connection slot (MAX_CONNS = ${MAX_CONNS})`)
      }
      const status = sim.simConnect(conn)
      if (status !== Status.Ok) {
        throw new Error(`sim_connect failed: status ${status}`)
      }
      conns[conn] = connection
      connection.onMessage = (bytes) => {
        // A `RingConnection` hands the same preallocated receive buffer every call and carries the
        // real length on *its own* `lastMessageLength` (a side channel avoiding a per-message
        // `subarray()`, docs/plan/15b-ring-connection-and-replica-rendering.md Deviations), read
        // here synchronously (this callback runs inside `RingConnection.drainUplink`'s own loop,
        // before the next iteration overwrites it). A generic 0009 `Connection` (a future
        // socket-backed one, say) carries no such property, and `bytes.length` is then exactly the
        // message length, as the interface itself implies.
        const withLen = connection as Connection & { lastMessageLength?: number }
        const len = withLen.lastMessageLength ?? bytes.length
        // Planning decisions 2: `recover()`'s own only way to learn which connection an `Admit`-
        // phase trap happened on -- set immediately before the one call that can trap, cleared
        // immediately after it returns normally (never reached if it throws).
        inFlightAdmitConn = conn
        sim.simAdmit(conn, bytes, len)
        inFlightAdmitConn = null
      }
      connection.onClose = (_code) => {
        sim.simDisconnect(conn)
        conns[conn] = null
      }
      return conn
    },
  }
  // docs/plan/22-persistence-log-and-snapshots.md steps 4-6: `SimHost.logSink` is pointed at
  // `Persistence.appendFrame`, a fixed method value (`.claude/rules/hot-paths.md`: no per-call
  // closure), overriding the `null` the object literal above starts with.
  if (persistence) host.logSink = persistence.appendFrame
  return host
}

/** `createSimHost(cfg, services)` (Provides): instantiates a real `role=sim` instance from
 * `services.wasm`, builds a [`Persistence`] over `services.storage` (docs/plan/
 * 22-persistence-log-and-snapshots.md steps 4-6: "create world (manifest + segment 0)" happens
 * right here, once, before the host ever ticks), and drives both through
 * [`createSimHostFromInstance`]. */
export function createSimHost(cfg: WorldConfig, services: HostServices): SimHost {
  const inst = instantiate(services.wasm, Role.Sim, buildSimInstanceConfig(cfg))
  const persistence = Persistence.create(services.storage, cfg, inst)
  return createSimHostFromInstance(wrapEngineInstance(inst), services, persistence)
}
