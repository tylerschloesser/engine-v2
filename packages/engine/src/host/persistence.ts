// The write side of 0005 Persistence (docs/plan/22-persistence-log-and-snapshots.md steps 4-6):
// creates a fresh world (manifest + segment 0), the write-ahead `appendFrame` `SimHost.logSink`
// points at, the `sync`/snapshot cadence (0005 Cadence) driven from `afterTick`, and `flush()`.
//
// docs/plan/22b-persistence-load-and-fs.md adds the load side: `Persistence.open` (create-or-load,
// recovery from whatever a crash left) and `Persistence.loadLatest` (the snapshot + tail-replay
// step on its own, a static helper rather than an instance method -- at the point it runs there is
// no live `Persistence` yet for `open`'s own "no manifest" branch to have skipped past). Segment
// rolling and pruning are also here (this brief's own step 3).
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

/** Planning decisions 2: the open segment rolls when it exceeds this many bytes, at the moment a
 * periodic snapshot is written; that snapshot becomes the new segment's base. */
const SEGMENT_ROLL_BYTES = 4 * 1024 * 1024

/** docs/plan/22b-persistence-load-and-fs.md Seams: the segment-roll option a test lowers to
 * exercise rolling without writing `SEGMENT_ROLL_BYTES` of log. `snapshotEveryTicks`
 * (docs/plan/23-persistence-opfs-and-lifecycle.md, coordinator fix round 1): the same idea for the
 * *snapshot* cadence -- a real, continuously-paced OPFS behavioural test needs several periodic
 * snapshots inside a `@slow`-free few seconds, far short of 1,200 real ticks at 20 Hz. */
export interface PersistenceOptions {
  segmentRollBytes?: number
  snapshotEveryTicks?: number
}

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

/** docs/plan/22b-persistence-load-and-fs.md Seams: thrown by `Persistence.open`/`loadLatest` when
 * a stored world cannot simply be loaded. `identity`: the running build's own identity differs from
 * the stored one (0005 Upgrades; M24b turns this into the upgrade path -- here it is reported, not
 * handled, and nothing is written). `corrupt`: every candidate snapshot (and, if segment 0 is all
 * there ever was, the log itself) failed to decode. `container`: reserved for a future container-
 * version mismatch the engine cannot even attempt (nothing raises this yet: a version mismatch on a
 * single candidate snapshot is instead treated the same as `corrupt`, falling back to an older one,
 * since a *newer* running build can still read an *older* segment's own untouched history). */
export class WorldLoadError extends Error {
  readonly kind: 'identity' | 'corrupt' | 'container'
  readonly running: IdentityJson
  readonly stored?: IdentityJson

  constructor(
    kind: 'identity' | 'corrupt' | 'container',
    running: IdentityJson,
    stored?: IdentityJson,
  ) {
    super(`WorldLoadError: ${kind}`)
    this.name = 'WorldLoadError'
    this.kind = kind
    this.running = running
    if (stored !== undefined) this.stored = stored
  }
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
  private readonly segmentRollBytes: number
  private readonly snapshotEveryTicks: number
  private readonly snapshotBuffer = new SnapshotBuffer()
  /** Host metadata (Planning decisions 3), kept in memory and rewritten on a roll or a self-heal
   * (`healManifest`) -- `pruneSnapshots`'s own "every segment's base" question reads this, not
   * storage, so it must stay current. */
  private manifest: ManifestV1

