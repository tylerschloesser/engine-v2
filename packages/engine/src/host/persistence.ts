// The write side of 0005 Persistence (docs/plan/22-persistence-log-and-snapshots.md steps 4-6):
// creates a fresh world (manifest + segment 0), the write-ahead `appendFrame` `SimHost.logSink`
// points at, the `sync`/snapshot cadence (0005 Cadence) driven from `afterTick`, and `flush()`.
// Loading a stored world, segment rolling and pruning are M22b's (Non-scope here): `Persistence.
// create` always starts a brand new world, in one segment, forever (this milestone).
import { RegionId, Status } from '../abi.js'
import type { EngineInstance } from '../loader.js'
import type { WorldConfig } from '../sim-config.js'
import type { Storage, WorldKeys } from '../storage/types.js'
import { worldKeys } from '../storage/types.js'

/** `sim_segment_header`'s own sentinel (`crates/engine/src/host/mod.rs`'s `GENESIS_BASE_TICK`):
 * `baseTick` equal to this means `SegmentBase::Genesis`. */
const GENESIS_BASE_TICK = 0xffff_ffff

/** 0005 Cadence: "a snapshot every 60 s of sim time (1,200 ticks at 20 Hz)". Planning decisions
 * names this as a tick count, not scaled by the game's own tick rate. */
const SNAPSHOT_EVERY_TICKS = 1200

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** JSON mirror of `persist::Identity`'s wire shape (0005 "Sim identity"). The manifest is "host
 * metadata, UTF-8 JSON" (Planning decisions 3) that never parses a Rust container again on its own
 * read path -- this is the one place that *does* have to decode one, right after
 * `sim_segment_header` produces it, so the manifest can carry the result as plain JSON. */
export interface IdentityJson {
  /** Hex, lowercase, 32 digits: the first 128 bits of the build hash (0005). */
  buildHash: string
  engineVersion: string
  gameVersion: string
  schemaVersion: number
  tickRateHz: number
  /** `fingerprint` as decimal text: a `u64` does not always fit a JS number. */
  worldgen: { version: number; fingerprint: string }
}

export interface ManifestSegment {
  index: number
  identity: IdentityJson
  base: 'genesis' | number
  sealed: boolean
  tailReexecuted: boolean
}

/** Planning decisions 3, verbatim shape: `{ v: 1, worldId, epoch: 0, params, created, segments }`.
 * `epoch` is reserved (M28b owns and increments it); `params` is `WorldConfig.params`, verbatim. */
export interface ManifestV1 {
  v: 1
  worldId: string
  epoch: 0
  params: WorldConfig['params']
  created: IdentityJson
  segments: ManifestSegment[]
}

function readVarint(bytes: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0
  let shift = 0
  let i = pos
  for (;;) {
    const byte = bytes[i]
    if (byte === undefined) throw new Error('Persistence: truncated identity bytes (varint)')
    i++
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result >>> 0, i]
    shift += 7
  }
}

function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Decodes `persist::Identity::write`'s own wire shape (`crates/engine/src/persist/identity.rs`):
 * `build_hash` (16 raw bytes) | `engine_version`/`game_version` (varint len + UTF-8, each) | u32
 * `schema_version` | u32 `tick_rate_hz` | u32 `worldgen.version` | u64 `worldgen.fingerprint`. */
function decodeIdentity(bytes: Uint8Array): IdentityJson {
  let pos = 0
  const buildHash = toHex(bytes.subarray(pos, pos + 16))
  pos += 16
  const [engLen, afterEngLen] = readVarint(bytes, pos)
  pos = afterEngLen
  const engineVersion = textDecoder.decode(bytes.subarray(pos, pos + engLen))
  pos += engLen
  const [gameLen, afterGameLen] = readVarint(bytes, pos)
  pos = afterGameLen
  const gameVersion = textDecoder.decode(bytes.subarray(pos, pos + gameLen))
  pos += gameLen
  if (pos + 20 > bytes.length) throw new Error('Persistence: truncated identity bytes (tail)')
  const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 20)
  const schemaVersion = view.getUint32(0, true)
  const tickRateHz = view.getUint32(4, true)
  const wgVersion = view.getUint32(8, true)
  const fpLo = view.getUint32(12, true)
  const fpHi = view.getUint32(16, true)
  const fingerprint = ((BigInt(fpHi) << 32n) | BigInt(fpLo)).toString()
  return {
    buildHash,
    engineVersion,
    gameVersion,
    schemaVersion,
    tickRateHz,
    worldgen: { version: wgVersion, fingerprint },
  }
}

/** Planning decisions 1: "the host copies blocks into one JS-side `SnapshotBuffer` (an
 * `ArrayBuffer` that doubles when too small, a rare discontinuity under 0016 §2)". Exposes its own
 * high-water mark (Budgets "Memory per instance": "host-side `SnapshotBuffer` high-water mark
 * exposed as a counter"). Grows at most once per 1,200-tick snapshot cadence, never per tick, so
 * `.claude/rules/hot-paths.md`'s no-allocation-per-tick rule does not apply to it. */
