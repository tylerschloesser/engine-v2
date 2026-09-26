// `engine/test` (docs/decisions/0020 §8; docs/plan/22b-persistence-load-and-fs.md Order of work
// step 5): `replayWorld`/`runHeavy`, the JS-driven equivalents of `engine::testing::replay`/`heavy`
// (Rust, `crates/engine/src/testing/replay.rs`) -- but over a *stored* world (a real `Storage` plus
// `worldId`), walking every segment the manifest names through the same `sim_restore_*`/
// `sim_replay_*`/`sim_segment_header` ABI drivers `Persistence.loadLatest` already uses, never a
// hand-built container. Test-only: `src/test/**` is exempt from `.claude/rules/hot-paths.md`.
//
// Planning decisions 5 (docs/plan/22-persistence-log-and-snapshots.md): "full-history verification
// comes free from segment bases" -- crossing a segment boundary here always asserts the continuous
// replay's own hash at that tick equals the next segment's base snapshot's hash, throwing if not.
// This holds for any `ManifestV1` this milestone's own `Persistence` produces because a roll's base
// snapshot is always taken *immediately* when the new segment opens (before any frame is logged in
// it): `manifest.segments[i].base` (a tick number) is therefore always that segment's own
// `log_ref_tick` too, letting this module derive the tick-delta reference straight from the
// manifest without a wire-level `log_ref_tick` (`sim_restore_end`'s own `Result` output has no room
// for it -- only `logSegment`/`logOffset`, docs/plan/22b-persistence-load-and-fs.md Seams).
import { RegionId, Role, Status } from '../abi.js'
import type { ManifestSegment, ManifestV1 } from '../host/persistence.js'
import type { EngineInstance } from '../loader.js'
import { instantiate } from '../loader.js'
import { buildSimInstanceConfig } from '../sim-config.js'
import type { Storage, WorldKeys } from '../storage/types.js'
import { worldKeys } from '../storage/types.js'

/** `sim_segment_header`'s own sentinel (mirrored from `host/persistence.ts`). */
const GENESIS_BASE_TICK = 0xffff_ffff

const textDecoder = new TextDecoder()

function readVarint(bytes: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0
  let shift = 0
  let i = pos
  for (;;) {
    const byte = bytes[i]
    if (byte === undefined) throw new Error('replay: truncated varint in log bytes')
    i++
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result >>> 0, i]
    shift += 7
  }
}

interface FrameDesc {
  start: number
  end: number
  tickDelta: number
}

/** Scans `log[from..]` for every whole frame (0005 Formats: `len varint | tick_delta varint |
 * count varint | records | crc32`) without decoding a single record -- only the leading `len`
 * (whole body+crc byte count) and the body's own leading `tick_delta` varint are needed to find
 * each frame's byte range and tick. A trailing partial frame (fewer bytes than `len` promises) ends
 * the scan without erroring: this module is never asked to replay past what a caller's own
 * `untilTick`/segment boundary already bounds. */
function scanFrames(log: Uint8Array, from: number): FrameDesc[] {
  const frames: FrameDesc[] = []
  let pos = from
  while (pos < log.length) {
    const [len, bodyStart] = readVarint(log, pos)
    const end = bodyStart + len
    if (end > log.length) break
    const [tickDelta] = readVarint(log, bodyStart)
    frames.push({ start: pos, end, tickDelta })
    pos = end
  }
  return frames
}

function feedBlocks(
  sim: EngineInstance,
  fn: (a: number) => number,
  region: { u8: Uint8Array; len: number },
  bytes: Uint8Array,
): number {
  if (bytes.length === 0) return sim.call1(fn, 0)
  let status: number = Status.Ok
  for (let off = 0; off < bytes.length; ) {
    const n = Math.min(region.len, bytes.length - off)
    region.u8.set(bytes.subarray(off, off + n), 0)
    status = sim.call1(fn, n)
    if (status !== Status.Ok) return status
    off += n
  }
  return status
}

function readHash(sim: EngineInstance): string {
  const status = sim.call0(sim.x.sim_hash)
  if (status !== Status.Ok) throw new Error(`replay: sim_hash failed: status ${status}`)
  return sim.readU64Hex(RegionId.Result, 0)
}