  /** The currently open segment's index. `0` for a brand-new world; whatever `Persistence.open`'s
   * own load found (a restored snapshot's `logSegment`, or `0` for a genesis-based load) otherwise.
   * Mutable since docs/plan/22b-persistence-load-and-fs.md step 3: segment rolling changes it. */
  private segment: number
  /** The host owns the log position (Planning decisions 4): every byte appended so far to
   * `keys.log(segment)`, header included. */
  private logOffset: number
  /** The most recently completed tick (`afterTick`'s own argument, mirrored here for
   * `snapshotNow`'s own `keys.snap(tick)` key). */
  private tick: number
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
    manifest: ManifestV1,
    opts: PersistenceOptions = {},
    initial: { segment: number; logOffset: number; tick: number } = {
      segment: 0,
      logOffset: 0,
      tick: 0,
    },
  ) {
    this.storage = storage
    this.keys = keys
    this.sim = sim
    this.ticksPerSecond = ticksPerSecond
    this.segmentRollBytes = opts.segmentRollBytes ?? SEGMENT_ROLL_BYTES
    this.snapshotEveryTicks = opts.snapshotEveryTicks ?? SNAPSHOT_EVERY_TICKS
    this.manifest = manifest
    this.segment = initial.segment
    this.logOffset = initial.logOffset
    this.tick = initial.tick
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
  static create(
    storage: Storage,
    cfg: WorldConfig,
    sim: EngineInstance,
    opts: PersistenceOptions = {},
  ): Persistence {
    const keys = worldKeys(cfg.worldId)
    const ticksPerSecond = sim.call0(sim.x.tick_hz) || 20

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
    const p = new Persistence(storage, keys, sim, ticksPerSecond, manifest, opts)
    storage.write(keys.manifest, textEncoder.encode(JSON.stringify(manifest)))
    storage.append(keys.log(0), headerBytes)
    p.logOffset = headerBytes.length

    return p
  }

  /** docs/plan/22b-persistence-load-and-fs.md Seams: create-or-load. No stored manifest -> exactly
   * `Persistence.create`'s own path (`outcome: 'created'`); a stored manifest -> `loadLatest` picks
   * the newest snapshot whose CRC verifies (falling back to older ones, then to a genesis replay of
   * segment 0 if none verify), replays the tail, truncates a torn one, and this wraps the result in
   * a live `Persistence` continuing from exactly where the load left off. `newInstance` is called
   * once for `'created'`, and at least once (more on a corrupt/torn snapshot candidate) for a load:
   * each attempt gets its own fresh instance rather than retrying restore on one (`sim_restore_begin`
   * consumes the config's world params it needs, so a fresh instance is simplest and matches 0005
   * Panic recovery's own "fresh instance, latest valid snapshot" pattern).
   */
  static async open(
    storage: Storage,
    cfg: WorldConfig,
    newInstance: () => EngineInstance,
    opts: PersistenceOptions = {},
  ): Promise<{
    persistence: Persistence
    sim: EngineInstance
    outcome: 'created' | 'loaded' | 'recovered'
    tick: number
    truncatedBytes: number
  }> {
    const keys = worldKeys(cfg.worldId)
    const manifestBytes = await storage.read(keys.manifest)
    if (manifestBytes === null) {
      const sim = newInstance()
      const persistence = Persistence.create(storage, cfg, sim, opts)
      return { persistence, sim, outcome: 'created', tick: 0, truncatedBytes: 0 }
    }

    const manifest: ManifestV1 = JSON.parse(textDecoder.decode(manifestBytes)) as ManifestV1
    const loaded = await Persistence.loadLatest(storage, keys, manifest, newInstance)
    const healedManifest = await Persistence.healManifest(storage, keys, manifest, loaded)
    const ticksPerSecond = loaded.sim.call0(loaded.sim.x.tick_hz) || 20
    const persistence = new Persistence(
      storage,
      keys,
      loaded.sim,
      ticksPerSecond,
      healedManifest,
      opts,
      { segment: loaded.logSegment, logOffset: loaded.logOffset, tick: loaded.tick },
    )
    // Planning decisions 3: pruning runs "at the next clean boundary or load", once the chosen
    // snapshot has been read back and verified -- exactly what `loadLatest` just did.
    await persistence.pruneSnapshots()
    return {
      persistence,
      sim: loaded.sim,
      outcome: loaded.outcome,
      tick: loaded.tick,
      truncatedBytes: loaded.truncatedBytes,
    }
  }

  /** docs/plan/22b-persistence-load-and-fs.md Seams: "the snapshot + tail step on its own, reused
   * by M24 after a trap". A `static` helper, not an instance method: at the point it runs (from
   * `Persistence.open`'s own "manifest exists" branch) there is no live `Persistence` yet to call it
   * on. M24 (re-instantiation after a trap, Non-scope here) would call this the same way, with a
   * fresh `newInstance` and the manifest its own now-garbage `Persistence` already holds, and swap
   * the result's `sim` in -- not built here.
   *
   * Algorithm (0005 Recovery): the running build's own identity is checked first (`sim_segment_
   * header(0, GENESIS_BASE_TICK)`, which needs no genesis) against `manifest.created` -- a mismatch
   * throws before touching anything else (Non-scope: identity mismatch is reported, M24b handles
   * it). Then every `snap/` key, newest tick first: restore it (a fresh instance per candidate); a
   * bad CRC/container version, or a `logOffset` beyond what its own segment's log actually holds
   * (Planning decisions 3: "a snapshot naming a segment offset beyond the segment's valid end is
   * skipped as if its CRC failed"), moves on to the next-older one. If none verify, replay from
   * genesis (always segment 0: Planning decisions 2, rolling only ever happens at a snapshot, so no
   * roll can exist with no snapshot surviving it). Either way, the segment's own tail (from the
   * chosen log position onward) is replayed and any torn frame truncated (Planning decisions 1:
   * `Storage.write`, not a `truncate` this interface has no room for).
   */
  static async loadLatest(
    storage: Storage,
    keys: WorldKeys,
    manifest: ManifestV1,
    newInstance: () => EngineInstance,
  ): Promise<{
    sim: EngineInstance
    logSegment: number
    logOffset: number
    /** The chosen base's own tick (the restored snapshot's tick, or `0` for a genesis base) --
     * `healManifest`'s own "what base does a newly-discovered segment carry" question. */
    baseTick: number
    tick: number
    truncatedBytes: number
    outcome: 'loaded' | 'recovered'
  }> {
    let inst = newInstance()
    const headerLen = inst.call2(inst.x.sim_segment_header, 0, GENESIS_BASE_TICK)
    if (headerLen < 0) {
      throw new Error(`Persistence.loadLatest: sim_segment_header failed: status ${-headerLen}`)
    }
    const headerRegion = inst.region(RegionId.Persist)
    if (!headerRegion) throw new Error('Persistence.loadLatest: the Persist region is absent')
    const runningIdentity = decodeIdentity(headerRegion.u8.slice(0, headerLen))
    if (runningIdentity.buildHash !== manifest.created.buildHash) {
      throw new WorldLoadError('identity', runningIdentity, manifest.created)
    }

    const snapPrefix = `worlds/${manifest.worldId}/snap/`
    // Zero-padded decimal ticks (`worldKeys`'s own convention): a lexicographic sort is a numeric
    // one too; reversed, newest first (0005 Recovery: "newest snapshot whose CRC verifies").
    const snapKeys = [...(await storage.list(snapPrefix))].sort().reverse()

    let recovered = false
    let usedInstance = false
    let picked: { logSegment: number; logOffset: number; baseTick: number } | null = null

    for (const key of snapKeys) {
      const bytes = await storage.read(key)
      if (!bytes) continue
      if (usedInstance) inst = newInstance()
      usedInstance = true

      const beginStatus = inst.call1(inst.x.sim_restore_begin, bytes.length)
      const region = inst.region(RegionId.Persist)
      if (!region) throw new Error('Persistence.loadLatest: the Persist region is absent')
      let pushesOk = beginStatus === Status.Ok
      if (pushesOk) {
        for (let off = 0; off < bytes.length; ) {
          const n = Math.min(region.len, bytes.length - off)
          region.u8.set(bytes.subarray(off, off + n), 0)
          const pushStatus = inst.call1(inst.x.sim_restore_push, n)
          if (pushStatus !== Status.Ok) {
            pushesOk = false
            break
          }
          off += n
        }
      }
      const endStatus = inst.call0(inst.x.sim_restore_end)
      if (endStatus === Status.IdentityMismatch) {
        throw new WorldLoadError('identity', runningIdentity, manifest.created)
      }
      if (!pushesOk || endStatus !== Status.Ok) {
        recovered = true
        continue
      }
      const result = inst.region(RegionId.Result)
      if (!result) throw new Error('Persistence.loadLatest: the Result region is absent')
      const view = new DataView(result.u8.buffer, result.u8.byteOffset, 8)
      const logSegment = view.getUint32(0, true)
      const logOffset = view.getUint32(4, true)
      const baseTick = inst.call0(inst.x.sim_tick_now)
      const logBytes = await storage.read(keys.log(logSegment))
      if (!logBytes || logBytes.length < logOffset) {
        // Planning decisions 3: the snapshot itself verified, but names a log position its own
        // segment's stored bytes do not reach -- treated the same as a failed CRC.
        recovered = true
        continue
      }
      picked = { logSegment, logOffset, baseTick }
      break
    }

    if (!picked) {
      if (usedInstance) inst = newInstance()
      const h = inst.call2(inst.x.sim_segment_header, 0, GENESIS_BASE_TICK)
      if (h < 0) throw new Error(`Persistence.loadLatest: sim_segment_header failed: status ${-h}`)
      const genStatus = inst.call0(inst.x.sim_genesis)
      if (genStatus !== Status.Ok) {
        throw new Error(`Persistence.loadLatest: sim_genesis failed: status ${genStatus}`)
      }
      picked = { logSegment: 0, logOffset: h, baseTick: 0 }
      if (snapKeys.length > 0) recovered = true // snapshots existed; none of them were usable
    }

    const { logSegment, logOffset, baseTick } = picked
    const logBytes = (await storage.read(keys.log(logSegment))) ?? new Uint8Array(0)
    const tail = logBytes.subarray(logOffset)
    const replayRegion = inst.region(RegionId.Persist)
    if (!replayRegion) throw new Error('Persistence.loadLatest: the Persist region is absent')
    // docs/plan/24-recovery-and-migration.md: the scan pass runs once, over the whole tail, before
    // the real apply pass below -- a `Skip` record's own target can live in an earlier frame than
    // the `Skip` record itself, so every frame must be seen before any of them is safely applied.
    const beginScan = inst.call1(inst.x.sim_replay_scan_begin, logSegment)
    if (beginScan !== Status.Ok) {
      throw new Error(`Persistence.loadLatest: sim_replay_scan_begin failed: status ${beginScan}`)
    }
    for (let off = 0; off < tail.length; ) {
      const n = Math.min(replayRegion.len, tail.length - off)
      replayRegion.u8.set(tail.subarray(off, off + n), 0)
      inst.call1(inst.x.sim_replay_scan_push, n)
      off += n
    }
    inst.call0(inst.x.sim_replay_scan_end)
    const beginReplay = inst.call2(inst.x.sim_replay_begin, logSegment, logOffset)
    if (beginReplay !== Status.Ok) {
      throw new Error(`Persistence.loadLatest: sim_replay_begin failed: status ${beginReplay}`)
    }
    for (let off = 0; off < tail.length; ) {
      const n = Math.min(replayRegion.len, tail.length - off)
      replayRegion.u8.set(tail.subarray(off, off + n), 0)
      inst.call1(inst.x.sim_replay_push, n)
      off += n
    }
    const endReplay = inst.call0(inst.x.sim_replay_end)
    const validEnd = inst.call0(inst.x.sim_replay_valid_end)
    let truncatedBytes = 0
    if (endReplay === Status.TornTail || validEnd < logBytes.length) {
      truncatedBytes = logBytes.length - validEnd
      if (truncatedBytes > 0) {
        // Planning decisions 1: `Storage.write`, since `Storage` has no `truncate` -- adapters must
        // accept `append` after `write` on the same key (the conformance helper asserts it).
        await storage.write(keys.log(logSegment), logBytes.subarray(0, validEnd))
      }
      recovered = true
    }
    const tick = inst.call0(inst.x.sim_tick_now)
    return {
      sim: inst,
      logSegment,
      logOffset: validEnd,
      baseTick,
      tick,
      truncatedBytes,
      outcome: recovered ? 'recovered' : 'loaded',
    }
  }

  /** docs/plan/22b-persistence-load-and-fs.md step 3: `loadLatest`'s own segment discovery (via
   * `storage.list`/decoded snapshot bytes) never trusts `manifest.segments` -- proven by
   * `crash_before_manifest_rewrite_on_roll`, a crash between a roll's own log/snapshot writes and
   * its manifest rewrite. This is the self-heal: if the loaded segment is not the manifest's own
   * last-known one, the manifest is rewritten to match (the old last entry sealed, a new one added)
   * so a *second* load does not need to repeat this discovery. Best-effort and off the tick path:
   * failure here does not fail the load itself, since `loadLatest` has already succeeded by the time
   * this runs. */
  private static async healManifest(
    storage: Storage,
    keys: WorldKeys,
    manifest: ManifestV1,
    loaded: { logSegment: number; baseTick: number },
  ): Promise<ManifestV1> {
    const lastIndex = manifest.segments.at(-1)?.index ?? -1
    if (loaded.logSegment <= lastIndex) return manifest
    const healed: ManifestV1 = {
      ...manifest,
      segments: [
        ...manifest.segments.map((s, i) =>
          i === manifest.segments.length - 1 ? { ...s, sealed: true } : s,
        ),
        {
          index: loaded.logSegment,
          identity: manifest.created,
          base: loaded.logSegment === 0 ? 'genesis' : loaded.baseTick,
          sealed: false,
          tailReexecuted: false,
        },
      ],
    }
    await storage.write(keys.manifest, textEncoder.encode(JSON.stringify(healed)))
    return healed
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
    if (this.ticksSinceSnapshotCheck >= this.snapshotEveryTicks) {
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

  /** docs/plan/22b-persistence-load-and-fs.md step 3: the clean-boundary snapshot (0005 Cadence:
   * "at every clean boundary the host can detect"; 0013 World lifecycle: zero-player pause, then an
   * idle timeout snapshots too -- the 30 s timer and `onIdle` themselves are M27/M28b's). Same guard
   * as the periodic cadence: only if `sim_dirty()`. `SimHost.pause()`/`stop()` call this, then await
   * `flush()`. */
  snapshotIfDirty(): void {
    this.checkFatal()
    if (this.isDirty()) this.snapshotNow()
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
    const rolled = this.rollSegmentIfNeeded()
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
    if (rolled) {
      // docs/plan/22b-persistence-load-and-fs.md step 3: the manifest rewrite lands *last*, after
      // the new segment's own header and its base snapshot are both already durable -- so a crash
      // between them and this write leaves real, self-describing data behind and only a stale
      // manifest (`loadLatest`'s own segment discovery never trusts it anyway; `healManifest`
      // fixes it up on the next load). Proven by `crash_before_manifest_rewrite_on_roll`.
      this.storage.write(this.keys.manifest, textEncoder.encode(JSON.stringify(this.manifest)))
    }
  }

  /** The `SnapshotBuffer`'s own high-water mark, alongside the Rust-side `SnapshotWriter`'s own
   * `total_len()` (Budgets "Memory per instance"; measured together, see this milestone's own
   * Deviations). */
  get snapshotBufferHighWaterBytes(): number {
    return this.snapshotBuffer.highWaterBytes
  }

  /** Planning decisions 2: seals the currently open segment and opens a new one, based on the tick
   * `snapshotNow`'s own caller is about to snapshot at, when the open segment's byte length has
   * reached `segmentRollBytes`. Called from `snapshotNow` itself, before `sim_snapshot_begin` --
   * "the roll happens at the moment a periodic snapshot is written". Off the tick path in the same
   * sense `snapshotNow` already is (only reached from `afterTick`'s own 1,200-tick cadence or a
   * clean boundary, never every tick): the `Storage.append` call here follows the same fire-and-
   * forget convention as `snapshotNow`'s own `storage.write`, not awaited. Updates `this.manifest`
   * in memory, but does **not** write it to storage -- `snapshotNow` does that itself, last, after
   * the new segment's own base snapshot is also durable (see its own doc comment on why the order
   * matters). Returns whether a roll happened. */
  private rollSegmentIfNeeded(): boolean {
    if (this.logOffset < this.segmentRollBytes) return false
    const newSegment = this.segment + 1
    const headerLen = this.sim.call2(this.sim.x.sim_segment_header, newSegment, this.tick)
    if (headerLen < 0) {
      throw new Error(`Persistence.snapshotNow: sim_segment_header failed: status ${-headerLen}`)
    }
    const region = this.sim.region(RegionId.Persist)
    if (!region) throw new Error('Persistence.snapshotNow: the Persist region is absent')
    const headerBytes = region.u8.slice(0, headerLen)
    this.storage.append(this.keys.log(newSegment), headerBytes)

    const lastIndex = this.manifest.segments.length - 1
    this.manifest = {
      ...this.manifest,
      segments: [
        ...this.manifest.segments.map((s, i) => (i === lastIndex ? { ...s, sealed: true } : s)),
        {
          index: newSegment,
          identity: this.manifest.created,
          base: this.tick,
          sealed: false,
          tailReexecuted: false,
        },
      ],
    }

    this.segment = newSegment
    this.logOffset = headerBytes.length
    return true
  }

  /** Planning decisions 3: "pruned to the base snapshot of every segment plus the latest two",
   * "kept until the new one verifies". Off the tick path (needs `Storage.list`, 0005's own "off the
   * tick path only" list): called from a clean boundary (`SimHost.pause`/`stop`, after
   * `snapshotIfDirty`) and after a successful `Persistence.open` load, never from the periodic
   * `afterTick` cadence itself.
   */
  async pruneSnapshots(): Promise<void> {
    const prefix = `worlds/${this.manifest.worldId}/snap/`
    // Zero-padded decimal ticks (`worldKeys`'s own convention): a lexicographic sort is numeric too.
    const allKeys = [...(await this.storage.list(prefix))].sort()
    const keep = new Set<string>()
    for (const seg of this.manifest.segments) {
      if (typeof seg.base === 'number') keep.add(this.keys.snap(seg.base))
    }
    for (const k of allKeys.slice(-2)) keep.add(k)
    for (const k of allKeys) {
      if (!keep.has(k)) await this.storage.delete(k)
    }
  }

  /** 0005: "The host awaits `flush()` at the clean boundaries of Cadence ... and nowhere else." */
  flush(): Promise<void> {
    return Promise.resolve(this.storage.flush())
  }
}