class SnapshotBuffer {
  private buf: Uint8Array
  private len = 0
  highWaterBytes = 0

  constructor(initialBytes = 64 * 1024) {
    this.buf = new Uint8Array(initialBytes)
  }

  reset(): void {
    this.len = 0
  }

  append(chunk: Uint8Array): void {
    if (this.len + chunk.length > this.buf.length) {
      let grownLen = this.buf.length * 2
      while (grownLen < this.len + chunk.length) grownLen *= 2
      const grown = new Uint8Array(grownLen)
      grown.set(this.buf.subarray(0, this.len))
      this.buf = grown
    }
    this.buf.set(chunk, this.len)
    this.len += chunk.length
    if (this.len > this.highWaterBytes) this.highWaterBytes = this.len
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
}

export interface PersistenceCounters {
  logBytes: number
  frames: number
  snapshots: number
  lastSnapshotBytes: number
  syncs: number
}

/**
 * The write side of 0005 Persistence (Scope: "create world (manifest + segment 0), write-ahead
 * append, `sync` at most once per second when dirty, snapshot every 1,200 ticks if dirty ...,
 * `flush()`"). One instance per world. `sim` is the raw `EngineInstance` (not `server.ts`'s higher-
 * level `SimInstance`): this class calls the persistence-specific ABI exports
 * (`sim_dirty`/`sim_segment_header`/`sim_snapshot_begin`/`sim_snapshot_next`) directly, alongside
 * `tick_hz` (read once, at construction, the same "read once" convention `SimHost` itself already
 * uses for the same export).
 */
export class Persistence {
  readonly counters: PersistenceCounters = {
    logBytes: 0,
    frames: 0,
    snapshots: 0,
    lastSnapshotBytes: 0,
    syncs: 0,
  }

  private readonly storage: Storage
  private readonly keys: WorldKeys
  private readonly sim: EngineInstance
  private readonly ticksPerSecond: number
  private readonly snapshotBuffer = new SnapshotBuffer()

  /** Single segment, forever (Non-scope here: segment rolling is M22b's). */
  private readonly segment = 0
  /** The host owns the log position (Planning decisions 4): every byte appended so far to
   * `keys.log(segment)`, header included. */
  private logOffset = 0
  /** The most recently completed tick (`afterTick`'s own argument, mirrored here for
   * `snapshotNow`'s own `keys.snap(tick)` key). */
  private tick = 0
  private ticksSinceSnapshotCheck = 0
  private ticksSinceSync = 0
  /** Whether `appendFrame` has run since the last `sync()` -- the sync cadence's own "dirty"
   * (0005: "the storage `sync` barrier runs at most once per second when dirty"), distinct from
   * `sim_dirty()`'s world-state dirty flag the snapshot cadence reads. */
  private appendedSinceSync = false

  /** Set by `Storage.onError` (0005: "a failed or lost write is fatal to the world", 0004) --
   * `appendFrame`/`afterTick`, the tick path's own two entry points, throw on their very next call
   * once this is set, rather than silently continuing to log or snapshot against storage that has
   * already reported a failure. No `onFatal`-style UI event exists yet to raise instead (0005
   * Consequences' own deferred list); throwing is what every other tick-path failure here already
   * does (`sim_tick` returning a bad status, `sim_seal_frame` failing) -- the caller's own error
   * boundary is the same one either way. */
  private fatalError: unknown = undefined

  private constructor(
    storage: Storage,
    keys: WorldKeys,
    sim: EngineInstance,
    ticksPerSecond: number,
  ) {
    this.storage = storage
    this.keys = keys
    this.sim = sim
    this.ticksPerSecond = ticksPerSecond
    storage.onError = (err) => {
      this.fatalError = err
    }
  }

  private checkFatal(): void {
    if (this.fatalError !== undefined) {
      throw new Error(
        `Persistence: a previous storage error is fatal to this world: ${String(this.fatalError)}`,
      )
    }
  }