async function readManifest(storage: Storage, keys: WorldKeys): Promise<ManifestV1> {
  const bytes = await storage.read(keys.manifest)
  if (!bytes) throw new Error(`replay: no manifest at ${keys.manifest}`)
  return JSON.parse(textDecoder.decode(bytes)) as ManifestV1
}

/** Genesis (segment 0) or a segment's own base snapshot: one fresh instance, positioned right at
 * the byte offset its own log tail resumes from (Planning decisions 4: "the host owns the log
 * position"). */
async function openSegmentStart(
  storage: Storage,
  keys: WorldKeys,
  seg: ManifestSegment,
  newInstance: () => EngineInstance,
): Promise<{ sim: EngineInstance; offset: number }> {
  if (seg.base === 'genesis') {
    const sim = newInstance()
    const headerLen = sim.call2(sim.x.sim_segment_header, seg.index, GENESIS_BASE_TICK)
    if (headerLen < 0) {
      throw new Error(`replay: sim_segment_header failed: status ${-headerLen}`)
    }
    const genStatus = sim.call0(sim.x.sim_genesis)
    if (genStatus !== Status.Ok) throw new Error(`replay: sim_genesis failed: status ${genStatus}`)
    return { sim, offset: headerLen }
  }
  const snapBytes = await storage.read(keys.snap(seg.base))
  if (!snapBytes) throw new Error(`replay: missing base snapshot for segment ${seg.index}`)
  const sim = newInstance()
  const beginStatus = sim.call1(sim.x.sim_restore_begin, snapBytes.length)
  if (beginStatus !== Status.Ok) {
    throw new Error(`replay: sim_restore_begin failed: status ${beginStatus}`)
  }
  const region = sim.region(RegionId.Persist)
  if (!region) throw new Error('replay: the Persist region is absent')
  const pushStatus = feedBlocks(sim, sim.x.sim_restore_push, region, snapBytes)
  if (pushStatus !== Status.Ok)
    throw new Error(`replay: sim_restore_push failed: status ${pushStatus}`)
  const endStatus = sim.call0(sim.x.sim_restore_end)
  if (endStatus !== Status.Ok)
    throw new Error(`replay: sim_restore_end failed: status ${endStatus}`)
  const result = sim.region(RegionId.Result)
  if (!result) throw new Error('replay: the Result region is absent')
  const offset = new DataView(result.u8.buffer, result.u8.byteOffset, 8).getUint32(4, true)
  return { sim, offset }
}

/** docs/plan/24-recovery-and-migration.md: the scan pass, run once per instance over the whole
 * segment tail (`log.subarray(from)`) *before* `driveCell` ever calls `sim_replay_begin`/`push` on
 * it -- a `Skip` record's own target can live in an earlier frame than the `Skip` record itself,
 * so every frame must be seen once before any of them is safely applied. */
function scanSkipTargets(
  sim: EngineInstance,
  segmentIndex: number,
  log: Uint8Array,
  from: number,
): void {
  const beginStatus = sim.call1(sim.x.sim_replay_scan_begin, segmentIndex)
  if (beginStatus !== Status.Ok) {
    throw new Error(`replay: sim_replay_scan_begin failed: status ${beginStatus}`)
  }
  const region = sim.region(RegionId.Persist)
  if (!region) throw new Error('replay: the Persist region is absent')
  const pushStatus = feedBlocks(sim, sim.x.sim_replay_scan_push, region, log.subarray(from))
  if (pushStatus !== Status.Ok) {
    throw new Error(`replay: sim_replay_scan_push failed: status ${pushStatus}`)
  }
  sim.call0(sim.x.sim_replay_scan_end)
}

/** A mutable holder so a caller (`runHeavy`'s own B run) can swap in a freshly restored instance
 * mid-drive without this module needing to know why. */
interface Cell {
  sim: EngineInstance
}

