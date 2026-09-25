// docs/plan/22b-persistence-load-and-fs.md, Order of work step 1: the restore/replay ABI drivers
// (`sim_restore_begin/push/end`, `sim_replay_begin/push/end/valid_end`, `sim_tick_now`) over M22's
// readers, proven against a real snapshot + log an M22 `Persistence`/`SimHost` run actually wrote --
// not a hand-built container. `Persistence.open`/`loadLatest` (the full load path, crash matrix,
// truncation, segment rolling) is this brief's own step 2/3; this file only drives the raw ABI.
import { describe, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { Persistence } from '../../src/host/persistence.js'
import type { EngineInstance } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import {
  buildSimInstanceConfig,
  createSimHostFromInstance,
  wrapEngineInstance,
} from '../../src/server.js'
import { memoryStorage } from '../../src/storage/memory.js'
import { worldKeys } from '../../src/storage/types.js'
import { loadFixture } from '../support/fixtures.js'

const CFG = {
  worldId: 'w1',
  buildHash: 'ab'.repeat(32),
  params: { seed: '7', worldgen: null },
}

async function freshInstance(): Promise<EngineInstance> {
  const { wasm } = await loadFixture('persist')
  return instantiate(wasm, Role.Sim, buildSimInstanceConfig(CFG))
}

function manualTimer() {
  let fn: (() => void) | null = null
  return {
    services: {
      every: (_ms: number, cb: () => void) => {
        fn = cb
        return () => {
          fn = null
        }
      },
    },
    fire() {
      fn?.()
    },
  }
}

/** Pushes `bytes` into `inst`'s restore driver, one `RegionId.Persist`-sized block at a time
 * (proving the block-split contract, not assuming the whole thing fits one push). */
function pushRestore(inst: EngineInstance, bytes: Uint8Array): void {
  const beginStatus = inst.call1(inst.x.sim_restore_begin, bytes.length)
  expect(beginStatus).toBe(Status.Ok)
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('the Persist region is absent')
  let offset = 0
  while (offset < bytes.length) {
    const n = Math.min(region.len, bytes.length - offset)
    region.u8.set(bytes.subarray(offset, offset + n), 0)
    const pushStatus = inst.call1(inst.x.sim_restore_push, n)
    expect(pushStatus).toBe(Status.Ok)
    offset += n
  }
}

function pushReplay(
  inst: EngineInstance,
  segment: number,
  offset: number,
  bytes: Uint8Array,
): void {
  const beginStatus = inst.call2(inst.x.sim_replay_begin, segment, offset)
  expect(beginStatus).toBe(Status.Ok)
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('the Persist region is absent')
  let pos = 0
  while (pos < bytes.length) {
    const n = Math.min(region.len, bytes.length - pos)
    region.u8.set(bytes.subarray(pos, pos + n), 0)
    const pushStatus = inst.call1(inst.x.sim_replay_push, n)
    expect(pushStatus).toBe(Status.Ok)
    pos += n
  }
}

/** `sim_restore_end`'s own `Result`-region side effect: `logSegment`/`logOffset` as two LE `u32`. */
function readRestoreEnd(inst: EngineInstance): {
  status: number
  logSegment: number
  logOffset: number
} {
  const status = inst.call0(inst.x.sim_restore_end)
  const result = inst.region(RegionId.Result)
  if (!result) throw new Error('the Result region is absent')
  const view = new DataView(result.u8.buffer, result.u8.byteOffset, 8)
  return { status, logSegment: view.getUint32(0, true), logOffset: view.getUint32(4, true) }
}

/** `sim_segment_header`'s own sentinel (`host::mod::GENESIS_BASE_TICK`). */
const GENESIS_BASE_TICK = 0xffff_ffff

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** One raw tick, by hand (no `SimHost`): seals the pending frame (if any) into `log`, then ticks.
 * Mirrors `SimHost`'s own tick procedure closely enough for these tests, which need to control
 * exactly when a segment rolls -- not yet a real `Persistence` feature (this brief's own step 3). */
function tickRaw(inst: EngineInstance, log: Uint8Array[]): void {
  const raw = inst.call0(inst.x.sim_seal_frame)
  if (raw < 0) throw new Error(`sim_seal_frame failed: status ${-raw}`)
  if (raw > 0) {
    const region = inst.region(RegionId.Persist)
    if (!region) throw new Error('the Persist region is absent')
    log.push(region.u8.slice(0, raw))
  }
  const status = inst.call0(inst.x.sim_tick)
  if (status !== Status.Ok) throw new Error(`sim_tick failed: status ${status}`)
}

function readHash(inst: EngineInstance): string {
  expect(inst.call0(inst.x.sim_hash)).toBe(Status.Ok)
  return inst.readU64Hex(RegionId.Result, 0)
}

describe('restore/replay ABI drivers (fx-persist)', () => {
  test('restore_reproduces_an_m22_written_snapshot', async () => {
    const instA = await freshInstance()
    const storage = memoryStorage()
    const persistence = Persistence.create(storage, CFG, instA)
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(instA),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )

    // Tick 1: a connection (Joined + Connected), logged.
    expect(instA.call1(instA.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    // Snapshot right here: log position is exactly after tick 1's frame.
    persistence.snapshotNow()

    // Tick 2: a second connection, logged. Tick 3: idle, nothing logged.
    expect(instA.call1(instA.x.sim_connect, 1)).toBe(Status.Ok)
    host.stepTick(2)

    const wantHash = host.hash()

    const keys = worldKeys(CFG.worldId)
    const snapBytes = await storage.read(keys.snap(1))
    if (!snapBytes) throw new Error('expected a snapshot at tick 1')
    const logBytes = await storage.read(keys.log(0))
    if (!logBytes) throw new Error('expected segment 0 to have been written')

    // A fresh instance: restore the snapshot, then replay exactly the tail past its own log
    // position (tick 2's frame; tick 3 never logged one at all).
    const instB = await freshInstance()
    pushRestore(instB, snapBytes)
    const { status: endStatus, logSegment, logOffset } = readRestoreEnd(instB)
    expect(endStatus).toBe(Status.Ok)
    expect(logSegment).toBe(0)
    expect(logOffset).toBeGreaterThan(0)
    expect(logOffset).toBeLessThan(logBytes.length)

    const tail = logBytes.subarray(logOffset)
    pushReplay(instB, logSegment, logOffset, tail)
    expect(instB.call0(instB.x.sim_replay_end)).toBe(Status.Ok)
    expect(instB.call0(instB.x.sim_replay_valid_end)).toBe(logBytes.length)

    // 0005 Loss windows: resumes at the last *logged* frame's tick (2), not real elapsed sim time
    // (3, idle) -- this fixture's `tick()` touches no state on an idle tick with no timers pending,
    // so the state hash at tick 2 already equals the live hash at tick 3.
    expect(instB.call0(instB.x.sim_tick_now)).toBe(2)
    const hashStatus = instB.call0(instB.x.sim_hash)
    expect(hashStatus).toBe(Status.Ok)
    expect(instB.readU64Hex(RegionId.Result, 0)).toBe(wantHash)
  })

  test('restore_fails_a_corrupted_snapshot', async () => {
    const instA = await freshInstance()
    const storage = memoryStorage()
    const persistence = Persistence.create(storage, CFG, instA)
    expect(instA.call0(instA.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow()
    const keys = worldKeys(CFG.worldId)
    const snapBytes = await storage.read(keys.snap(0))
    if (!snapBytes) throw new Error('expected a snapshot at tick 0')
    const corrupted = snapBytes.slice()
    const last = corrupted.length - 1
    corrupted.set([(corrupted[last] ?? 0) ^ 0xff], last) // the trailing crc32

    const instB = await freshInstance()
    const beginStatus = instB.call1(instB.x.sim_restore_begin, corrupted.length)
    expect(beginStatus).toBe(Status.Ok)
    const region = instB.region(RegionId.Persist)
    if (!region) throw new Error('the Persist region is absent')
    region.u8.set(corrupted, 0)
    const pushStatus = instB.call1(instB.x.sim_restore_push, corrupted.length)
    expect(pushStatus).toBe(Status.Corrupt)
    expect(instB.call0(instB.x.sim_restore_end)).toBe(Status.Corrupt)
  })

  // From M22's Deviations (the brief's own "From M22's Deviations" note): "M22 has no test that
  // crosses two segments: add one (genesis replay across a segment boundary, and a segment opened
  // after an idle gap)". Segment rolling itself (a real `Persistence` feature) is this brief's own
  // step 3; both tests below open a second segment by hand, directly through the ABI
  // (`sim_segment_header`), to exercise cross-segment replay now, at the ABI-driver layer.
  test('genesis_replay_across_a_segment_boundary_equals_live', async () => {
    const live = await freshInstance()
    const h0Len = live.call2(live.x.sim_segment_header, 0, GENESIS_BASE_TICK)
    expect(h0Len).toBeGreaterThan(0)
    const seg0Header = live.region(RegionId.Persist)?.u8.slice(0, h0Len)
    if (!seg0Header) throw new Error('the Persist region is absent')
    expect(live.call0(live.x.sim_genesis)).toBe(Status.Ok)

    const seg0Frames: Uint8Array[] = []
    expect(live.call1(live.x.sim_connect, 0)).toBe(Status.Ok)
    tickRaw(live, seg0Frames) // tick 1: Joined + Connected, logged.
    tickRaw(live, seg0Frames) // tick 2: idle.

    // Roll to segment 1, based on tick 2 (Planning decisions 2: the roll happens at a snapshot;
    // this test only needs the header's own reset, not a real snapshot write).
    const rollTick = 2
    const h1Len = live.call2(live.x.sim_segment_header, 1, rollTick)
    expect(h1Len).toBeGreaterThan(0)
    const seg1Header = live.region(RegionId.Persist)?.u8.slice(0, h1Len)
    if (!seg1Header) throw new Error('the Persist region is absent')

    const seg1Frames: Uint8Array[] = []
    expect(live.call1(live.x.sim_connect, 1)).toBe(Status.Ok)
    tickRaw(live, seg1Frames) // tick 3: a second connection, logged (segment 1's own first frame).
    tickRaw(live, seg1Frames) // tick 4: idle.

    const liveHash = readHash(live)
    const liveTick = live.call0(live.x.sim_tick_now)
    expect(liveTick).toBe(4)

    const seg0Tail = concatChunks(seg0Frames)
    const seg1Tail = concatChunks(seg1Frames)

    // A fresh instance: genesis, replay segment 0 in full, cross the boundary, replay segment 1.
    const fresh = await freshInstance()
    expect(fresh.call2(fresh.x.sim_segment_header, 0, GENESIS_BASE_TICK)).toBe(h0Len)
    expect(fresh.call0(fresh.x.sim_genesis)).toBe(Status.Ok)
    pushReplay(fresh, 0, seg0Header.length, seg0Tail)
    expect(fresh.call0(fresh.x.sim_replay_end)).toBe(Status.Ok)
    expect(fresh.call0(fresh.x.sim_replay_valid_end)).toBe(seg0Header.length + seg0Tail.length)

    // Crossing the boundary: `sim_segment_header` resets the tick_delta reference for segment 1's
    // own first frame (fix round 2, docs/plan/22-persistence-log-and-snapshots.md) -- without this
    // call, segment 1's own reference would incorrectly carry over from segment 0's last logged
    // tick (1) instead of the roll point (2).
    expect(fresh.call2(fresh.x.sim_segment_header, 1, rollTick)).toBe(h1Len)
    pushReplay(fresh, 1, seg1Header.length, seg1Tail)
    expect(fresh.call0(fresh.x.sim_replay_end)).toBe(Status.Ok)
    expect(fresh.call0(fresh.x.sim_replay_valid_end)).toBe(seg1Header.length + seg1Tail.length)

    // 0005 Loss windows: resumes at the last *logged* frame's tick (3), not real elapsed sim time
    // (4, idle) -- `liveTick` names the live run's own real tick, kept only for the doc comment
    // above; the hash is unaffected either way (an idle tick with no timers pending is a no-op).
    expect(liveTick).toBe(4)
    expect(fresh.call0(fresh.x.sim_tick_now)).toBe(3)
    expect(readHash(fresh)).toBe(liveHash)
  })

  test('restore_after_an_idle_gap_then_more_frames_equals_live', async () => {
    const live = await freshInstance()
    const storage = memoryStorage()
    const persistence = Persistence.create(storage, CFG, live)
    expect(live.call0(live.x.sim_genesis)).toBe(Status.Ok)
    const timer = manualTimer()
    const host = createSimHostFromInstance(
      wrapEngineInstance(live),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )

    expect(live.call1(live.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1) // tick 1: Joined + Connected, logged (last logged tick = 1).
    host.stepTick(5) // ticks 2-6: idle -- a real gap between the last logged frame and the snapshot.
    persistence.snapshotNow() // at tick 6: `tick` (6) and `log_ref_tick` (1) now genuinely differ.

    expect(live.call1(live.x.sim_connect, 1)).toBe(Status.Ok)
    host.stepTick(1) // tick 7: a second connection, logged.
    host.stepTick(1) // tick 8: idle.

    const wantHash = host.hash()
    const wantTick = 7 // 0005 Loss windows: resumes at the last *logged* frame's tick, not tick 8.

    const keys = worldKeys(CFG.worldId)
    const snapBytes = await storage.read(keys.snap(6))
    if (!snapBytes) throw new Error('expected a snapshot at tick 6')
    const logBytes = await storage.read(keys.log(0))
    if (!logBytes) throw new Error('expected segment 0 to have been written')

    const fresh = await freshInstance()
    pushRestore(fresh, snapBytes)
    const { status, logSegment, logOffset } = readRestoreEnd(fresh)
    expect(status).toBe(Status.Ok)
    expect(logSegment).toBe(0)
    // Nothing was appended between tick 1's frame and the tick-6 snapshot: the log position is
    // unchanged from what it was right after tick 1.
    pushReplay(fresh, logSegment, logOffset, logBytes.subarray(logOffset))
    expect(fresh.call0(fresh.x.sim_replay_end)).toBe(Status.Ok)
    expect(fresh.call0(fresh.x.sim_replay_valid_end)).toBe(logBytes.length)

    expect(fresh.call0(fresh.x.sim_tick_now)).toBe(wantTick)
    expect(readHash(fresh)).toBe(wantHash)
  })
})