  /** Creates a brand-new world: writes `ManifestV1` and opens segment 0 with a real
   * `SegmentHeader` (`sim_segment_header(0, GENESIS_BASE_TICK)`) as its first bytes. Synchronous
   * (Seams' own signature has no `Promise`): the two `Storage` calls this makes follow the same
   * "never awaited on this path" convention as `appendFrame` (0005: "the tick path never awaits
   * storage" -- world creation is not the tick path, but nothing here needs the round trip either,
   * and awaiting would change this from a constructor-shaped call to an async one for every
   * caller).
   */
  static create(storage: Storage, cfg: WorldConfig, sim: EngineInstance): Persistence {
    const keys = worldKeys(cfg.worldId)
    const ticksPerSecond = sim.call0(sim.x.tick_hz) || 20
    const p = new Persistence(storage, keys, sim, ticksPerSecond)

    const headerLen = sim.call2(sim.x.sim_segment_header, 0, GENESIS_BASE_TICK)
    if (headerLen < 0) {
      throw new Error(`Persistence.create: sim_segment_header failed: status ${-headerLen}`)
    }
    const region = sim.region(RegionId.Persist)
    if (!region) throw new Error('Persistence.create: the Persist region is absent')
    // Copy now: `region.u8` is the persistent region view, overwritten by the next export call
    // that touches it (`.claude/rules/hot-paths.md`'s own "whole region view" convention).
    const headerBytes = region.u8.slice(0, headerLen)
    const identity = decodeIdentity(headerBytes)

    const manifest: ManifestV1 = {
      v: 1,
      worldId: cfg.worldId,
      epoch: 0,
      params: cfg.params,
      created: identity,
      segments: [{ index: 0, identity, base: 'genesis', sealed: false, tailReexecuted: false }],
    }
    storage.write(keys.manifest, textEncoder.encode(JSON.stringify(manifest)))
    storage.append(keys.log(0), headerBytes)
    p.logOffset = headerBytes.length

    return p
  }

  /** What `SimHost.logSink` is pointed at (`host.logSink = persistence.appendFrame`): a fixed
   * method value, not a per-call closure (`.claude/rules/hot-paths.md`). */
  appendFrame = (bytes: Uint8Array): void => {
    this.checkFatal()
    this.storage.append(this.keys.log(this.segment), bytes)
    this.logOffset += bytes.length
    this.counters.logBytes += bytes.length
    this.counters.frames++
    this.appendedSinceSync = true
  }

  /** Called once per completed tick, right after `sim_tick()` succeeds (Scope: "`sync` at most
   * once per second when dirty, snapshot every 1,200 ticks if dirty"). `tick` is the sim's own
   * tick counter (the same value `SimHostCounters.ticksRun` tracks); cadence itself counts ticks
   * elapsed, independent of `tick`'s absolute value, so it works the same whether `tick` starts at
   * 0 or resumes from a restored world (M22b). */
  afterTick(tick: number): void {
    this.checkFatal()
    this.tick = tick
    this.ticksSinceSnapshotCheck++
    if (this.ticksSinceSnapshotCheck >= SNAPSHOT_EVERY_TICKS) {
      this.ticksSinceSnapshotCheck = 0
      if (this.isDirty()) this.snapshotNow()
    }
    this.ticksSinceSync++
    if (this.appendedSinceSync && this.ticksSinceSync >= this.ticksPerSecond) {
      this.sync()
    }
  }

  private isDirty(): boolean {
    return this.sim.call0(this.sim.x.sim_dirty) !== 0
  }

  private sync(): void {
    this.storage.sync(this.keys.log(this.segment))
    this.counters.syncs++
    this.appendedSinceSync = false
    this.ticksSinceSync = 0
  }

  /** Streams a full snapshot of the current state through `sim_snapshot_begin`/`sim_snapshot_next`
   * and durably replaces `keys.snap(tick)` with one `Storage.write` call (0005 Formats: "written to
   * a temp key, then atomically replaced" is the adapter's own job, not this call's). Public:
   * `afterTick`'s own cadence calls it, and a clean-boundary caller (pause, `stop()`, M23's export)
   * may call it directly too.
   */
  snapshotNow(): void {
    const beginStatus = this.sim.call2(this.sim.x.sim_snapshot_begin, this.segment, this.logOffset)
    if (beginStatus !== Status.Ok) {
      throw new Error(`Persistence.snapshotNow: sim_snapshot_begin failed: status ${beginStatus}`)
    }
    const region = this.sim.region(RegionId.Persist)
    if (!region) throw new Error('Persistence.snapshotNow: the Persist region is absent')
    this.snapshotBuffer.reset()
    for (;;) {
      const n = this.sim.call0(this.sim.x.sim_snapshot_next)
      if (n < 0) {
        throw new Error(`Persistence.snapshotNow: sim_snapshot_next failed: status ${-n}`)
      }
      if (n === 0) break
      this.snapshotBuffer.append(region.u8.subarray(0, n))
    }
    const bytes = this.snapshotBuffer.bytes()
    this.storage.write(this.keys.snap(this.tick), bytes)
    this.counters.snapshots++
    this.counters.lastSnapshotBytes = bytes.length
  }

  /** The `SnapshotBuffer`'s own high-water mark, alongside the Rust-side `SnapshotWriter`'s own
   * `total_len()` (Budgets "Memory per instance"; measured together, see this milestone's own
   * Deviations). */
  get snapshotBufferHighWaterBytes(): number {
    return this.snapshotBuffer.highWaterBytes
  }

  /** 0005: "The host awaits `flush()` at the clean boundaries of Cadence ... and nowhere else." */
  flush(): Promise<void> {
    return Promise.resolve(this.storage.flush())
  }
}