/**
 * Drives one segment's log tail forward from `startOffset`/`refTick` (the writer's own
 * `last_logged_tick` at that point) up to `untilTick` inclusive, calling `onTick` once per tick
 * reached (whether by manual idle stepping or by applying a logged frame) -- fine per-tick
 * granularity, unlike `sim_replay_push`'s own opaque multi-tick idle catch-up, so a caller
 * (`runHeavy`) can interject at an exact tick. `onTick` may replace `cell.sim`; the next frame push
 * re-arms `sim_replay_begin` on whatever instance is current.
 */
function driveCell(
  cell: Cell,
  log: Uint8Array,
  startOffset: number,
  refTick: number,
  untilTick: number,
  onTick: (tick: number, cell: Cell) => void,
  /** docs/plan/24-recovery-and-migration.md: the real segment index, threaded into
   * `sim_replay_begin(segment, offset)` -- see `rearm`'s own doc comment for why this (and a real
   * `offset`, not `0, 0`) is load-bearing once `Skip` targeting exists. */
  segmentIndex: number,
): void {
  let curTick = cell.sim.call0(cell.sim.x.sim_tick_now)
  let reference = refTick
  let replayReady = false
  /** docs/plan/24-recovery-and-migration.md: `sim_replay_begin`'s own `offset` becomes
   * `self.replay_base_offset`, and a `Skip` target is matched against `replay_base_offset +
   * DecodedFrame::record_offsets[i]` -- the record's *absolute* byte position within the segment
   * (Seams). Before this milestone, `(0, 0)` was harmless (nothing ever computed an absolute
   * offset); once `Skip` targeting is live, `atOffset` must be the true absolute position of
   * whatever byte `sim_replay_push` is about to be fed next (`startOffset` for the very first arm,
   * or a frame's own `f.start` after a mid-drive instance swap re-arms), or `abs_offset` comes out
   * wrong and a `Skip`'s own target is silently never matched (`heavy_mode_restore_mid_skip_
   * matches_uninterrupted_replay`'s own bisection found this: with `(0, 0)`, `PanicInApply`'s own
   * poisoned record was genuinely *applied* here, panicking for real). */
  const rearm = (atOffset: number): void => {
    const beginStatus = cell.sim.call2(cell.sim.x.sim_replay_begin, segmentIndex, atOffset)
    if (beginStatus !== Status.Ok) {
      throw new Error(`replay: sim_replay_begin failed: status ${beginStatus}`)
    }
    replayReady = true
  }
  const tick = (): void => {
    const status = cell.sim.call0(cell.sim.x.sim_tick)
    if (status !== Status.Ok) throw new Error(`replay: sim_tick failed: status ${status}`)
    curTick++
    const before = cell.sim
    onTick(curTick, cell)
    if (cell.sim !== before) replayReady = false
  }

  rearm(startOffset)
  const frames = scanFrames(log, startOffset)
  for (const f of frames) {
    const frameTick = (reference + f.tickDelta) >>> 0
    if (frameTick > untilTick) break
    while (curTick < frameTick - 1) tick()
    if (!replayReady) rearm(f.start)
    const region = cell.sim.region(RegionId.Persist)
    if (!region) throw new Error('replay: the Persist region is absent')
    const pushStatus = feedBlocks(
      cell.sim,
      cell.sim.x.sim_replay_push,
      region,
      log.subarray(f.start, f.end),
    )
    if (pushStatus !== Status.Ok) {
      throw new Error(`replay: sim_replay_push failed: status ${pushStatus}`)
    }
    curTick = frameTick
    reference = frameTick
    const before = cell.sim
    onTick(curTick, cell)
    if (cell.sim !== before) replayReady = false
  }
  while (curTick < untilTick) tick()
}

/** The tick of the last logged frame in `log[from..]`, given `refTick` as the reference at `from`
 * -- heavy mode never replays past what the log actually holds (no idle tail beyond the last real
 * frame: a raw log has no representation of one at all, only the checkpoints a caller compares
 * against do). */
function lastFrameTick(log: Uint8Array, from: number, refTick: number): number {
  let reference = refTick
  for (const f of scanFrames(log, from)) reference = (reference + f.tickDelta) >>> 0
  return reference
}

export interface ReplayWorldOptions {
  wasm: WebAssembly.Module
  storage: Storage
  worldId: string
  checkpoints: number[]
}

