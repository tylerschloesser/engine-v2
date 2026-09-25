// docs/plan/22b-persistence-load-and-fs.md, Order of work step 5: `replayWorld`/`runHeavy`
// (`engine/test`). Two cases per the delegation's own instruction:
//
// 1. `replay_world_checkpoints_node`/`heavy_wasm_*`: M22's own checked-in log
//    (`fixtures/persist/tests/golden/persist_fixture_log.hex`) wrapped in a synthetic single-
//    segment `MemoryStorage` (a real segment-0 header prepended -- the golden's own bytes are
//    frames only, M22's native `record()` never wrote one). Satisfies the exit criterion's literal
//    wording ("hashes ... equal the native golden hashes checked in by M22").
// 2. `replay_world_checkpoints_two_segment_real_pipeline`: a real `SimHost` + `Persistence` run
//    that actually rolls a segment (Planning decisions 2 of docs/plan/
//    22-persistence-log-and-snapshots.md), so Planning decisions 5's own cross-segment hash
//    assertion is exercised for real, not vacuously (a single-segment world never reaches it).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import type { IdentityJson, ManifestV1 } from '../../src/host/persistence.js'
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
import { replayWorld, runHeavy } from '../../src/test/replay.js'
import { loadFixture } from '../support/fixtures.js'

const CFG = {
  worldId: 'w1',
  buildHash: 'ab'.repeat(32),
  params: { seed: '42', worldgen: null },
}

let wasmModule: WebAssembly.Module | undefined
async function wasm(): Promise<WebAssembly.Module> {
  if (!wasmModule) wasmModule = (await loadFixture('persist')).wasm
  return wasmModule
}

function freshInstance(mod: WebAssembly.Module): EngineInstance {
  return instantiate(mod, Role.Sim, buildSimInstanceConfig(CFG))
}

const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/persist/tests/golden/', import.meta.url))

/** `assert_golden_bytes!`'s own format (`crates/engine/src/testing/golden_bytes.rs`): lower-case
 * hex, wrapped at 32 bytes (64 hex digits) per line -- every whitespace byte is stripped, not just
 * the file's own leading/trailing trim. */
