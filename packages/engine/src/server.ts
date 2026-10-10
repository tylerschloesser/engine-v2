// The sim host (M13: one TypeScript module driving a `role=sim`
// instance identically in the sim worker and on a server (docs/decisions/0015 "Server" row) --
// only `Connection`, `Storage` and the clock differ. Shared module: no `node:`/DOM imports here
// (packages/engine/src/CLAUDE.md).
//
// Types `Connection`, `MsgClass`, `HostServices`, `WorldConfig`, `Storage` are declared exactly as
// docs/decisions/0009-transport-and-hosting.md / docs/decisions/0005-persistence-and-recovery.md.
// `storage` was unused through M13-M21b; M22 steps 4-6
// make it real (`createSimHost` below builds a `Persistence` from it).

import { RegionId, Role, Status } from './abi.js'
import type { Scheduler } from './clock.js'
import {
  ByeReason,
  buildAttachInput,
  buildBye,
  buildReject,
  CloseCode,
  MAGIC,
  ProtocolError,
  parseBuildHash32,
  parseBye,
  parseHello,
  RejectReason,
  rejectReasonCloseCode,
} from './host/handshake.js'
import { createLifecycleTracker } from './host/lifecycle.js'
import { Persistence } from './host/persistence.js'
import {
  Phase,
  RECOVERY_GOOD_TICKS_RESET,
  RECOVERY_LOOP_LIMIT,
  type RecoveryDeps,
  readProgressCursor,
  runPanicRecovery,
} from './host/recovery.js'
import {
  hashSecretHex,
  hexDecode,
  hexEncode,
  loadSessionTable,
  type SessionTable,
} from './host/sessions.js'
import type { EngineInstance } from './loader.js'
import { instantiate } from './loader.js'
import { readU32LE } from './sab/bytes.js'
import {
  PROFILE_CATCHUP,
  PROFILE_FRAME,
  PROFILE_RESYNC,
  PROFILE_SEAL,
  PROFILE_SLOTS,
  PROFILE_TICK,
} from './sab/control.js'
import { buildSimInstanceConfig, type WorldConfig } from './sim-config.js'
import type { Storage } from './storage/types.js'
import { worldKeys } from './storage/types.js'

// `host/recovery.ts` (M24: re-exported unchanged, same
// "no renamed Provides" convention as the re-exports above.
export type { RecoveryDeps } from './host/recovery.js'
// `sim-config.ts`'s own pure helpers (Seams: no renamed Provides -- still `server.ts`'s own export
// surface, just built elsewhere so `client.ts` can import them without also importing `loader.ts`,
// `main.no_wasm_instantiate`'s own rule).
export { buildSimInstanceConfig, seedToHexU64, type WorldConfig } from './sim-config.js'
// `storage/archive.ts` (M23 step 5, Seams: "TS functions
// from `engine/server`"): re-exported unchanged, same "no renamed Provides" convention.
export {
  ArchiveFormatError,
  deleteWorld,
  exportWorld,
  importWorld,
  WorldExistsError,
} from './storage/archive.js'
// `storage/types.ts`'s own home for `Storage`/`worldKeys` (M22 steps 4-6): re-exported unchanged, same "no renamed Provides"
// convention as the `sim-config.ts` re-exports above.
export type { Storage } from './storage/types.js'

// ---------------------------------------------------------------------------------------------
// 0009 / 0005 types, declared exactly (types only).
// ---------------------------------------------------------------------------------------------

export const MsgClass = { ReliableOrdered: 0, LatestWins: 1 } as const
export type MsgClass = (typeof MsgClass)[keyof typeof MsgClass]

/** A connection slot index (`host::ConnId`, Rust). Plain `number` here (0014 §2's own "numbers
 * only" convention has no room for a branded type across the boundary), named only so this file's
 * own handshake bookkeeping reads clearly. */
type ConnId = number

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
  /** M28b step 4: one-shot timers for the grace/idle world
   * lifecycle (`host/lifecycle.ts`) -- distinct from `timer.every` above, which paces the tick
   * loop alone and is stubbed to a no-op under `engine/test`'s harness (ticking is driven
   * manually there). Grace/idle timers must still fire deterministically under a virtual clock, so
   * they run on a real `Scheduler`: `systemScheduler` in production, the harness's own
   * `VirtualClock` (which *is* a `Scheduler`, `ManualClock`'s own shape) under test -- ".claude/
   * rules/determinism.md": "ticks are counted, never inferred from wall clock" applies to these
   * timers directly (a grace/idle deadline is host-clock time, not a counted tick, but it must
   * never silently skip or fire early under a virtual clock either). Optional (every pre-M28b test
   * double that builds a bare `{ clock, timer }` `HostServices` stays unmodified): a caller that
   * never dials `scheduler` in gets `noopScheduler` (below), under which no grace/idle timer this
   * milestone adds ever fires -- fine for every one of those callers, none of which exercises
   * reconnect or lifecycle at all. */
  scheduler?: Scheduler
  onIdle?: () => void
  /** 0024 §5 (amends 0009): fed from `SimHost.onFatal` (M24) once `createWorldServer` has a live
   * `SimHost` -- a load failure surfaces through `ready` rejecting instead (below), since it never
   * reaches a `SimHost` at all. */
  onFatal?: (f: { tick: number; message: string }) => void
}

/**
 * `createWorldServer`'s own return type (0024 §5, verbatim; amends 0009's synchronous `{ accept,
 * stop }`). `ready` rejects with `WorldLoadError` (`./host/persistence.js`) or any other error
 * `Persistence.open`/`instantiate` raised while loading -- loading is asynchronous, so
 * `createWorldServer` itself never throws synchronously.
 */