/**
 * Seams (docs/plan/22b-persistence-load-and-fs.md): replays a *stored* world from genesis through
 * every segment the manifest names, returning one `{ tick, hash }` per requested checkpoint tick
 * (ascending or not, duplicates collapsed). Crossing a segment boundary asserts the continuous
 * replay's own hash matches that segment's base snapshot's hash (Planning decisions 5); a mismatch
 * throws rather than silently reporting a wrong checkpoint.
 */
export async function replayWorld(
  opts: ReplayWorldOptions,
): Promise<{ tick: number; hash: string }[]> {
  const { wasm, storage, worldId, checkpoints } = opts
  if (checkpoints.length === 0) return []
  const keys = worldKeys(worldId)
  const manifest = await readManifest(storage, keys)
  const cfg = { worldId, buildHash: manifest.created.buildHash, params: manifest.params }
  const newInstance = (): EngineInstance => instantiate(wasm, Role.Sim, buildSimInstanceConfig(cfg))

  const targets = new Set(checkpoints)
  const maxTarget = Math.max(...checkpoints)
  const results = new Map<number, string>()
  let prevHash: string | null = null

  for (let i = 0; i < manifest.segments.length; i++) {
    const seg = manifest.segments[i]
    if (!seg) break
    if (typeof seg.base === 'number' && seg.base > maxTarget) break
    const { sim, offset } = await openSegmentStart(storage, keys, seg, newInstance)
    if (typeof seg.base === 'number') {
      const boundaryHash = readHash(sim)
      if (prevHash !== null && boundaryHash !== prevHash) {
        throw new Error(
          `replayWorld: segment ${seg.index}'s own base snapshot hash (${boundaryHash}) does not ` +
            `match the continuous replay's hash at the same tick (${prevHash}) -- Planning ` +
            'decisions 5 of docs/plan/22-persistence-log-and-snapshots.md',
        )
      }
    }
    const refTick = seg.base === 'genesis' ? 0 : seg.base
    const nextSeg = manifest.segments[i + 1]
    const segEnd = nextSeg && typeof nextSeg.base === 'number' ? nextSeg.base : maxTarget
    const untilTick = Math.min(segEnd, maxTarget)
    const logBytes = (await storage.read(keys.log(seg.index))) ?? new Uint8Array(0)
    scanSkipTargets(sim, seg.index, logBytes, offset)
    const cell: Cell = { sim }
    driveCell(
      cell,
      logBytes,
      offset,
      refTick,
      untilTick,
      (tick) => {
        if (targets.has(tick)) results.set(tick, readHash(cell.sim))
      },
      seg.index,
    )
    prevHash = readHash(cell.sim)
  }

  return checkpoints.map((tick) => {
    const hash = results.get(tick)
    if (hash === undefined)
      throw new Error(`replayWorld: checkpoint tick ${tick} was never reached`)
    return { tick, hash }
  })
}

export interface RunHeavyOptions {
  wasm: WebAssembly.Module
  storage: Storage
  worldId: string
  everyN: number
}

/**
 * Seams: replays a stored world twice -- run A uninterrupted, run B rebuilding a genuinely fresh
 * instance from snapshot bytes alone every `everyN` ticks (never reusing the running one) -- and
 * reports the first tick their hashes diverge, or `null`. Both runs are driven sequentially (not
 * concurrently: they process the identical frame sequence by construction, so their own tick lists
 * line up by index) rather than lock-stepped live, which would need no more from this module.
 */