function readHexGolden(name: string): Uint8Array {
  const hex = readFileSync(`${GOLDEN_DIR}${name}.hex`, 'utf8').replace(/\s+/g, '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function readHashGolden(name: string): string {
  return readFileSync(`${GOLDEN_DIR}${name}.hash`, 'utf8').trim()
}

const CHECKPOINT_NAMES = [0, 1, 2, 3, 4]

/** `record()`'s own checkpoints (`fixtures/persist/tests/support/mod.rs`), read straight from the
 * checked-in golden files rather than hard-coded -- if the fixture script or its golden ever moves,
 * this test moves with it instead of silently comparing against a stale copy. */
function fixtureCheckpoints(): { tick: number; hash: string }[] {
  return CHECKPOINT_NAMES.map((i) => ({
    tick: Number(BigInt(`0x${readHashGolden(`persist_fixture_checkpoint_${i}_tick`)}`)),
    hash: readHashGolden(`persist_fixture_checkpoint_${i}_hash`),
  }))
}

const dummyIdentity: IdentityJson = {
  buildHash: CFG.buildHash,
  engineVersion: '0.0.0',
  gameVersion: '0.0.0',
  schemaVersion: 0,
  tickRateHz: 20,
  worldgen: { version: 0, fingerprint: '0' },
}

/** Wraps M22's checked-in fixture log (frames only) in a synthetic single-segment `MemoryStorage`:
 * a real segment-0 header (from `sim_segment_header`, this build's own bytes) is prepended, since
 * every real `Persistence`-written segment 0 log begins with one and `replayWorld`'s own
 * `openSegmentStart` assumes it (Seams: `Persistence.create` always writes the header first). */
async function wrapFixtureLogStorage(): Promise<ReturnType<typeof memoryStorage>> {
  const mod = await wasm()
  const inst = freshInstance(mod)
  const headerLen = inst.call2(inst.x.sim_segment_header, 0, 0xffff_ffff)
  expect(headerLen).toBeGreaterThan(0)
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('the Persist region is absent')
  const header = region.u8.slice(0, headerLen)
  const frames = readHexGolden('persist_fixture_log')
  const fullLog = new Uint8Array(header.length + frames.length)
  fullLog.set(header, 0)
  fullLog.set(frames, header.length)

  const storage = memoryStorage()
  const keys = worldKeys(CFG.worldId)
  const manifest: ManifestV1 = {
    v: 1,
    worldId: CFG.worldId,
    epoch: 0,
    params: CFG.params,
    created: dummyIdentity,
    segments: [
      { index: 0, identity: dummyIdentity, base: 'genesis', sealed: false, tailReexecuted: false },
    ],
  }
  await storage.write(keys.manifest, new TextEncoder().encode(JSON.stringify(manifest)))
  await storage.write(keys.log(0), fullLog)
  return storage
}

describe('replayWorld / runHeavy (fx-persist)', () => {
  test('replay_world_checkpoints_node', async () => {
    const storage = await wrapFixtureLogStorage()
    const want = fixtureCheckpoints()
    const got = await replayWorld({
      wasm: await wasm(),
      storage,
      worldId: CFG.worldId,
      checkpoints: want.map((c) => c.tick),
    })
    expect(got).toEqual(want)
  })

  test('heavy_wasm_n50', async () => {
    const storage = await wrapFixtureLogStorage()
    const result = await runHeavy({
      wasm: await wasm(),
      storage,
      worldId: CFG.worldId,
      everyN: 50,
    })
    expect(result.firstDivergentTick).toBeNull()
  })

  test('heavy_wasm_n1 @slow', async () => {
    const storage = await wrapFixtureLogStorage()
    const result = await runHeavy({
      wasm: await wasm(),
      storage,
      worldId: CFG.worldId,
      everyN: 1,
    })
    expect(result.firstDivergentTick).toBeNull()
  })

  /** A genuine two-segment world (Planning decisions 2 of docs/plan/
   * 22-persistence-log-and-snapshots.md: growing segment 0 past a tiny roll threshold, then a couple
   * more connects in the new segment 1), plus the live per-tick `{ tick, hash }` list from the real
   * host that produced it. */
  async function buildTwoSegmentWorld(): Promise<{
    storage: ReturnType<typeof memoryStorage>
    live: { tick: number; hash: string }[]
    manifest: ManifestV1
  }> {
    const mod = await wasm()
    const storage = memoryStorage()
    const inst = freshInstance(mod)
    const persistence = Persistence.create(storage, CFG, inst, { segmentRollBytes: 64 })
    const timer = {
      services: {
        every: (_ms: number, cb: () => void) => {
          void cb
          return () => {}
        },
      },
    }
    const host = createSimHostFromInstance(
      wrapEngineInstance(inst),
      { clock: { now: () => 0 }, timer: timer.services },
      persistence,
    )

    const live: { tick: number; hash: string }[] = []
    for (let i = 0; i < 6; i++) {
      expect(inst.call1(inst.x.sim_connect, i)).toBe(Status.Ok)
      host.stepTick(1)
      live.push({ tick: host.counters.ticksRun, hash: host.hash() })
    }
    persistence.snapshotNow() // rolls to segment 1 (segment 0's own log already exceeds 64 bytes)
    for (let i = 6; i < 8; i++) {
      expect(inst.call1(inst.x.sim_connect, i)).toBe(Status.Ok)
      host.stepTick(1)
      live.push({ tick: host.counters.ticksRun, hash: host.hash() })
    }

    const manifestBytes = await storage.read(worldKeys(CFG.worldId).manifest)
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes ?? undefined)) as ManifestV1
    expect(manifest.segments).toHaveLength(2) // a real second segment really was created.
    return { storage, live, manifest }
  }

  test('replay_world_checkpoints_two_segment_real_pipeline', async () => {
    const { storage, live } = await buildTwoSegmentWorld()
    const got = await replayWorld({
      wasm: await wasm(),
      storage,
      worldId: CFG.worldId,
      checkpoints: live.map((c) => c.tick),
    })
    expect(got).toEqual(live)
  })

  test('replay_world_detects_a_segment_boundary_hash_mismatch', async () => {
    // Planning decisions 5 of docs/plan/22-persistence-log-and-snapshots.md: "the state hash equals
    // the base snapshot's `state_hash`" at every segment boundary. Tampers with segment 1's own
    // base snapshot (still CRC-valid, still the right identity -- just a *different* real snapshot,
    // a pristine genesis one) so the byte-level restore succeeds but the state it describes does
    // not match the continuous replay's own hash at that tick: `replayWorld` must reject this, not
    // silently report a wrong checkpoint.
    const mod = await wasm()
    const { storage, live, manifest } = await buildTwoSegmentWorld()
    const seg1Base = manifest.segments[1]?.base
    if (typeof seg1Base !== 'number') throw new Error('expected segment 1 to have a numeric base')

    const wrongInst = freshInstance(mod)
    expect(wrongInst.call0(wrongInst.x.sim_genesis)).toBe(Status.Ok)
    const beginStatus = wrongInst.call2(wrongInst.x.sim_snapshot_begin, 1, 0)
    expect(beginStatus).toBe(Status.Ok)
    const region = wrongInst.region(RegionId.Persist)
    if (!region) throw new Error('the Persist region is absent')
    const chunks: Uint8Array[] = []
    for (;;) {
      const n = wrongInst.call0(wrongInst.x.sim_snapshot_next)
      if (n === 0) break
      chunks.push(region.u8.slice(0, n))
    }
    const wrongBytes = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
    let off = 0
    for (const c of chunks) {
      wrongBytes.set(c, off)
      off += c.length
    }
    await storage.write(worldKeys(CFG.worldId).snap(seg1Base), wrongBytes)

    await expect(
      replayWorld({
        wasm: mod,
        storage,
        worldId: CFG.worldId,
        checkpoints: live.map((c) => c.tick),
      }),
    ).rejects.toThrow(/Planning\s*decisions 5/)
  })
})