export interface WorldServer {
  ready: Promise<void>
  accept(c: Connection): void
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------------------------
// Pacing constants.
// ---------------------------------------------------------------------------------------------

/** `host::MAX_CONNS` (`host::warm::MAX_VIEWS`, `crates/engine/src/host/mod.rs`): the sim role's
 * own fixed connection-table size, one cap reused rather than two (M15 Deviations). Not read from
 * config or any ABI export (M15b Deviations:
 * `ConnId` is a plain, host-picked `u32 < MAX_CONNS`, and `host::Host::connect` enforces this
 * bound itself with a native `assert!`) -- mirrored here as a plain constant, the same relationship
 * `DEFAULT_TICK_HZ` already has to `TickRate::HZ_20`. */
export const MAX_CONNS = 16

/** The default `maxPlayers` (0009), and the most a world may configure: the other half of
 * `MAX_CONNS` is reconnect headroom, so a returning player whose old socket has not yet been
 * declared dead can be accepted (and then supersede it) in a full world (0013, docs/decisions/0053). */
export const MAX_PLAYERS_LIMIT = MAX_CONNS / 2

/** `Instance::sim_last_superseded()`'s own sentinel (Rust `u32::MAX`), mirrored: `sim_attach`'s
 * `Result`-region word when this attach superseded no other connection. */
const NO_SUPERSEDED_CONN = 0xffff_ffff

/** 0005 "Idle pause is replay-safe": "the host runs at most 5 catch-up ticks per wakeup". */
export const MAX_CATCHUP_TICKS = 5
/** 0008 §2 "Sim host warmer": the between-tick warm budget. */
export const WARM_BUDGET_MS = 2
/** M13b (ADR amending M13): how many ticks pass between the
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
 * 2 of M13 means a hand-written object shaped like this, not a
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
  /** M27, M27 gate round 2: `Host::region_hash
   * (conn)` (`sim_region_hash`, `host/mod.rs`) -- the chunks `conn` is subscribed to plus its own
   * `Global`/`Player`, 16-digit lowercase hex; `0000000000000000` if `conn` is not connected or
   * the sim has not been genesis'd (`region_hash`'s own doc comment). */
  simRegionHash(conn: number): string
  /** `1` if a chunk was generated, `0` if nothing was cold. */
  simWarmOne(): number
  /** `Instance::tick_hz`'s own value ("20 Hz is hardcoded" gap): `G::TICK_RATE.hz_value()` for a
   * real game, `20` (the trait default) for anything that never overrides it. Read once, by
   * `createSimHostFromInstance`, at construction -- not on every tick. */
  tickHz(): number
  /** M15b: admits `conn` into the sim role's
   * connection table (`sim_connect`, forwarding to `host::Host::connect`). `Status` (numeric). */
  simConnect(conn: number): number
  /** M24, Traps ("Connections stay open across recovery"):
   * re-attaches `conn` (`sim_reattach`, forwarding to `host::Host::reattach`) with the same
   * deterministic `PlayerId` a live `simConnect` would assign, but queues no `Record::Player` event
   * and touches no game state -- recovery's own call, distinct from `simConnect`. `Status`
   * (numeric). */
  simReattach(conn: number): number
  /** M24 fix round 1 (Planning decisions 2): queues
   * `Rejected(Engine(EngineFault))` for `seq` directly onto `conn`'s own (already-reattached)
   * connection and raises its dedup floor to at least `seq` (`sim_fault_ack`, forwarding to
   * `host::Host::fault_ack`). `Status` (numeric); tolerates an unknown `conn`. */
  simFaultAck(conn: number, seq: number): number
  /** M15b: frees `conn`'s slot (`sim_disconnect`,
   * `host::Host::disconnect`). `Status` (numeric); tolerates an unknown/already-freed `conn`. */
  simDisconnect(conn: number): number
  /** M28b step 4: `sim_log_disconnected(player)` -- queues
   * `Record::Player { Disconnected }` for `player`, delivered at the next `tick()`, independent of
   * any live connection (`host::Host::log_disconnected`). `Status` (numeric). */
  simLogDisconnected(player: number): number
  /** M15b: copies `bytes` (the whole buffer --
   * only its first `len` bytes are read on the Rust side, `Host::sim_admit`'s own contract) into
   * the sim role's own `Rx` region and calls `sim_admit(conn, len)`. `Status` (numeric). */
  simAdmit(conn: number, bytes: Uint8Array, len: number): number
  /** M15b: builds `conn`'s frame into the sim
   * role's own `Tx` region (`sim_build_frame`), returning its byte length (`0` = nothing to say,
   * `Host::build_frame`'s own "nothing to say" convention) -- throws on a negative/error status,
   * the same convention `simSealFrame` uses for `sim_seal_frame`. `bytes` is a view over the `Tx`
   * region valid only until the next call that touches it (the same "engine-owned buffer" contract
   * 0009's `Connection.send` already carries); present only when `len > 0`. */
  simBuildFrame(conn: number): { len: number; bytes?: Uint8Array }
  /** M15b: the sim role's own `Rx`/`Tx` region
   * capacities in bytes, read once so a `RingConnection`'s preallocated buffers can be sized to
   * match exactly instead of a magic number duplicated between Rust and TS. `0` when the region is
   * absent (a role/instance with no such region, e.g. a hand-rolled fixture `SimInstance`). */
  rxBytes(): number
  txBytes(): number
  /** M28: `sim_attach(conn, len)` -- `input` is the whole
   * handshake input (`host/handshake.ts`'s `buildAttachInput`), copied into the sim role's own
   * `Rx` region; returns `Welcome` bytes (a view over `Tx`, valid only until the next call that
   * touches it) or throws on a negative/malformed status. M28
   * steps 3-5: `supersededConn` is the other, already-attached `ConnId` this call silently freed
   * because it shares this connection's own `PlayerId` (0013 "the old connection gets
   * `Bye{Superseded}`"), `undefined` when nothing was freed. */
  simAttach(
    conn: number,
    input: Uint8Array,
  ): { len: number; bytes?: Uint8Array; supersededConn?: number }
  /** M28b step 2: `sim_resync(conn, epoch)` -- sends a fresh
   * `Welcome` on an already-open connection, carrying the host's new `epoch`. Returns `Welcome`
   * bytes (a view over `Tx`, valid only until the next call that touches it) or throws on a
   * negative/malformed status (an unknown `conn`, which `SimHost.resyncAll()` never passes: it
   * only ever iterates its own open connection table). */
  simResync(conn: number, epoch: number): { len: number; bytes?: Uint8Array }
  /** M28: frees `conn`'s slot (`sim_detach`, same effect as
   * `sim_disconnect`). `Status` (numeric); tolerates an unknown/already-freed `conn`. */
  simDetach(conn: number): number
  /** M34 (`ABI_VERSION` 38): the presence sample the `simDetach`
   * just before removed with its connection (`G::Presence`'s codec bytes), `null` when it removed
   * none. Valid only until the next call that touches `Result`. Optional: a test double may omit it. */
  simDetachedPresence?(): Uint8Array | null
  /** M28: `1`/`0`, whether this world's own `Store` already has
   * a player slot for `player` (`sim_has_player`). */
  simHasPlayer(player: number): number
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
  // Same discipline as `sealResult` above, for `simBuildFrame` (M15b): one object, mutated in place every call.
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
    simRegionHash: (conn) => {
      const status = inst.call1(inst.x.sim_region_hash, conn)
      if (status !== Status.Ok) throw new Error(`sim_region_hash failed: status ${status}`)
      return inst.readU64Hex(RegionId.Result, 0)
    },
    simWarmOne: () => inst.call0(inst.x.sim_warm_one),
    tickHz: () => inst.call0(inst.x.tick_hz),
    simConnect: (conn) => inst.call1(inst.x.sim_connect, conn),
    simReattach: (conn) => inst.call1(inst.x.sim_reattach, conn),
    simFaultAck: (conn, seq) => inst.call2(inst.x.sim_fault_ack, conn, seq),
    simDisconnect: (conn) => inst.call1(inst.x.sim_disconnect, conn),
    simLogDisconnected: (player) => inst.call1(inst.x.sim_log_disconnected, player),
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
    simAttach: (conn, input) => {
      const region = inst.region(RegionId.Rx)
      if (!region) throw new Error('sim_attach: the Rx region is absent')
      // Whole-buffer `.set()`, not a fresh-length allocation (`.claude/rules/hot-paths.md`'s
      // convention elsewhere in this file) -- harmless here even though `sim_attach` runs once per
      // connection, off the tick path, not the steady-state loop that rule targets.
      region.u8.set(input)
      const raw = inst.call2(inst.x.sim_attach, conn, input.length)
      if (raw < 0) throw new Error(`sim_attach failed: status ${-raw}`)
      if (raw === 0) return { len: 0 }
      const txRegion = inst.region(RegionId.Tx)
      if (!txRegion) throw new Error('sim_attach: len > 0 but the Tx region is absent')
      // M28 steps 3-5: `sim_attach`'s own contract widened
      // (`ABI_VERSION` 27 -> 28) -- one LE `u32` at `Result` offset 0, `0xFFFFFFFF` = "nothing
      // superseded", read right after a successful call (`abi/mod.rs`'s own doc comment: "a
      // second, sequential borrow ... after the `Tx` borrow above has ended").
      const resultRegion = inst.region(RegionId.Result)
      const superseded = resultRegion ? readU32LE(resultRegion.u8, 0) : NO_SUPERSEDED_CONN
      if (superseded === NO_SUPERSEDED_CONN) return { len: raw, bytes: txRegion.u8 }
      return { len: raw, bytes: txRegion.u8, supersededConn: superseded }
    },
    simResync: (conn, epoch) => {
      const raw = inst.call2(inst.x.sim_resync, conn, epoch)
      if (raw < 0) throw new Error(`sim_resync failed: status ${-raw}`)
      if (raw === 0) return { len: 0 }
      const txRegion = inst.region(RegionId.Tx)
      if (!txRegion) throw new Error('sim_resync: len > 0 but the Tx region is absent')
      return { len: raw, bytes: txRegion.u8 }
    },
    simDetach: (conn) => inst.call1(inst.x.sim_detach, conn),
    simDetachedPresence: () => {
      const result = inst.region(RegionId.Result)
      if (!result) return null
      const n = readU32LE(result.u8, 0)
      return n > 0 ? result.u8.slice(4, 4 + n) : null
    },
    simHasPlayer: (player) => inst.call1(inst.x.sim_has_player, player),
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
  /** M22b step 3: disarms the pacing timer, then (0005
   * Cadence: "at every clean boundary the host can detect") snapshots if dirty, prunes old
   * snapshots and awaits `flush()` when a `Persistence` is wired in -- resolves once everything is
   * durable. Counters are left as they are. A `SimHost` with no `persistence` (`worker/sim.ts`'s
   * own real topology, still unwired: this milestone's own Deviations) resolves immediately. */
  stop(): Promise<void>
  /** M22b step 3: disarms the pacing timer (0005: "a paused
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
  /** M27, M27 gate round 2: `SimInstance.
   * simRegionHash(conn)`, unwrapped -- the live per-connection region hash `worldServerTestHandle`
   * exists to reach (0020 §8: "per-region state hashes at any tick"). */
  regionHash(conn: number): string
  /** M28 Seams (`serverInternals(server).handshakesSettled()`
   * is a thin wrapper over this): resolves once every currently in-flight secret digest/allocate
   * has settled. Consuming those into a real `sim_attach` + `Welcome` still waits for the next
   * tick boundary (`pumpHandshakes`) -- a caller wants a tick of its own after this resolves, not
   * instead of it. Resolves immediately when `handshake` was never given. */
  handshakesSettled(): Promise<void>
  /** M28 step 5: whether any secret digest/allocate is
   * currently in flight -- a plain sync read (`inFlightHandshakes.size > 0`), `worker/sim.ts`'s own
   * signal to call `shell.runAsync(() => simHost.handshakesSettled())`, the exact same "leave the
   * `Atomics.wait`-blocked loop while `fn` resolves" pattern that worker's own `opfsAdapter.
   * pendingAsync()` already uses (M23 fix round 1). Without this, a fire-and-forget `crypto.subtle.
   * digest()` started from inside a body() pass never gets a chance to resolve: `Atomics.wait`
   * blocks this thread's own microtask queue too, so nothing schedules the digest's completion
   * until the loop actually leaves and returns control to the real event loop (found live: a real
   * browser single-player page hung indefinitely -- `pnpm test browser -t
   * replica_hash_equals_host_in_browser` -- the very first time this milestone wired a real
   * handshake into a linked sim worker; `createWorldServer`, which never runs inside this loop, was
   * never affected). Always `false` when `handshake` was never given. */
  readonly hasInFlightHandshakes: boolean
  /**
   * M24 (0005 Panic recovery 2-4): call this once the caller has
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
  /** M23 step 5: whether the pacing timer is currently
   * armed -- `worker/sim.ts`'s own export-request handler reads this to decide whether it needs to
   * `pause()`/`resume()` around a snapshot-for-export itself, or whether the world is already paused
   * (a hidden-boundary pause in flight or settled) and must be left exactly as it is. */
  readonly running: boolean
  readonly counters: SimHostCounters
  logSink: ((bytes: Uint8Array) => void) | null
  /** M39o: bench builds only. When set (`PROFILE_SLOTS` int32s,
   * preallocated by the sim worker), the paced tick writes its parts' durations into it in whole
   * microseconds (`PROFILE_*`, `sab/control.ts`); `null` everywhere else, where each site is one
   * null check. Timing never feeds the sim. */
  profile: Int32Array | null
  /** M30d: test-only diagnostic. When set, every handshake step
   * (a `Hello` queued, an attach-queue slot filled, what `pumpHandshakes` did with an entry, a
   * connection closing) is reported as one line. `null` in production; each call site is guarded
   * by `if (handshakeTrace)`, so nothing is built when it is unset. */
  handshakeTrace: ((line: string) => void) | null
  /**
   * M15b Scope: admits `connection` into the
   * sim role's connection table. Allocates the next free `ConnId` (0-based, `< MAX_CONNS`, the
   * same fixed cap `host::Host::connect` itself enforces), calls `sim_connect`, and wires
   * `connection.onMessage`/`onClose` so every uplink message this connection ever delivers reaches
   * `sim_admit` and a close reaches `sim_disconnect` automatically. Returns the `ConnId`. Throws if
   * every slot is already taken -- a real, expected condition once multiplayer is real (M27+, past
   * this doc comment's own original "Non-scope here": a genuine retry storm can accept more sockets
   * than `MAX_CONNS` before any of them individually resolves its own `Hello`, `server-node.ts`'s
   * own `attachWebSocketServer` Deviations has the live-found mechanism). This function's own
   * contract stays "throw, do not silently drop a caller's own accepted connection" -- a caller that
   * cannot tolerate a synchronous throw (every real socket-accepting caller) wraps this call and
   * closes the raw connection instead, the way `attachWebSocketServer` now does.
   *
   * The per-connection frame pass ("after each tick `sim_build_frame(conn)` -> `connection.send
   * (MsgClass.ReliableOrdered, view)` when `len > 0`", Scope) happens automatically, every tick,
   * for every accepted connection, from inside this host's own tick procedure -- nothing further
   * to call per connection once `accept` has returned.
   */
  accept(connection: Connection): number
  /** M28b step 2: the current session epoch (0013/0005) --
   * `0` for a brand-new world, loaded from `ManifestV1.epoch` on a reload, bumped by
   * `bumpEpoch()`. Carried in every `Welcome` (`attach`'s own `Welcome.epoch` field). */
  readonly epoch: number
  /** M28b step 2: increments `epoch` and, when a `Persistence`
   * is wired in, writes the bump back to the manifest (`Storage.write`, the same fire-and-forget
   * convention `Persistence`'s own manifest rewrites already use) before returning -- so the new
   * value is already visible to the very next `accept()`/`Welcome` in the same synchronous turn,
   * durability aside. Returns the new epoch. Callers wire this to `SimHost.onRecovered`
   * (`createSimHostFromInstance`'s own default, below) rather than calling it directly in
   * production; a test may still call it to force a foreign-epoch resume hint. */
  bumpEpoch(): number
  /** M28b step 2: sends a fresh `Welcome` (carrying the
   * current `epoch`) on every currently open connection and resets each one's own subscription
   * bookkeeping so the next tick treats every chunk it holds as unsent (`Host::resync`'s own doc
   * comment) -- the resync signal for a live connection after panic recovery or an upgrade bump
   * (Planning decisions "A second `Welcome` is the resync signal"). A connection whose `Welcome`
   * fails to build (an unknown `conn` on the Rust side, never expected: this only ever iterates
   * `SimHost`'s own open connection table) is skipped, not thrown. */
  resyncAll(): void
  /** M28b step 3: the current live raw `EngineInstance`
   * (`recoveryDeps.instance`, kept current across `recover()` calls), or `null` when this host was
   * built with no `recoveryDeps` at all. Test-only (`engine/test`'s `trapSim` takes a raw
   * `EngineInstance`, not `SimInstance` -- `SimInstance`'s own doc comment explains why it stays
   * narrow); `serverInternals(server).rawInstance` is the public re-export, `harness.panicServer()`
   * its one real caller. */
  readonly rawInstanceForTest: EngineInstance | null
  /** M28b step 4: how many times the idle sequence (`pause()`
   * then `onIdle()`) has actually run -- `lifecycle/idle-stops-ticks-then-onidle`'s own "one
   * `onIdle`" assertion. */
  readonly idleCalls: number
}