export async function runHeavy(
  opts: RunHeavyOptions,
): Promise<{ firstDivergentTick: number | null }> {
  const { wasm, storage, worldId, everyN } = opts
  const keys = worldKeys(worldId)
  const manifest = await readManifest(storage, keys)
  const cfg = { worldId, buildHash: manifest.created.buildHash, params: manifest.params }
  const newInstance = (): EngineInstance => instantiate(wasm, Role.Sim, buildSimInstanceConfig(cfg))

  const takeSnapshotBytes = (sim: EngineInstance): Uint8Array => {
    const region = sim.region(RegionId.Persist)
    if (!region) throw new Error('runHeavy: the Persist region is absent')
    const beginStatus = sim.call2(sim.x.sim_snapshot_begin, 0, 0)
    if (beginStatus !== Status.Ok) {
      throw new Error(`runHeavy: sim_snapshot_begin failed: status ${beginStatus}`)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const n = sim.call0(sim.x.sim_snapshot_next)
      if (n < 0) throw new Error(`runHeavy: sim_snapshot_next failed: status ${-n}`)
      if (n === 0) break
      chunks.push(region.u8.slice(0, n))
      total += n
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }

  /** "A genuinely fresh instance from snapshot bytes alone" (Seams): always `newInstance()`, never
   * the caller's own running one -- `runHeavy_restores_a_fresh_instance_not_the_running_one` proves
   * it by injection (Deviations). */
  const restoreFresh = (bytes: Uint8Array): EngineInstance => {
    const fresh = newInstance()
    const beginStatus = fresh.call1(fresh.x.sim_restore_begin, bytes.length)
    if (beginStatus !== Status.Ok) {
      throw new Error(`runHeavy: sim_restore_begin failed: status ${beginStatus}`)
    }
    const region = fresh.region(RegionId.Persist)
    if (!region) throw new Error('runHeavy: the Persist region is absent')
    const pushStatus = feedBlocks(fresh, fresh.x.sim_restore_push, region, bytes)
    if (pushStatus !== Status.Ok) {
      throw new Error(`runHeavy: sim_restore_push failed: status ${pushStatus}`)
    }
    const endStatus = fresh.call0(fresh.x.sim_restore_end)
    if (endStatus !== Status.Ok)
      throw new Error(`runHeavy: sim_restore_end failed: status ${endStatus}`)
    return fresh
  }

  let firstDivergentTick: number | null = null
  let sinceRestore = 0

  for (let i = 0; i < manifest.segments.length; i++) {
    const seg = manifest.segments[i]
    if (!seg) break
    const refTick = seg.base === 'genesis' ? 0 : seg.base
    const { sim: simA, offset } = await openSegmentStart(storage, keys, seg, newInstance)
    const { sim: simB } = await openSegmentStart(storage, keys, seg, newInstance)
    const logBytes = (await storage.read(keys.log(seg.index))) ?? new Uint8Array(0)
    const untilTick = lastFrameTick(logBytes, offset, refTick)
    scanSkipTargets(simA, seg.index, logBytes, offset)
    scanSkipTargets(simB, seg.index, logBytes, offset)

    const hashesA = new Map<number, string>()
    const cellA: Cell = { sim: simA }
    driveCell(
      cellA,
      logBytes,
      offset,
      refTick,
      untilTick,
      (tick) => {
        hashesA.set(tick, readHash(cellA.sim))
      },
      seg.index,
    )

    const cellB: Cell = { sim: simB }
    driveCell(
      cellB,
      logBytes,
      offset,
      refTick,
      untilTick,
      (tick, cell) => {
        const hashB = readHash(cell.sim)
        if (firstDivergentTick === null) {
          const hashA = hashesA.get(tick)
          if (hashA !== undefined && hashA !== hashB) firstDivergentTick = tick
        }
        sinceRestore++
        if (sinceRestore >= everyN) {
          const bytes = takeSnapshotBytes(cell.sim)
          cell.sim = restoreFresh(bytes)
          // docs/plan/24-recovery-and-migration.md: a genuinely fresh instance built by
          // `restoreFresh` has an empty `replay_skip_targets` (only `sim_replay_scan_begin`/`push`/
          // `end` populate it) -- without re-running the scan pass here, a `Skip` record whose
          // target frame is still ahead of this restore point would silently be *applied* on the
          // new instance for the rest of this segment, even though the uninterrupted run (`cellA`)
          // correctly fences it off. Re-scanning the whole segment tail is cheap (it decodes, never
          // applies) and correct regardless of how far `driveCell` has already progressed through it.
          scanSkipTargets(cell.sim, seg.index, logBytes, offset)
          sinceRestore = 0
        }
      },
      seg.index,
    )
  }

  return { firstDivergentTick }
}
