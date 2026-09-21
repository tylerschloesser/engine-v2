// The sim host (docs/plan/13-sim-host-tick-loop.md): one TypeScript module driving a `role=sim`
// instance identically in the sim worker and on a server (docs/decisions/0015 "Server" row) --
// only `Connection`, `Storage` and the clock differ. Shared module: no `node:`/DOM imports here
// (packages/engine/src/CLAUDE.md).
//
// Types `Connection`, `MsgClass`, `HostServices`, `WorldConfig`, `Storage` are declared exactly as
// docs/decisions/0009-transport-and-hosting.md / docs/decisions/0005-persistence-and-recovery.md
// (`storage` is unused until M22: Non-scope here).

import { RegionId, Role, Status } from './abi.js'
import type { EngineInstance, InstanceConfig } from './loader.js'
import { instantiate } from './loader.js'

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

export interface Storage {
  append(key: string, bytes: Uint8Array): void | Promise<void>
  sync(key: string): void | Promise<void>
  write(key: string, bytes: Uint8Array): void | Promise<void>
  delete(key: string): void | Promise<void>
  onError: ((err: unknown) => void) | null
  flush(): Promise<void>
  read(key: string): Promise<Uint8Array | null>
  list(prefix: string): Promise<string[]>
}

export interface HostServices {
  wasm: WebAssembly.Module
  storage: Storage
  clock: { now(): number }
  timer: { every(ms: number, fn: () => void): () => void }
  onIdle?: () => void
}

export interface WorldConfig<Params = unknown> {
  worldId: string
  buildHash: string
  params: {
    /** u64 as decimal text (0009); `createSimHost` converts it to `HexU64` form once (0024 §5). */
    seed: string
    worldgen: Params
    maxEntities?: number
    maxModifiedTiles?: number
    maxActionGrowth?: number
  }
  joinKey?: string
  maxPlayers?: number
  keepTickingWhenEmpty?: boolean
  view?: { maxTilesPerAxis?: number; maxChunks?: number }
  cacheChunks?: number
  arenaBytes?: number
  actionRate?: { perSecond?: number; burst?: number }
  bandwidth?: {
    softCapBytesPerS?: number
    chunkRefillBytesPerS?: number
    chunkBurstBytes?: number
    hardCapBytesPerS?: number
  }
}

// ---------------------------------------------------------------------------------------------
// Pacing constants.
// ---------------------------------------------------------------------------------------------

/** 0005 "Idle pause is replay-safe": "the host runs at most 5 catch-up ticks per wakeup". */
export const MAX_CATCHUP_TICKS = 5
/** 0008 §2 "Sim host warmer": the between-tick warm budget. */
export const WARM_BUDGET_MS = 2

/**
 * `Game::TICK_RATE`'s own default (`TickRate::HZ_20`, 0006) and the only rate any existing game
 * (`fx-puts`) uses. 0009 fixes tick rate as "a compile-time constant of the game crate ... not
 * config", so `WorldConfig` carries no such field, and nothing in this milestone's ABI additions
 * exposes a per-game rate either (Scope names exactly `sim_genesis`/`sim_seal_frame`/
 * `sim_warm_one`). `SimHost` therefore paces at 20 Hz unconditionally; see Deviations for the gap
 * this leaves for a future non-default-rate game.
 */
const TICK_HZ = 20
const TICK_MS = 1000 / TICK_HZ

// ---------------------------------------------------------------------------------------------
// Seed conversion (0024 §5).
// ---------------------------------------------------------------------------------------------

const DECIMAL_SEED = /^[0-9]+$/
const U64_MAX = 0xffffffffffffffffn

/**
 * Decimal text (`WorldConfig.params.seed`) to the engine's `HexU64` config form: `"0x"` plus
 * lowercase hex, no padding (`abi::config::HexU64`'s `Deserialize` accepts 1 to 16 hex digits, so
 * `"0"` -> `"0x0"` round-trips through Rust exactly as `"18446744073709551615"` ->
 * `"0xffffffffffffffff"` does). Throws on a sign, non-decimal text, or a value past 2^64 - 1.
 */
export function seedToHexU64(seed: string): string {
  if (!DECIMAL_SEED.test(seed)) {
    throw new Error(`createSimHost: seed must be decimal digits, got ${JSON.stringify(seed)}`)
  }
  const n = BigInt(seed)
  if (n > U64_MAX) {
    throw new Error(`createSimHost: seed exceeds u64 (2^64 - 1): ${seed}`)
  }
  return `0x${n.toString(16)}`
}

/** `WorldConfig` -> the sim role's `InstanceConfig` (Scope "Sim-role config"). Pure: no
 * instantiation, so the seed conversion is testable without a module. */
export function buildSimInstanceConfig(cfg: WorldConfig): InstanceConfig {
  return {
    arenaBytes: cfg.arenaBytes ?? 96 * 1024 * 1024,
    game: {
      seed: seedToHexU64(cfg.params.seed),
      params: cfg.params.worldgen,
      maxEntities: cfg.params.maxEntities,
      maxModifiedTiles: cfg.params.maxModifiedTiles,
      maxActionGrowth: cfg.params.maxActionGrowth,
      cacheChunks: cfg.cacheChunks,
    },
  }
}

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
}