/** M28 Provides: what `SimHost.accept`'s real handshake needs
 * beyond `HostServices`/`SimInstance` -- the parts of `WorldConfig` a handshake decision reads
 * (`joinKey`/`maxPlayers`/`buildHash`) plus the already-loaded session table. `createWorldServer`
 * builds this once, after `loadSessionTable` resolves, inside its own `ready` chain. */
export interface HandshakeDeps {
  joinKey: string
  maxPlayers: number
  /** Full 32-byte SHA-256 (0013 "Build-hash handshake"), hex-decoded from `WorldConfig.buildHash`. */
  buildHash: Uint8Array
  sessions: SessionTable
}

/** `SimHost.accept`'s own per-connection handshake bookkeeping (Deviations: kept out of
 * `ConnSlot`-equivalent state since it only exists while `handshake` is given). */
interface HandshakeConnState {
  status: 'garbage' | 'awaiting-attach' | 'settled'
  connectedAtMs: number
  /** M28b step 4: this connection's own `PlayerId`, set once
   * `status` becomes `'settled'` -- `onClose`'s own signal for `lifecycle.connectionDropped`,
   * without asking the (possibly already-freed) sim for it. */
  playerId?: number
}

/** One resolved (secret hashed, `PlayerId` allocated or looked up) `Hello`, queued for `sim_attach`
 * at the next tick boundary in arrival order (`pumpHandshakes`'s own doc comment). */
interface QueuedAttach {
  conn: ConnId
  connection: Connection
  playerId: number
  joined: boolean
  presence: Uint8Array | null
  helloTail: Uint8Array
}

/** 0013 Client policy's own handshake analogue (Scope: "no `Hello` within 5 s, closes with
 * `ProtocolError`"). */
const HELLO_TIMEOUT_MS = 5000
/** `Hello`'s first wire byte (the low byte of `MAGIC`, `>= 0x80`: 0024 §8 keeps it clear of every
 * post-handshake `MsgType`, `0x01..=0x05`). A settled connection that sends one is starting its
 * handshake over (`reopenOnHello`). */
const HELLO_LEAD_BYTE = MAGIC & 0xff
/** Scope: "Non-`Hello` messages before `Hello` are dropped silently (at most 8, then close)". */
const MAX_GARBAGE_MESSAGES = 8

type TimerServices = Pick<HostServices, 'clock' | 'timer' | 'scheduler' | 'onIdle'>

/** `HostServices.scheduler`'s own default when a caller never supplies one (its own doc comment):
 * every grace/idle timer this milestone adds is a permanent no-op under it. */
const noopScheduler: Scheduler = {
  setTimer: () => -1,
  clearTimer: () => {},
  requestFrame: () => -1,
  cancelFrame: () => {},
}

/** The shared implementation, over an already-built [`SimInstance`] -- real or fake.
 * `persistence` (M22 steps 4-6) is optional so every
 * existing caller (`worker/sim.ts`'s own two-argument call, this file's own tests) keeps working
 * unmodified: when given, `logSink` is wired to `persistence.appendFrame` and `persistence.
 * afterTick(tick)` runs once per completed tick, right after `sim_tick()` succeeds. */