/** The real adapter: `SimInstance` over a real `EngineInstance` (role `Sim`). */
export function wrapEngineInstance(inst: EngineInstance): SimInstance {
  return {
    simGenesis: () => inst.call0(inst.x.sim_genesis),
    simTick: () => inst.call0(inst.x.sim_tick),
    simSealFrame: () => {
      const raw = inst.call0(inst.x.sim_seal_frame)
      if (raw < 0) throw new Error(`sim_seal_frame failed: status ${-raw}`)
      if (raw === 0) return { len: 0 }
      const region = inst.region(RegionId.Persist)
      if (!region) throw new Error('sim_seal_frame: len > 0 but the Persist region is absent')
      return { len: raw, bytes: region.u8.subarray(0, raw) }
    },
    simHash: () => {
      const status = inst.call0(inst.x.sim_hash)
      if (status !== Status.Ok) throw new Error(`sim_hash failed: status ${status}`)
      return inst.readU64Hex(RegionId.Result, 0)
    },
    simWarmOne: () => inst.call0(inst.x.sim_warm_one),
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
  /** Disarms the pacing timer. Counters and `base` are left as they are. */
  stop(): void
  /** Disarms the pacing timer (0005: "a paused host stops calling `sim_tick`, nothing is
   * logged"); the paused wall-clock interval is invisible to `resume()`'s pacing. */
  pause(): void
  /** Re-arms the pacing timer, shifting `base` forward by however long `pause()` lasted. */
  resume(): void
  /** Runs `n` ticks synchronously through the same tick procedure `onFire` uses, bypassing the
   * pacing timer entirely (a manual driver for tests and `engine/test`'s `stepTick`). */
  stepTick(n?: number): void
  hash(): string
  readonly counters: SimHostCounters
  logSink: ((bytes: Uint8Array) => void) | null
}

type TimerServices = Pick<HostServices, 'clock' | 'timer'>

/** The shared implementation, over an already-built [`SimInstance`] -- real or fake. */
export function createSimHostFromInstance(sim: SimInstance, services: TimerServices): SimHost {
  const counters: SimHostCounters = {
    ticksRun: 0,
    ticksDropped: 0,
    tickOverruns: 0,
    chunksWarmed: 0,
    genOnMiss: 0,
  }
  let genesisDone = false
  let running = false
  let stopTimer: (() => void) | null = null
  /** Wall-clock time (`services.clock.now()`) at which `counters.ticksRun` was 0. */
  let base = 0
  let pausedAt: number | null = null

  function ensureGenesis(): void {
    if (genesisDone) return
    const status = sim.simGenesis()
    if (status !== Status.Ok && status !== Status.AlreadyInitialised) {
      throw new Error(`sim_genesis failed: status ${status}`)
    }
    genesisDone = true
  }

  /** The tick procedure (Scope: "one function, the only caller of the tick exports"): `len =
   * sim_seal_frame()`; if `len > 0` call `logSink`; `sim_tick()`; the per-connection frame pass
   * (empty until M15b, Non-scope). */
  function runOneTick(): void {
    const seal = sim.simSealFrame()
    if (seal.len > 0 && host.logSink) host.logSink(seal.bytes as Uint8Array)
    const status = sim.simTick()
    if (status !== Status.Ok) throw new Error(`sim_tick failed: status ${status}`)
    counters.ticksRun++
  }

  function runOneTickTimed(): void {
    const tickStart = services.clock.now()
    runOneTick()
    if (services.clock.now() - tickStart > TICK_MS) counters.tickOverruns++
  }

  function warm(): void {
    const warmStart = services.clock.now()
    // The next not-yet-run tick's own deadline (tick `ticksRun` has just run; tick `ticksRun + 1`
    // is next).
    const nextDeadline = base + (counters.ticksRun + 1) * TICK_MS
    const deadline = Math.min(nextDeadline, warmStart + WARM_BUDGET_MS)
    while (services.clock.now() < deadline) {
      if (sim.simWarmOne() !== 1) break
      counters.chunksWarmed++
    }
  }

  /** Pacing (Scope): on each timer fire, run at most `MAX_CATCHUP_TICKS` due ticks, dropping
   * (and counting) the rest by moving `base` forward so sim time falls behind wall time. */
  function onFire(): void {
    const now = services.clock.now()
    const due = Math.floor((now - base) / TICK_MS) - counters.ticksRun
    if (due <= 0) return
    const runCount = Math.min(due, MAX_CATCHUP_TICKS)
    if (due > MAX_CATCHUP_TICKS) {
      const dropped = due - MAX_CATCHUP_TICKS
      base += dropped * TICK_MS
      counters.ticksDropped += dropped
    }
    for (let i = 0; i < runCount; i++) runOneTickTimed()
    warm()
  }

  function arm(): void {
    stopTimer = services.timer.every(TICK_MS, onFire)
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
      if (pausedAt !== null) {
        base += services.clock.now() - pausedAt
        pausedAt = null
      } else if (counters.ticksRun === 0) {
        base = services.clock.now()
      }
      running = true
      arm()
    },
    stop() {
      disarm()
      running = false
      pausedAt = null
    },
    pause() {
      if (!running) return
      disarm()
      pausedAt = services.clock.now()
      running = false
    },
    resume() {
      if (running) return
      ensureGenesis()
      if (pausedAt !== null) {
        base += services.clock.now() - pausedAt
        pausedAt = null
      }
      running = true
      arm()
    },
    stepTick(n = 1) {
      ensureGenesis()
      for (let i = 0; i < n; i++) runOneTickTimed()
    },
    hash() {
      return sim.simHash()
    },
    counters,
    logSink: null,
  }
  return host
}

/** `createSimHost(cfg, services)` (Provides): instantiates a real `role=sim` instance from
 * `services.wasm` and drives it through [`createSimHostFromInstance`]. */
export function createSimHost(cfg: WorldConfig, services: HostServices): SimHost {
  const inst = instantiate(services.wasm, Role.Sim, buildSimInstanceConfig(cfg))
  return createSimHostFromInstance(wrapEngineInstance(inst), services)
}