export function createSimHostFromInstance(
  sim: SimInstance,
  services: TimerServices,
  persistence?: Persistence,
  /** M23 steps 3-4: seeds `counters.ticksRun` from a
   * `Persistence.open()` load's own `tick` result -- additive (a 4th optional parameter, default
   * `0`, every existing 3-argument caller unaffected), not a renamed seam. Without this, a reloaded
   * world's own `logSink`/`afterTick(counters.ticksRun)` call would restart counting from tick 0
   * (Deviations: real bug found here), clobbering `Persistence`'s own already-correctly-seeded
   * `this.tick` with a wrong, small value on the very first tick after a load -- corrupting every
   * `keys.snap(tick)` key it writes from then on. */
  initialTicksRun = 0,
  /** M24: enables `SimHost.recover()`. Optional, additive (a
   * 5th argument, every existing 2-4-argument caller unaffected) -- without it (or without
   * `persistence`), `recover()` always reports `onFatal` immediately (nothing to recover from). */
  recoveryDeps?: RecoveryDeps,
  /** M28: enables the real `Hello`/`Welcome` handshake in
   * `accept()`. Optional, additive (a 7th argument, every existing 2-6-argument caller unaffected:
   * `worker/sim.ts`'s own single-player topology keeps M15's implicit accept until a later
   * milestone wires this there too) -- without it, `accept()` falls back to `sim.simConnect`
   * exactly as before this milestone. */
  handshake?: HandshakeDeps,
  /** M28b step 4: `WorldConfig.keepTickingWhenEmpty` (0013
   * "World lifecycle": "unless `keepTickingWhenEmpty` is set"). Optional, additive (an 8th
   * argument, every existing 2-7-argument caller unaffected) -- default `false`, so a world with
   * no players stops ticking after the grace/idle sequence exactly as 0013 describes unless a
   * caller opts out. */
  keepTickingWhenEmpty = false,
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
  // M28b step 4: `pause()`'s own idempotency flag, distinct
  // from `running` -- see `pause()`'s own doc comment for why the two can no longer be the same
  // boolean once the idle sequence disarms/clears `running` *before* calling `pause()`.
  let paused = false
  let stopTimer: (() => void) | null = null
  // M28b step 4: `SimHost.idleCalls`'s own backing counter,
  // bumped once per completed idle sequence (`lifecycle.ts`'s own `deps.idle` callback, below).
  let idleCalls = 0
  // M37 step 3 (0005 Panic recovery 4, Storage): set once by
  // `raiseFatal`. A fatal host runs no tick, writes no file (no snapshot on `stop()`/`pause()`) and
  // never starts again: a fixed build loads the last snapshot through the upgrade path.
  let fatal = false
  let storageFatal = false

  // M28b step 2: the session epoch (0013/0005), loaded from
  // `persistence.epoch` when a `Persistence` is wired in (`ManifestV1.epoch`, reserved by M22),
  // else `0` for a topology with no persistence (still real: `bumpEpoch()` and `resyncAll()` work
  // either way, just without a durable write-back). Read by `pumpHandshakes` for every `Welcome`
  // an accept produces, and by `resyncAll()` for the second `Welcome` an epoch bump sends.
  let epoch = persistence?.epoch ?? 0

  // M24, Planning decisions 3 (the loop guard): "more than 3
  // recoveries without 1,200 successfully ticked ticks in between is fatal". `recoveryCount` is how
  // many `recover()` calls have happened since the last time `goodTicksSinceRecovery` reached
  // `RECOVERY_GOOD_TICKS_RESET`; `runOneTick` (below) is the only place that increments the latter.
  let recoveryCount = 0
  let goodTicksSinceRecovery = 0
  // M24 fix round 1 (Planning decisions 2): the `conn` whose own
  // `sim.simAdmit()` call is currently in flight, set right before the call and cleared right after
  // it returns normally -- so if it throws instead (an `Admit`-phase trap), this is left holding the
  // one piece of information only the *live* caller has (the Progress cursor's own `record` is the
  // `seq`, but never the `conn`): which connection was mid-admit when the instance died. `recover()`
  // reads and clears it every time, regardless of whether the trap actually turns out to be
  // `Admit`-phase (a trap during, say, `sim_tick()` never touches this in the first place).
  let inFlightAdmitConn: number | null = null

  // M15b: one slot per `ConnId`, `null` when
  // free. Reused array, sized once at construction (`.claude/rules/hot-paths.md`), never
  // reallocated: `accept`/a future disconnect only ever write existing slots.
  const conns: (Connection | null)[] = new Array(MAX_CONNS).fill(null)

  // M28b step 4: the grace/idle world lifecycle. `host` and
  // `disarm`/`running` (below) are all referenced only from inside these closures, never called
  // until well after every one of them is assigned (module doc comment, `host/lifecycle.ts`).
  const lifecycle = createLifecycleTracker({
    clock: services.clock,
    scheduler: services.scheduler ?? noopScheduler,
    keepTickingWhenEmpty,
    logDisconnected: (player) => {
      sim.simLogDisconnected(player)
    },
    stopTicking: () => {
      disarm()
      running = false
    },
    idle: async () => {
      await host.pause()
      idleCalls++
      services.onIdle?.()
    },
  })

  // -- M28: the real handshake (M28 -----------------------
  /** M34: frees `conn` (`sim_detach`) and keeps the presence
   * sample that went with it in the session table (0013: "the last presence sample is kept in the
   * host-side session table ... so a returning player resumes where they were"), which `Welcome`
   * then echoes on the next attach. A tick-rate-irrelevant, human-rate event: the table is saved at
   * once, unawaited (a lost write costs a returning player the camera restore, nothing else). */
  function detachKeepingPresence(conn: number, playerId: number | undefined): void {
    sim.simDetach(conn)
    if (!handshake || playerId === undefined) return
    const sample = sim.simDetachedPresence?.()
    if (!sample) return
    handshake.sessions.setLastPresenceOf(playerId, hexEncode(sample))
    void handshake.sessions.save()
  }

  // Per-connection handshake bookkeeping, only ever populated when `handshake` is given (Deviations
  // above: `worker/sim.ts`'s single-player topology never reaches any of this).
  const handshakeState = new Map<ConnId, HandshakeConnState>()
  // M28 step 5 (real bug, found live: a browser `gc` page's own
  // steady-state bytesPerFrame, not the server, which `pumpHandshakes`'s own doc comment below
  // assumed covered this -- `worker/sim.ts`'s linked topology *is* a zero-GC-constrained caller):
  // how many entries in `handshakeState` are still `'garbage'` -- incremented at `accept()`,
  // decremented wherever a connection leaves that status (a valid `Hello` moves it to
  // `'awaiting-attach'`, or it closes). `handshakeState` itself never shrinks back to empty for the
  // life of a settled connection (its entry is needed for later `onMessage` lookups), so a bare
  // `for (const [conn, state] of handshakeState)` below ran every tick for as long as any
  // connection lived, each pass allocating a fresh `MapIterator` (the same class of defect
  // `manual-clock.ts`'s own `fireDue` doc comment already names for `timers`) -- measured at 38,400
  // + 43,200 + 12,000 B/frame on `sim` (`pumpHandshakes`/`next`/`entries` in a gc page's own
  // `byFn`), the sole cause of `connected-terrain`/`drawables`/`zero_gc_action`'s gc failures this
  // range. Guards that whole scan: once nothing is left in `'garbage'` (the common case, one tick
  // after Hello arrives), `pumpHandshakes` never touches `handshakeState`'s own iterator at all.
  let garbagePending = 0
  // Hello-arrival order (Planning decisions "Async digest, deterministic order"): pushed (as
  // `null`) the instant a valid `Hello` clears the join-key/build-hash/capacity checks, resolved
  // in place once the secret's digest (and, for a brand-new secret, the session-table write) has
  // finished -- consumed from the front, in order, only once resolved, at the next tick boundary.
  // M30d: each entry is a slot object, filled in place by its own
  // `Hello`'s `settle` below. A slot was once an array index captured at push time, but the drain
  // loop's `shift()` moves every later entry down: a `Hello` still hashing when an earlier entry
  // was shifted off wrote to an index one too high, left its own position empty for good, and the
  // `if (!front) break` below then blocked every later `Hello` too.
  const attachQueue: { entry: QueuedAttach | null }[] = []
  // `serverInternals(...).handshakesSettled()`'s own source: every in-flight digest/allocate
  // promise, removed as each settles (Seams).
  const inFlightHandshakes = new Set<Promise<void>>()
  // Deviations (real bug found and fixed): `crypto.subtle.digest` resolves through Node's own
  // libuv thread pool, so *two* concurrently-hashing new secrets' own digests do not necessarily
  // settle in `Hello`-arrival order even though `pumpHandshakes`'s own drain loop below only ever
  // *consumes* `attachQueue` in that order -- the session-table mutation (`sessions.create`'s own
  // "next id" pick) used to run the instant each digest resolved, so whichever secret's digest
  // happened to finish first (real thread-pool timing, not the seed) could claim the lower
  // `PlayerId`, silently swapping two simultaneous new joiners' identities between runs of the
  // identical seed. `sessionMutationChain` re-serializes just that part, in the same arrival order
  // `slotIndex` already fixes: each handshake's own session-table decision `await`s the *previous*
  // arrival's own chain link before touching `sessions` at all, so which promise the real
  // threadpool happens to settle first no longer matters.
  let sessionMutationChain: Promise<void> = Promise.resolve()

  function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  function closeHandshake(conn: ConnId, connection: Connection, code: number): void {
    connection.close(code)
    conns[conn] = null
    if (handshakeState.get(conn)?.status === 'garbage') garbagePending--
    handshakeState.delete(conn)
  }

  /** Runs once per `runOneTick()`. Closes any connection that has gone 5 s (0013 Client policy's
   * own handshake analogue, Scope: "no `Hello` within 5 s") without ever producing a valid `Hello`,
   * then drains `attachQueue` from the front while resolved, calling `sim.simAttach` and sending
   * `Welcome` for each in Hello-arrival order.
   *
   * `services.clock.now()` is read *only* inside the `garbagePending > 0` branch (real bug, found
   * live in a `gc` page: `runOneTick`'s own doc comment already explains why the tick path reads
   * the real clock at most once every `RESYNC_TICKS`, via `resync()`, and never otherwise -- a
   * `clock.now()` call reads a fractional double every time, boxing a fresh `HeapNumber`
   * regardless of tier, M13b's own measurement. Calling it
   * unconditionally from here, once per tick for the connection's *entire life* once settled,
   * would reintroduce exactly the per-tick clock read that ADR amendment was written to eliminate
   * -- `garbagePending`'s own doc comment fixed the `handshakeState` iteration; this fixes the
   * clock read the same way, both gated on the same "any connection still `'garbage'`" condition,
   * since neither is needed once every connection has said `Hello`. */
  function pumpHandshakes(): void {
    if (garbagePending > 0) {
      const nowMs = services.clock.now()
      for (const [conn, state] of handshakeState) {
        if (state.status === 'garbage' && nowMs - state.connectedAtMs >= HELLO_TIMEOUT_MS) {
          const connection = conns[conn]
          if (connection) closeHandshake(conn, connection, CloseCode.ProtocolError)
        }
      }
    }
    while (attachQueue.length > 0) {
      const front = attachQueue[0]
      if (!front?.entry) break
      attachQueue.shift()
      const entry = front.entry
      const state = handshakeState.get(entry.conn)
      if (host.handshakeTrace) {
        host.handshakeTrace(
          `pump entry conn=${entry.conn} state=${state?.status ?? 'none'} live=${conns[entry.conn] === entry.connection} -> ${
            state?.status !== 'awaiting-attach' || conns[entry.conn] !== entry.connection
              ? 'skipped'
              : 'attach'
          } (queue left ${attachQueue.length})`,
        )
      }
      // Superseded/closed meanwhile. The identity check too (M30c,
      // `mp/hello-resent-after-pre-welcome-drop`): a connection that closed after its `Hello`
      // leaves this entry queued, and its `ConnId` can already belong to a new connection whose
      // own `Hello` is awaiting attach -- attaching the stale entry would send the `Welcome` to
      // the dead socket and mark the new one settled, so it never gets one.
      if (state?.status !== 'awaiting-attach' || conns[entry.conn] !== entry.connection) continue
      const input = buildAttachInput({
        playerId: entry.playerId,
        epoch,
        joined: entry.joined,
        // M28b step 4: read *before* `lifecycle.
        // playerAttached` below (which is what clears the very grace timer this checks).
        suppressConnected: lifecycle.isWithinGrace(entry.playerId),
        presence: entry.presence,
        helloTail: entry.helloTail,
      })
      let built: { len: number; bytes?: Uint8Array; supersededConn?: number }
      try {
        built = sim.simAttach(entry.conn, input)
      } catch {
        closeHandshake(entry.conn, entry.connection, CloseCode.ProtocolError)
        continue
      }
      if (built.len <= 0 || !built.bytes) {
        closeHandshake(entry.conn, entry.connection, CloseCode.ProtocolError)
        continue
      }
      // 0013 "the same secret in a second tab: newest wins; the old socket gets
      // `Bye{Superseded}` and must not auto-reconnect" -- `sim.simAttach` (Rust `Host::attach`)
      // already freed the old `ConnSlot` silently (no log record, Constraints); this is only
      // telling that connection's own live TS `Connection` to leave. A `superseded` conn that is
      // no longer in `conns[]` (already closed some other way) is a no-op `closeHandshake` guard.
      if (built.supersededConn !== undefined) {
        const oldConn = built.supersededConn
        const oldConnection = conns[oldConn]
        if (oldConnection) {
          oldConnection.send(MsgClass.ReliableOrdered, buildBye(ByeReason.Superseded))
          closeHandshake(oldConn, oldConnection, CloseCode.Superseded)
        }
      }
      const withLen = entry.connection as Connection & {
        send: (cls: MsgClass, bytes: Uint8Array, len?: number) => void
      }
      withLen.send(MsgClass.ReliableOrdered, built.bytes, built.len)
      state.status = 'settled'
      state.playerId = entry.playerId
      // M28b step 4: cancels any pending grace timer for this
      // player (a within-grace reconnect) and counts them online -- a real join and an ordinary
      // (post-grace or post-`Bye`) reconnect both start from "not currently online", so both count
      // the same way here.
      lifecycle.playerAttached(entry.playerId)
      entry.connection.onMessage = (bytes) => {
        const withLenIn = entry.connection as Connection & { lastMessageLength?: number }
        const len = withLenIn.lastMessageLength ?? bytes.length
        // M37 step 1: a `Hello` on a settled connection restarts it.
        if (bytes[0] === HELLO_LEAD_BYTE) {
          reopenOnHello(entry.conn, entry.connection, bytes)
          return
        }
        // M28b step 4 (0013 "an explicit `Bye` skips the
        // grace"): peeks the one `MsgType` byte every message opens with (`parseBye`'s own doc
        // comment) before falling back to the ordinary admit path -- an explicit `Bye{Leave}` from
        // a settled connection is handled here, not forwarded to `sim_admit`. `bytes`/`len`
        // straight through, never a `subarray()` (`parseBye`'s own doc comment: `.claude/rules/
        // hot-paths.md`, a real regression found live).
        if (parseBye(bytes, len) === ByeReason.Leave) {
          lifecycle.playerLeft(entry.playerId)
          detachKeepingPresence(entry.conn, entry.playerId)
          conns[entry.conn] = null
          handshakeState.delete(entry.conn)
          return
        }
        sim.simAdmit(entry.conn, bytes, len)
      }
    }
  }

  // M13b (Deviations; ADR amending M13's per-tick decision):
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
   * pass (M15b Scope: "after each tick
   * `sim_build_frame(conn)` -> `connection.send(...)` when `len > 0`"), once per accepted
   * connection, in `ConnId` order. No clock read here any more (Deviations): a tick's own overrun
   * is no longer measured individually. */
  /** True while `resync` runs its catch-up ticks: their parts are not the paced tick's (`profile`). */
  let catchingUp = false

  function runOneTick(): void {
    // A fatal host runs no tick. A storage failure is the exception: a manual driver that still
    // steps gets `Persistence`'s own "a previous storage error is fatal" throw (M22's contract).
    if (fatal && !storageFatal) return
    // M28 Planning decisions "Async digest, deterministic
    // order": consumed at *this* tick boundary, before anything else -- an attach's own
    // `Joined`/`Connected` records must reach `pending_records` before `sim.simTick()` drains it
    // below, the same "queued ... into the frame for T+1" contract every other connection event
    // already has (host/mod.rs `connect`/`disconnect`). Zero cost when `handshake` was never given
    // (`worker/sim.ts`'s single-player topology): `handshakeState` stays empty forever.
    if (handshake) pumpHandshakes()
    const prof = catchingUp ? null : host.profile
    let tp = prof ? services.clock.now() : 0
    const seal = sim.simSealFrame()
    if (prof) {
      const t = services.clock.now()
      prof[PROFILE_SEAL] = Math.round((t - tp) * 1000)
      tp = t
    }
    // `seal.bytes` is the whole persistent `Persist` region view (Orchestrator ruling 2), but
    // `logSink`'s own contract (`SimHost.logSink`'s doc comment: "exactly `len` bytes") is fixed at
    // one argument -- unlike `simBuildFrame`'s `bytes`+separate `.len` pair, `Storage.append`
    // (`Persistence.appendFrame`, M22 steps 4-6) has no
    // second parameter to carry a real length past the whole-region view, so this is the one place
    // a `subarray()` is unavoidable rather than a `.claude/rules/hot-paths.md` violation waiting to
    // be found: it only ever runs on a tick that actually logged something (`seal.len > 0`), never
    // on an idle tick, and no zero-GC page wires a real `Storage` through this milestone (Non-scope:
    // that is whichever milestone first arms `Persistence` inside `worker/sim.ts`, flagged in this
    // milestone's own Deviations for that milestone to measure).
    if (seal.len > 0 && host.logSink) {
      host.logSink((seal.bytes as Uint8Array).subarray(0, seal.len))
    }
    if (prof) tp = services.clock.now()
    const status = sim.simTick()
    if (prof) {
      const t = services.clock.now()
      prof[PROFILE_TICK] = Math.round((t - tp) * 1000)
    }
    if (status !== Status.Ok) throw new Error(`sim_tick failed: status ${status}`)
    counters.ticksRun++
    // M24, Planning decisions 3: "1,200 successfully ticked
    // ticks in between" resets the loop guard's own count -- every real completed tick counts,
    // whether or not it happened to log anything.
    goodTicksSinceRecovery++
    if (goodTicksSinceRecovery >= RECOVERY_GOOD_TICKS_RESET) recoveryCount = 0
    // M22 steps 4-6: the tick procedure's own persistence
    // hook, right after `sim_tick()` succeeds -- `counters.ticksRun` is the same completed-tick
    // count `Persistence.afterTick`'s own doc comment names as its `tick` argument.
    persistence?.afterTick(counters.ticksRun)
    if (prof) tp = services.clock.now()
    for (let conn = 0; conn < MAX_CONNS; conn++) {
      const connection = conns[conn]
      if (!connection) continue
      // `RingConnection.pumpRetries()`'s own doc comment (M15b): every tick, not only one whose
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
    if (prof) prof[PROFILE_FRAME] = Math.round((services.clock.now() - tp) * 1000)
    // M28b step 4 (0013 "the tick that applies the last
    // `Disconnected` is the last tick run"): a no-op unless `sim.simTick()` above just applied the
    // world's last `Disconnected` record (queued by `lifecycle.playerLeft`/a grace timeout,
    // strictly *before* this tick started) -- stops ticking and arms the idle timer exactly then,
    // never a tick early or late.
    lifecycle.afterTick()
  }

  /** Runs the chunk warmer for at most `WARM_BUDGET_MS` from `nowMs` (resync's own reading, already
   * an integer). M16d, CI round 3: the first chunk is
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
        catchingUp = true
        for (let i = 0; i < runCount; i++) runOneTick()
        catchingUp = false
        const prof = host.profile
        if (prof) prof[PROFILE_CATCHUP] = runCount
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
    if (ticksSinceSync >= RESYNC_TICKS) {
      const prof = host.profile
      if (prof) {
        const t0 = services.clock.now()
        resync()
        prof[PROFILE_RESYNC] = Math.max(1, Math.round((services.clock.now() - t0) * 1000))
      } else resync()
    }
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

  /** The one way a host gives up. Idempotent; reports through `host.onFatal` (0024 §5 on a server:
   * `HostServices.onFatal`; the sim worker posts `sim-fatal`). */
  function raiseFatal(f: { tick: number; message: string }): void {
    if (fatal) return
    fatal = true
    disarm()
    running = false
    lifecycle.dispose()
    host.onFatal?.(f)
  }

  // A failed or lost storage write is fatal to the world (0005 Storage, 0004); `Persistence` already
  // refuses further writes, this makes the host stop and say so.
  if (persistence) {
    persistence.onStorageError = (err) => {
      storageFatal = true
      raiseFatal({
        tick: counters.ticksRun,
        message: `storage error: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /** A settled connection sent a `Hello`: its client replaced the instance that held the session (a
   * client-role trap, 0014 §6) or lost the sim it spoke to. Same teardown as an ungraceful close,
   * then the connection is accepted afresh and the `Hello` handed to the new handshake, so a
   * trapped client's full resync needs no redial on any transport (ring pair, socket, memory pair).
   * The player's slot, presence and grace timer behave as they do across a reconnect. */
  function reopenOnHello(conn: ConnId, connection: Connection, bytes: Uint8Array): void {
    const state = handshakeState.get(conn)
    if (state?.status !== 'settled') return
    detachKeepingPresence(conn, state.playerId)
    if (state.playerId !== undefined) lifecycle.connectionDropped(state.playerId)
    conns[conn] = null
    handshakeState.delete(conn)
    host.accept(connection)
    connection.onMessage?.(bytes)
  }

  const host: SimHost = {
    start() {
      if (running || fatal) return
      ensureGenesis()
      // A fresh resync anchor (Deviations): the first tick after this arms sets `syncBaseMs` from
      // real "now" at that moment, so neither the time this call itself took nor (on a second
      // `start()` after `stop()`) time spent stopped is ever counted as falling behind.
      syncInitialized = false
      ticksSinceSync = 0
      running = true
      paused = false
      arm()
    },
    async stop() {
      disarm()
      running = false
      lifecycle.dispose()
      if (fatal) return // 37: a fatal world touches no file
      persistence?.snapshotIfDirty()
      await persistence?.pruneSnapshots()
      await persistence?.flush()
    },
    async pause() {
      // M28b step 4: guarded on `paused`, not `running` --
      // `lifecycle`'s own idle sequence calls this *after* `stopTicking()` has already disarmed
      // and cleared `running` (so "the tick that applies the last `Disconnected` is the last tick
      // run" holds without waiting for the 30 s idle delay too), so `running` is already `false`
      // by the time this runs and a `!running` guard would skip the snapshot/flush this exists for.
      if (paused) return
      paused = true
      disarm()
      running = false
      if (fatal) return
      persistence?.snapshotIfDirty()
      await persistence?.pruneSnapshots()
      await persistence?.flush()
    },
    resume() {
      if (running || fatal) return
      ensureGenesis()
      // Same reasoning as `start()`: a fresh anchor makes the paused wall-clock interval invisible
      // to pacing (0005 "Idle pause is replay-safe"), with no separate `pausedAt` bookkeeping needed
      // now that nothing computes a duration from it.
      syncInitialized = false
      ticksSinceSync = 0
      running = true
      paused = false
      arm()
    },
    stepTick(n = 1) {
      ensureGenesis()
      // M28b step 4: unchanged by this milestone -- still the
      // unconditional manual/test driver its own doc comment promises (`start()`/`running` are not
      // preconditions: `simhost_seal_precedes_tick` and every other pre-M28b caller never call
      // `start()` first). A harness that wants "tick counter frozen while idle" reads `isTicking`
      // itself before calling this (`net-harness.ts`'s own `advanceTicks`) rather than this method
      // silently refusing to do what it was asked.
      for (let i = 0; i < n; i++) runPacedTick()
    },
    hash() {
      return sim.simHash()
    },
    regionHash(conn) {
      return sim.simRegionHash(conn)
    },
    async handshakesSettled() {
      // A `while` (not one `Promise.all` snapshot): a settling digest can itself be replaced by a
      // fresh one added meanwhile (a burst of connections landing back to back) -- loop until the
      // set is genuinely empty, not just empty at the instant this was called.
      while (inFlightHandshakes.size > 0) {
        await Promise.all(inFlightHandshakes)
      }
    },
    get hasInFlightHandshakes() {
      return inFlightHandshakes.size > 0
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
        raiseFatal({
          tick: trapTick,
          message: 'recovery unavailable: no persistence configured for this world',
        })
        return 'fatal'
      }
      if (recoveryCount >= RECOVERY_LOOP_LIMIT) {
        raiseFatal({
          tick: trapTick,
          message: `recovery loop guard: more than ${RECOVERY_LOOP_LIMIT} recoveries without ${RECOVERY_GOOD_TICKS_RESET} ticked ticks in between`,
        })
        return 'fatal'
      }
      recoveryCount++
      goodTicksSinceRecovery = 0
      const result = await runPanicRecovery(persistence, recoveryDeps.newInstance)
      if (result.kind === 'fatal') {
        raiseFatal({ tick: result.tick, message: result.message })
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
    get rawInstanceForTest() {
      return recoveryDeps?.instance ?? null
    },
    get idleCalls() {
      return idleCalls
    },
    counters,
    logSink: null,
    profile: null,
    handshakeTrace: null,
    get epoch() {
      return epoch
    },
    bumpEpoch() {
      epoch = persistence ? persistence.bumpEpoch() : epoch + 1
      return epoch
    },
    resyncAll() {
      for (let conn = 0; conn < MAX_CONNS; conn++) {
        const connection = conns[conn]
        if (!connection) continue
        let built: { len: number; bytes?: Uint8Array }
        try {
          built = sim.simResync(conn, epoch)
        } catch {
          continue
        }
        if (built.len <= 0 || !built.bytes) continue
        const withLen = connection as Connection & {
          send: (cls: MsgClass, bytes: Uint8Array, len?: number) => void
        }
        withLen.send(MsgClass.ReliableOrdered, built.bytes, built.len)
      }
    },
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
      conns[conn] = connection

      if (!handshake) {
        // M15's implicit accept, unchanged (Deviations: `worker/sim.ts`'s single-player topology
        // only, until a later milestone wires the real handshake there too).
        const status = sim.simConnect(conn)
        if (status !== Status.Ok) {
          throw new Error(`sim_connect failed: status ${status}`)
        }
        connection.onMessage = (bytes) => {
          const withLen = connection as Connection & { lastMessageLength?: number }
          const len = withLen.lastMessageLength ?? bytes.length
          inFlightAdmitConn = conn
          sim.simAdmit(conn, bytes, len)
          inFlightAdmitConn = null
        }
        connection.onClose = (_code) => {
          sim.simDisconnect(conn)
          conns[conn] = null
        }
        return conn
      }

      // M28: the real handshake. No `sim_connect`/`sim_attach`
      // yet -- this connection has said nothing; `state.status` starts `'garbage'` (Scope: "no
      // Hello within 5s" starts counting from acceptance, 0013 Client policy's own analogue).
      const deps = handshake
      const connectState: HandshakeConnState = {
        status: 'garbage',
        connectedAtMs: services.clock.now(),
      }
      handshakeState.set(conn, connectState)
      garbagePending++
      let garbageCount = 0

      connection.onClose = (code) => {
        const state = handshakeState.get(conn)
        if (host.handshakeTrace) {
          host.handshakeTrace(`close conn=${conn} code=${code} state=${state?.status ?? 'none'}`)
        }
        if (state?.status === 'settled') {
          detachKeepingPresence(conn, state.playerId)
          // M28b step 4: an ungraceful close (no `Bye` --
          // `playerLeft`'s own `onMessage` branch already tore this connection down before any
          // `close`/`onClose` could reach here, so `state` is always still `'settled'` at this
          // point for a genuine drop). Presence and the slot are already gone (`sim.simDetach`,
          // just above); only the *logged* half is delayed, by the grace timer this starts.
          if (state.playerId !== undefined) lifecycle.connectionDropped(state.playerId)
        }
        if (state?.status === 'garbage') garbagePending--
        conns[conn] = null
        handshakeState.delete(conn)
      }

      connection.onMessage = (bytes) => {
        const withLen = connection as Connection & { lastMessageLength?: number }
        const len = withLen.lastMessageLength ?? bytes.length
        const raw = len === bytes.length ? bytes : bytes.subarray(0, len)

        const state = handshakeState.get(conn)
        if (!state) return // closed already

        if (state.status === 'settled') {
          inFlightAdmitConn = conn
          sim.simAdmit(conn, bytes, len)
          inFlightAdmitConn = null
          return
        }
        if (state.status === 'awaiting-attach') return // Welcome pending; nothing to do with more

        // `state.status === 'garbage'`: the only message this connection has ever sent that
        // matters is its first well-formed `Hello`.
        //
        // M28b step 4 (0013 "A new connection resumes the
        // timer"): a paused world (zero players, idle) is still listening for new connections --
        // this is the very first message *any* connection can ever send, so it is where "a Hello
        // while paused" is detected, before the handshake bytes themselves are even parsed
        // (`host.resume()` re-arms pacing, which is what lets `pumpHandshakes` ever drain this
        // connection's own `attachQueue` entry at all).
        if (!running) host.resume()
        let parsed: ReturnType<typeof parseHello>
        try {
          parsed = parseHello(raw)
        } catch (e) {
          if (!(e instanceof ProtocolError)) throw e
          garbageCount++
          if (garbageCount > MAX_GARBAGE_MESSAGES) {
            closeHandshake(conn, connection, CloseCode.ProtocolError)
          }
          return
        }

        if (!bytesEqual(parsed.buildHash, deps.buildHash)) {
          connection.send(
            MsgClass.ReliableOrdered,
            buildReject(RejectReason.VersionMismatch, deps.buildHash),
          )
          closeHandshake(conn, connection, rejectReasonCloseCode(RejectReason.VersionMismatch))
          return
        }
        const joinKeyText = new TextDecoder().decode(parsed.joinKey)
        if (joinKeyText !== deps.joinKey) {
          connection.send(
            MsgClass.ReliableOrdered,
            buildReject(RejectReason.BadKey, deps.buildHash),
          )
          closeHandshake(conn, connection, rejectReasonCloseCode(RejectReason.BadKey))
          return
        }
        // 0013 / 0053: `Full` is decided in `settle` below, once the secret's hash says whether this
        // `Hello` is a returning player (which supersedes, never `Full`) or a new distinct one.

        state.status = 'awaiting-attach'
        garbagePending--
        const slot: { entry: QueuedAttach | null } = { entry: null }
        attachQueue.push(slot)
        if (host.handshakeTrace) {
          host.handshakeTrace(`hello conn=${conn} queued (queue length ${attachQueue.length})`)
        }
        // This arrival's own turn on `sessionMutationChain` (Deviations above): captured now, in
        // `Hello`-arrival order, *before* the chain is extended for the next arrival below -- the
        // digest itself (line after) is free to resolve in whatever order the real threadpool
        // picks, but nothing here touches `sessions` until its own predecessor's turn is done.
        const myTurn = sessionMutationChain
        let resolveMyTurn = (): void => {}
        sessionMutationChain = new Promise((resolve) => {
          resolveMyTurn = resolve
        })
        // M39ak: the body below can reject (`hashSecretHex`, `sessions.save()`); `settleBody`'s
        // wrapper turns that into a released turn, a removed slot and a closed connection, so one
        // bad handshake never blocks `sessionMutationChain` or `attachQueue` for everyone after it.
        const settleBody = async (): Promise<void> => {
          const hashHex = await hashSecretHex(parsed.playerSecret)
          await myTurn
          // Synchronous from here to `sessions.create` (Deviations: no `await` in between, and now
          // serialized in arrival order by `myTurn` above), so two never-before-seen secrets can
          // never race the same candidate id -- the first one's `create` is already visible to
          // `highestPlayerId()` before the second's own lookup runs.
          let entry = deps.sessions.lookup(hashHex)
          // 0053: `Full` counts players attached by distinct secret (settled, or resolved and
          // queued ahead of this one), not connections; a secret that maps to an attached player
          // supersedes it. A refused `Hello` creates no session and leaves nothing in the queue.
          const attachedPlayers = new Set<number>()
          for (const s of handshakeState.values()) {
            if (s.status === 'settled' && s.playerId !== undefined) attachedPlayers.add(s.playerId)
          }
          for (const q of attachQueue) {
            if (q.entry && handshakeState.get(q.entry.conn)?.status === 'awaiting-attach') {
              attachedPlayers.add(q.entry.playerId)
            }
          }
          if (
            !(entry && attachedPlayers.has(entry.playerId)) &&
            attachedPlayers.size >= deps.maxPlayers
          ) {
            resolveMyTurn()
            const at = attachQueue.indexOf(slot)
            if (at >= 0) attachQueue.splice(at, 1)
            if (handshakeState.get(conn) === state && conns[conn] === connection) {
              connection.send(
                MsgClass.ReliableOrdered,
                buildReject(RejectReason.Full, deps.buildHash),
              )
              closeHandshake(conn, connection, rejectReasonCloseCode(RejectReason.Full))
            }
            return
          }
          if (!entry) {
            let candidate = deps.sessions.highestPlayerId() + 1
            while (sim.simHasPlayer(candidate) === 1) candidate++
            entry = deps.sessions.create(hashHex, candidate)
            // Crash safety (Planning decisions): durable before the log ever records the join.
            await deps.sessions.save()
          }
          resolveMyTurn() // the next arrival's own turn may now touch `sessions`
          const joined = sim.simHasPlayer(entry.playerId) === 0
          const presence = entry.lastPresenceHex ? hexDecode(entry.lastPresenceHex) : null
          if (host.handshakeTrace) {
            host.handshakeTrace(
              `resolved conn=${conn} queued=${attachQueue.includes(slot)} (queue length ${attachQueue.length})`,
            )
          }
          slot.entry = {
            conn,
            connection,
            playerId: entry.playerId,
            joined,
            presence,
            helloTail: parsed.helloTail,
          }
        }
        const settle = settleBody().catch((e: unknown) => {
          resolveMyTurn() // idempotent: a no-op when the body already released its turn
          const at = attachQueue.indexOf(slot)
          if (at >= 0) attachQueue.splice(at, 1)
          if (host.handshakeTrace) {
            host.handshakeTrace(
              `hello settle failed conn=${conn}: ${e instanceof Error ? e.message : String(e)}`,
            )
          }
          if (handshakeState.get(conn) === state && conns[conn] === connection) {
            // `ProtocolError` is the one handshake code the client treats as transient (link.ts),
            // so the player simply redials.
            closeHandshake(conn, connection, CloseCode.ProtocolError)
          }
        })
        inFlightHandshakes.add(settle)
        settle.finally(() => inFlightHandshakes.delete(settle))
      }
      return conn
    },
  }
  // M22 steps 4-6: `SimHost.logSink` is pointed at
  // `Persistence.appendFrame`, a fixed method value (`.claude/rules/hot-paths.md`: no per-call
  // closure), overriding the `null` the object literal above starts with.
  if (persistence) host.logSink = persistence.appendFrame
  return host
}

/** `createSimHost(cfg, services)` (Provides): instantiates a real `role=sim` instance from
 * `services.wasm`, builds a [`Persistence`] over `services.storage` (M22 steps 4-6: "create world (manifest + segment 0)" happens
 * right here, once, before the host ever ticks), and drives both through
 * [`createSimHostFromInstance`]. */
export function createSimHost(cfg: WorldConfig, services: HostServices): SimHost {
  const inst = instantiate(services.wasm, Role.Sim, buildSimInstanceConfig(cfg))
  const persistence = Persistence.create(services.storage, cfg, inst)
  return createSimHostFromInstance(
    wrapEngineInstance(inst),
    services,
    persistence,
    0,
    undefined,
    undefined,
    cfg.keepTickingWhenEmpty ?? false,
  )
}

// ---------------------------------------------------------------------------------------------
// `createWorldServer` (M27; 0024 §5, which
// amends 0009 and is implemented here, not re-decided).
// ---------------------------------------------------------------------------------------------

/**
 * `createWorldServer(cfg, host): WorldServer` (0024 §5, verbatim): `{ ready, accept, stop }`.
 * Built the same way `createSimHost` is (a fresh `role=sim` instance from `host.wasm`, driven
 * through `createSimHostFromInstance`) but over `Persistence.open` (load, recover or create)
 * instead of `Persistence.create` (always fresh) -- "no second host loop: `createWorldServer` and
 * the sim worker construct the same module with different `HostServices`" (Planning decisions).
 * Loading is asynchronous (0005), so construction itself never throws: every failure the load can
 * raise (`WorldLoadError`, or any other error `Persistence.open`/`instantiate` throw) surfaces only
 * through `ready` rejecting, never synchronously from this call.
 */
// `worldServerTestHandle` (M27, M27 gate round
// 2): the same module-private-`WeakMap`-keyed-by-the-public-object pattern `client.ts`'s
// `clientTestHandle`/`handles` already uses, so `createNetHarness`/`assertConverged` can read a
// live `sim_region_hash(conn)` from the *real* `SimHost` a real `createWorldServer` owns, without
// widening `WorldServer`'s own fixed 0024 §5 shape (`{ ready, accept, stop }`, unchanged -- the
// type-assert test in `server.test.ts` still holds). Registered once `ready` resolves; a caller
// that reaches for this before then (or after `stop()` on a world whose `ready` rejected) gets a
// clear error, the same way `clientTestHandle` throws for "not a `createClient()` result".
const worldServerHandles = new WeakMap<WorldServer, SimHost>()

/** The live `SimHost` behind a `WorldServer` returned by `createWorldServer` (Seams). Test-only,
 * `engine/test`'s own re-export: never imported by production code. */
export function worldServerTestHandle(server: WorldServer): SimHost {
  const h = worldServerHandles.get(server)
  if (!h) {
    throw new Error('worldServerTestHandle: no live SimHost (await server.ready first)')
  }
  return h
}

/** M28 Seams: `serverInternals(server).handshakesSettled()`,
 * used by `createNetHarness`'s own `settle()`. A thin wrapper over `worldServerTestHandle`, kept
 * as its own named function (rather than widening that one's return type) so a reader sees
 * exactly which test-only surface a given call site needs. Test-only, `engine/test`'s own
 * re-export: never imported by production code. */
export function serverInternals(server: WorldServer): {
  handshakesSettled(): Promise<void>
  readonly isTicking: boolean
  readonly idleCalls: number
  readonly rawInstance: EngineInstance | null
  /** M31b: how many desync reports the host has recorded (`sim_desync`'s
   * `count`): one per `ResyncChunk` it acted on. `0` when the live instance is unavailable. */
  readonly desyncCount: number
} {
  const h = worldServerTestHandle(server)
  return {
    handshakesSettled: () => h.handshakesSettled(),
    // M28b Seams: `serverInternals(server).isTicking` -- a thin
    // wrapper over `SimHost.running` (already "whether the pacing timer is currently armed"), the
    // same named seam step 4's idle-world tests need ("the tick counter frozen" is `counters.
    // ticksRun` not advancing; "isTicking" is this: whether the pacing timer would even try).
    get isTicking() {
      return h.running
    },
    get idleCalls() {
      return h.idleCalls
    },
    get rawInstance() {
      return h.rawInstanceForTest
    },
    get desyncCount() {
      const inst = h.rawInstanceForTest
      if (!inst || inst.call1(inst.x.sim_desync, 0) !== Status.Ok) return 0
      const region = inst.region(RegionId.Result)
      return region ? readU32LE(region.u8, 0) : 0
    },
  }
}

export function createWorldServer(cfg: WorldConfig, host: HostServices): WorldServer {
  if (
    cfg.maxPlayers !== undefined &&
    !(cfg.maxPlayers >= 1 && cfg.maxPlayers <= MAX_PLAYERS_LIMIT)
  ) {
    throw new Error(
      `createWorldServer: maxPlayers ${cfg.maxPlayers} is out of range (1..=${MAX_PLAYERS_LIMIT}; half of MAX_CONNS = ${MAX_CONNS} is reconnect headroom)`,
    )
  }
  const newInstance = (): EngineInstance =>
    instantiate(host.wasm, Role.Sim, buildSimInstanceConfig(cfg))

  // `accept`'s own doc comment (Seams: "connections arriving before ready wait"): queued here until
  // `ready` settles, then handed to the real `SimHost.accept` in the order they arrived. Never
  // flushed on a rejection -- there is no host to accept them into, and 0024 §5 defines no protocol
  // for reporting that back over a `Connection` this milestone's own accept-before-ready caller
  // holds no other handle on.
  // M38: a connection queued here keeps what it sends meanwhile (`early`, copied: `onMessage` bytes are
  // valid only during the call) and a close (`closed`), replayed once `SimHost.accept` has wired the
  // real handlers. Before this a `Hello` that arrived while the world was loading was dropped (the
  // adapter calls `conn.onMessage?.()` on a null handler) and the client waited out its link timeout.
  const pendingConnections: { c: Connection; early: Uint8Array[]; closed: number | null }[] = []
  // Every connection this world has ever accepted (Traps below: `onFatal`'s own "closes sockets").
  // Sized on demand, not `MAX_CONNS`-preallocated (`.claude/rules/hot-paths.md` does not reach this
  // file: `createWorldServer` runs once per world, not per frame or per tick).
  const acceptedConnections: Connection[] = []
  let simHost: SimHost | null = null

  // Declared before `ready`'s own `.then()` closure captures it, assigned only after the object
  // literal below exists: the closure runs on a microtask strictly after `createWorldServer`
  // itself has returned, so `worldServer` is always assigned by the time it actually reads it.
  let worldServer!: WorldServer

  const ready: Promise<void> = Persistence.open(host.storage, cfg, newInstance).then(
    async (opened) => {
      // M28: loaded once per world, here (not per connection) --
      // `SimHost.accept`'s own handshake reads/writes it through the same live `SessionTable`.
      const sessions = await loadSessionTable(host.storage, worldKeys(cfg.worldId))
      const h = createSimHostFromInstance(
        wrapEngineInstance(opened.sim),
        host,
        opened.persistence,
        opened.tick,
        // M28b step 3: `createWorldServer` itself never wired
        // `recoveryDeps` before this milestone (M27's own Scope stopped at "load, recover or
        // create"; M24 built `SimHost.recover()` against a caller-supplied instance/`newInstance`
        // but the one real production entrypoint, this function, never passed one -- `recover()`
        // silently reported `onFatal` immediately for every trap on a real `createWorldServer`
        // world). `instance` is mutated in place by `recover()` itself (`recoveryDeps.instance =
        // result.sim`), so this object identity is all a caller (`harness.panicServer()`) needs to
        // keep reading the *current* live raw instance across repeated recoveries.
        { instance: opened.sim, newInstance },
        {
          joinKey: cfg.joinKey ?? '',
          maxPlayers: cfg.maxPlayers ?? 8,
          buildHash: parseBuildHash32(cfg.buildHash),
          sessions,
        },
        cfg.keepTickingWhenEmpty ?? false,
      )
      // 0024 §5: "`HostServices` gains `onFatal?`, fed from `SimHost.onFatal`; after it fires the
      // server stops ticking, closes sockets, touches no file, and adds no protocol." Sockets close
      // first (clients fall into the ordinary reconnect policy of 0013, and a fixed deploy answers
      // them with a version mismatch), then the deployer hears of it, then `stop()`: `SimHost` is
      // already fatal (`raiseFatal` disarmed pacing), so its `stop()` writes no snapshot.
      h.onFatal = (f) => {
        for (const c of acceptedConnections) c.close(0)
        host.onFatal?.(f)
        void worldServer.stop()
      }
      // M28b step 2 (0005 Panic recovery 2: "the host bumps
      // the session epoch; clients see Resyncing ... and take a full resync"): every successful
      // `recover()` bumps the epoch and resyncs every still-open connection with it -- the same
      // per-call-site wiring `onFatal` just above already uses (`createSimHostFromInstance`
      // itself leaves `onRecovered` `null`, like `onFatal`; a raw caller that builds its own host
      // directly, e.g. a native test, opts in the same explicit way).
      h.onRecovered = () => {
        h.bumpEpoch()
        h.resyncAll()
      }
      // M28b step 2 (0013: "`epoch` increments at every host
      // start"): a brand-new world (`outcome === 'created'`) starts at the manifest's own initial
      // `0` -- every other outcome (`'loaded'`, `'recovered'`, `'upgraded'`) is *this* process
      // finding an *existing* world on disk, i.e. a real restart, so it bumps once here, before
      // `h.start()`/the first `accept()` can ever build a `Welcome` off the stale value. A live
      // panic `recover()` call later in this same process bumps again on its own (`onRecovered`'s
      // own default wiring, `createSimHostFromInstance`) -- the two never double up, since this one
      // runs at most once, here, before any tick has run.
      if (opened.outcome !== 'created') h.bumpEpoch()
      simHost = h
      worldServerHandles.set(worldServer, h)
      h.start()
      for (const p of pendingConnections) {
        acceptedConnections.push(p.c)
        h.accept(p.c)
        for (const bytes of p.early) p.c.onMessage?.(bytes)
        if (p.closed !== null) p.c.onClose?.(p.closed)
      }
      pendingConnections.length = 0
    },
  )

  worldServer = {
    ready,
    accept(c) {
      if (simHost) {
        acceptedConnections.push(c)
        simHost.accept(c)
      } else {
        const pending = { c, early: [] as Uint8Array[], closed: null as number | null }
        c.onMessage = (bytes) => {
          pending.early.push(bytes.slice())
        }
        c.onClose = (code) => {
          pending.closed = code
        }
        pendingConnections.push(pending)
      }
    },
    async stop() {
      // Settle `ready` first, one way or the other, before deciding whether there is a `SimHost` to
      // stop -- awaiting the same promise `ready` already is, not a fresh derived one, so a handler
      // is attached to it here regardless of whether the caller ever awaits `ready` itself
      // (`Promise.prototype.catch` registers on the original promise, avoiding an "unhandled
      // rejection" report for a caller that only ever calls `stop()`).
      await ready.catch(() => {})
      if (simHost) await simHost.stop()
      // Brief Scope: "`stop()` = `SimHost.stop()` then close connections" -- queued ones included.
      for (const c of acceptedConnections) c.close(0)
      for (const p of pendingConnections) p.c.close(0)
      acceptedConnections.length = 0
      pendingConnections.length = 0
    },
  }
  return worldServer
}
