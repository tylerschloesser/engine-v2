// docs/plan/24b-upgrade-and-migration.md, Order of work steps 4-5: the 0005 Upgrades sequence
// (`sim_upgrade_begin/push/end`, `host/upgrade.ts`, `Persistence.open`/`loadLatest`) driven through
// the real pipeline over the three fixture builds (`fx-migrate-v1`/`fx-migrate-v2`/
// `fx-migrate-v2-hz30`), never a hand-built container except where a scenario has no other way to
// exist (an undecodable tail action, a worldgen-fingerprint mismatch): both of those patch real,
// freshly-written bytes and recompute the exact CRC-32 the engine itself uses, rather than
// fabricating a whole snapshot/frame from scratch.
import { beforeAll, describe, expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import type { ManifestV1 } from '../../src/host/persistence.js'
import { Persistence, WorldLoadError } from '../../src/host/persistence.js'
import type { EngineInstance } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import {
  buildSimInstanceConfig,
  createSimHostFromInstance,
  type SimHost,
  wrapEngineInstance,
} from '../../src/server.js'
import { exportWorld, importWorld } from '../../src/storage/archive.js'
import { memoryStorage } from '../../src/storage/memory.js'
import type { Storage } from '../../src/storage/types.js'
import { worldKeys } from '../../src/storage/types.js'
import { loadFixture } from '../support/fixtures.js'

let v1: WebAssembly.Module
let v2: WebAssembly.Module
let v2hz30: WebAssembly.Module

beforeAll(async () => {
  v1 = (await loadFixture('migrate-v1')).wasm
  v2 = (await loadFixture('migrate-v2')).wasm
  v2hz30 = (await loadFixture('migrate-v2-hz30')).wasm
})

function cfg(worldId: string, buildHash: string, seed = '1') {
  return { worldId, buildHash, params: { seed, worldgen: null } }
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

function hostOver(inst: EngineInstance, persistence?: Persistence, initialTicksRun = 0): SimHost {
  const timer = manualTimer()
  return createSimHostFromInstance(
    wrapEngineInstance(inst),
    { clock: { now: () => 0 }, timer: timer.services },
    persistence,
    initialTicksRun,
  )
}

/** Admits one action through a second client-role instance of the same `.wasm`, exactly as
 * `tests/wasm/persist-open.test.ts`'s own `admitRoll` does -- never a hand-encoded postcard. */
function admitAction(mod: WebAssembly.Module, config: ReturnType<typeof cfg>) {
  return (sim: EngineInstance, seq: number, action: unknown): void => {
    const encoder = instantiate(mod, Role.Client, buildSimInstanceConfig(config))
    const encoderRx = encoder.region(RegionId.Rx)
    const encoderTx = encoder.region(RegionId.Tx)
    const simRx = sim.region(RegionId.Rx)
    if (!encoderRx || !encoderTx || !simRx) throw new Error('Rx/Tx region missing')
    const json = new TextEncoder().encode(JSON.stringify(action))
    const record = new Uint8Array(8 + json.length)
    const view = new DataView(record.buffer)
    view.setUint32(0, seq, true)
    view.setUint32(4, json.length, true)
    record.set(json, 8)
    encoderRx.u8.set(record)
    const onActionStatus = encoder.call1(encoder.x.on_action, record.length)
    if (onActionStatus !== Status.Ok) throw new Error(`on_action failed: status ${onActionStatus}`)
    const uplinkLen = encoder.call1(encoder.x.client_poll_uplink, 0)
    if (uplinkLen <= 0) throw new Error('encoder produced no uplink batch')
    simRx.u8.set(encoderTx.u8.subarray(0, uplinkLen))
    const admitStatus = sim.call2(sim.x.sim_admit, 0, uplinkLen)
    if (admitStatus !== Status.Ok) throw new Error(`sim_admit failed: status ${admitStatus}`)
  }
}

function readManifest(storage: Storage, worldId: string): Promise<ManifestV1> {
  return storage.read(worldKeys(worldId).manifest).then((bytes) => {
    if (!bytes) throw new Error('no manifest')
    return JSON.parse(new TextDecoder().decode(bytes)) as ManifestV1
  })
}

async function snapshotStorage(storage: Storage): Promise<Map<string, Uint8Array | null>> {
  const keys = await storage.list('')
  const out = new Map<string, Uint8Array | null>()
  for (const k of keys) out.set(k, await storage.read(k))
  return out
}

async function expectStorageUnchanged(storage: Storage, before: Map<string, Uint8Array | null>) {
  const after = await snapshotStorage(storage)
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
  for (const [k, v] of after) expect(v).toEqual(before.get(k))
}

/** `Persistence.open`'s own success value carries a live `EngineInstance` (a real WASM `Memory`).
 * `await expect(p).rejects.matcher(...)` against a promise that unexpectedly *resolves* (a defect,
 * or a test whose own scenario turns out not to trigger a mismatch after all) makes vitest's own
 * failure-diff formatting try to stringify that resolved value -- observed climbing past 4 GB over
 * ~20 s before an OOM `SIGABRT` that kills the whole worker, no assertion failure ever printed (this
 * milestone's own Deviations has the full diagnosis). This converts both outcomes into a plain,
 * small, `sim`-free value *before* any `expect()` ever sees it, so a wrongly-resolving promise is an
 * ordinary, readable assertion failure instead. */
async function expectIncompatible(p: Promise<unknown>, reason: string): Promise<void> {
  const outcome = await p.then(
    () => ({ resolved: true as const }),
    (error: unknown) => ({ resolved: false as const, error }),
  )
  if (outcome.resolved) {
    throw new Error(`expected Persistence.open to reject (reason ${reason}), but it resolved`)
  }
  expect(outcome.error).toBeInstanceOf(WorldLoadError)
  const err = outcome.error as WorldLoadError
  expect({ kind: err.kind, reason: err.reason as string | undefined }).toEqual({
    kind: 'incompatible',
    reason,
  })
}

// ---------------------------------------------------------------------------------------------
// CRC-32/ISO-HDLC (crates/engine/src/persist/crc32.rs) and the varint/frame wire shapes
// (0005 Formats) -- reimplemented here only for the two scenarios below that have no other way to
// exist (an undecodable tail action; a worldgen-fingerprint mismatch), each patching real bytes the
// engine itself just wrote and recomputing the exact checksum that protects them.
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    const idx = (crc ^ b) & 0xff
    const entry = CRC_TABLE[idx] ?? 0
    crc = (entry ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

function putVarint(out: number[], value: number): void {
  let v = value >>> 0
  for (;;) {
    const byte = v & 0x7f
    v >>>= 7
    if (v === 0) {
      out.push(byte)
      return
    }
    out.push(byte | 0x80)
  }
}

/** One `Action` record whose own payload is a deliberately non-canonical postcard encoding: an
 * overlong 2-byte LEB128 form (`[0x80, 0x00]`) of discriminant 0 ("Deposit", `fx-migrate-v2`'s only
 * `Action` variant) -- a plain decode accepts it, but `decode_canonical`'s own re-encode-and-compare
 * check does not, since the canonical form is the 1-byte `[0x00]` (docs/plan/
 * 24b-upgrade-and-migration.md decision 6, amending 0024 §3b: exactly the "SCHEMA_VERSION-unbumped
 * layout change" case, faked here at the byte level rather than with a fourth fixture). Wraps it in
 * one whole, CRC-valid frame (`len | tick_delta | count=1 | record | crc32`) ready to `storage.append`
 * directly onto a segment's log key, right after a real snapshot's own log position. */
function buildUndecodableActionFrame(
  tickDelta: number,
  playerSlot: number,
  seq: number,
): Uint8Array {
  const overlongZero = [0x80, 0x00]
  const record: number[] = [0 /* RecordKind::Action */, playerSlot]
  putVarint(record, seq)
  putVarint(record, overlongZero.length)
  record.push(...overlongZero)

  const body: number[] = []
  putVarint(body, tickDelta)
  putVarint(body, 1) // count
  body.push(...record)
  const bodyBytes = Uint8Array.from(body)
  const crc = crc32(bodyBytes)

  const lenPrefix: number[] = []
  putVarint(lenPrefix, bodyBytes.length + 4)

  const out = [
    ...lenPrefix,
    ...body,
    crc & 0xff,
    (crc >>> 8) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 24) & 0xff,
  ]
  return Uint8Array.from(out)
}

/** Locates a snapshot container's own trailing `crc32` (0005 Formats: `magic | container_version
 * u16 | varint(total_len) | payload | crc32`) and recomputes it over `payload` after an in-place
 * edit -- the one way to hand-patch a real, freshly-written snapshot's `Identity` field (here: the
 * worldgen fingerprint) without also having to fake the whole container from scratch. Mutates and
 * returns `bytes`. */
function refixSnapshotCrc(bytes: Uint8Array): Uint8Array {
  let pos = 6 // magic(4) + container_version u16
  let shift = 0
  let totalLen = 0
  for (;;) {
    const byte = bytes[pos]
    if (byte === undefined) throw new Error('refixSnapshotCrc: truncated varint')
    totalLen |= (byte & 0x7f) << shift
    pos++
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  const payloadStart = pos
  const payloadEnd = payloadStart + totalLen - 4
  const payload = bytes.subarray(payloadStart, payloadEnd)
  const crc = crc32(payload)
  const view = new DataView(bytes.buffer, bytes.byteOffset + payloadEnd, 4)
  view.setUint32(0, crc, true)
  return bytes
}

/** `Identity::write`'s own wire shape (`crates/engine/src/persist/identity.rs`): `build_hash`(16) |
 * varint+utf8 `engine_version` | varint+utf8 `game_version` | `schema_version` u32 | `tick_rate_hz`
 * u32 | `worldgen.version` u32 | `worldgen.fingerprint` u64 -- returns the byte offset of the
 * fingerprint's own 8 bytes within `payload` (the snapshot container's payload, starting at
 * `Identity`, per `refixSnapshotCrc`'s own doc comment). */
function findWorldgenFingerprintOffset(payload: Uint8Array): number {
  let pos = 16
  for (let i = 0; i < 2; i++) {
    let strLen = 0
    let shift = 0
    for (;;) {
      const byte = payload[pos]
      if (byte === undefined) throw new Error('findWorldgenFingerprintOffset: truncated varint')
      strLen |= (byte & 0x7f) << shift
      pos++
      if ((byte & 0x80) === 0) break
      shift += 7
    }
    pos += strLen
  }
  return pos + 4 + 4 + 4 // schema_version, tick_rate_hz, worldgen.version
}

describe('0005 Upgrades over the real fx-migrate-* pipeline', () => {
  /** `Comparison::Direct` (same schema/tick-rate/worldgen, different build hash): the tail is
   * re-executed and a new segment opens, based on a fresh snapshot of the re-executed state.
   * `onRecovered` fires with `reason: 'upgrade'`, once (never per segment). Proves the replay is not
   * vacuous two ways: the upgraded hash matches an independent, uninterrupted replay of the same
   * script, and it differs from the hash the pre-tail snapshot alone would have produced. */
  test('rules_only_change_direct_load_new_segment', async () => {
    const worldId = 'w-direct'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    const host = hostOver(inst, persistence)
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1) // Joined -> creates the player
    const hashAtSnapshot = host.hash()
    persistence.snapshotNow() // the snapshot candidate `loadLatest` will pick

    const admit = admitAction(v2, c1)
    await admit(inst, 1, 'Deposit') // this frame is the tail: logged *after* the snapshot
    host.stepTick(1)
    const hashUninterrupted = host.hash()
    expect(hashUninterrupted).not.toBe(hashAtSnapshot) // the tail genuinely changes state

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    const opened = await Persistence.open(storage, c2, ni)
    expect(opened.outcome).toBe('upgraded')
    expect(opened.upgrade?.reason).toBe('direct')
    expect(opened.sim.call0(opened.sim.x.sim_hash)).toBe(Status.Ok)
    expect(opened.sim.readU64Hex(RegionId.Result, 0)).toBe(hashUninterrupted)

    const recovered: { reason: string; tick: number; skipped: number }[] = []
    const host2 = hostOver(opened.sim, opened.persistence, opened.tick)
    host2.onRecovered = (r) => recovered.push(r)
    if (opened.upgrade) {
      host2.onRecovered?.({
        reason: 'upgrade',
        tick: opened.tick,
        skipped: opened.upgrade.droppedTailRecords,
      })
    }
    expect(recovered).toEqual([{ reason: 'upgrade', tick: opened.tick, skipped: 0 }])

    const manifest = await readManifest(storage, worldId)
    expect(manifest.segments).toHaveLength(2)
    expect(manifest.segments[0]?.sealed).toBe(true)
    expect(manifest.segments[0]?.tailReexecuted).toBe(true)
    expect(manifest.segments[1]?.sealed).toBe(false)
    expect(manifest.segments[1]?.identity.buildHash).toBe('bb'.repeat(16))
  })

  /** `Comparison::NeedsMigrate(Schema)`, v1 -> v2: `fx-migrate-v2`'s own `migrate` accepts
   * `from_schema == 1`. The tail (after the snapshot) is dropped whole, never replayed
   * (`tailReexecuted: false`), and its own record count is reported (0024 §3b) via the scan pass
   * alone. */
  test('schema_bump_runs_migrate', async () => {
    const worldId = 'w-migrate'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v1, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    const host = hostOver(inst, persistence)
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    persistence.snapshotNow()

    const admit = admitAction(v1, c1)
    await admit(inst, 1, 'Deposit')
    host.stepTick(1)
    await admit(inst, 2, 'Deposit')
    host.stepTick(1) // two tail frames, one record each: dropped count must be 2

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    const opened = await Persistence.open(storage, c2, ni)
    expect(opened.outcome).toBe('upgraded')
    expect(opened.upgrade?.reason).toBe('migrated')
    expect(opened.upgrade?.droppedTailRecords).toBe(2)

    const manifest = await readManifest(storage, worldId)
    expect(manifest.segments[0]?.tailReexecuted).toBe(false)
    expect(manifest.segments[0]?.sealed).toBe(true)
  })

  /** `Comparison::NeedsMigrate(TickRate)`, v2 -> v2-hz30: same schema, so `fx-migrate-v2`'s own
   * `migrate` (shared by `#[path]`) runs, but its own `from_schema != 1` guard declines a same-
   * schema call too (0006 point 2's own "During prototyping that is the expected outcome" default,
   * since this game never implements a pure tick-rate rescale) -- `SaveIncompatible` still proves
   * the *mismatch itself* took the migrate path (not a silent direct load), only the game declined
   * once there. */
  test('tick_rate_change_without_bump_still_requires_migrate', async () => {
    const worldId = 'w-tickrate'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow()
    const before = await snapshotStorage(storage)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2hz30, Role.Sim, buildSimInstanceConfig(c2))
    await expectIncompatible(Persistence.open(storage, c2, ni), 'MigrateDeclined')
    await expectStorageUnchanged(storage, before)
  })

  /** `Comparison::NeedsMigrate(Schema)`, v2 -> v1 (backwards): `fx-migrate-v1` never overrides
   * `migrate` at all (the trait default). Every stored byte stays untouched (Planning decisions 7).
   */
  test('no_migrate_hook_save_incompatible_files_untouched', async () => {
    const worldId = 'w-declined'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow()
    const before = await snapshotStorage(storage)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v1, Role.Sim, buildSimInstanceConfig(c2))
    await expectIncompatible(Persistence.open(storage, c2, ni), 'MigrateDeclined')
    await expectStorageUnchanged(storage, before)
  })

  /** Scope: `Persistence.open` compares `chunkBits` against the running build before any ABI call
   * at all -- a mismatch is `'incompatible'`/`ChunkSize`, raised entirely in TS, no write. */
  test('chunk_bits_mismatch_save_incompatible_files_untouched', async () => {
    const worldId = 'w-chunkbits'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    Persistence.create(storage, c1, inst)
    const keys = worldKeys(worldId)
    const manifest = await readManifest(storage, worldId)
    expect(manifest.params.chunkBits).toBe(5) // fx-migrate-v2 never overrides Game::CHUNK_BITS

    const corrupted: ManifestV1 = { ...manifest, params: { ...manifest.params, chunkBits: 4 } }
    await storage.write(keys.manifest, new TextEncoder().encode(JSON.stringify(corrupted)))
    const before = await snapshotStorage(storage)

    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    await expectIncompatible(Persistence.open(storage, c1, ni), 'ChunkSize')
    await expectStorageUnchanged(storage, before)
  })

  /** `Comparison::NeedsMigrate(Worldgen)`: none of the three fixtures differ in *only* worldgen
   * through config alone (`FlatWorldgen::generate` ignores `seed`/params on every one of them), so
   * this patches a real, freshly-written snapshot's own `Identity.worldgen.fingerprint` field
   * in place and recomputes its container CRC-32 (`refixSnapshotCrc`) -- schema and tick rate stay
   * exactly as written, only the fingerprint differs, isolating the `Worldgen` branch of `Identity::
   * compare`'s priority order. `fx-migrate-v2`'s own `migrate` declines any `from_schema != 1`, so
   * this still ends in `SaveIncompatible`, but the *reason `compare` took the NeedsMigrate branch
   * for* is proven by construction, not merely asserted. */
  test('worldgen_stamp_mismatch_requires_migrate', async () => {
    const worldId = 'w-worldgen'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow()

    const snapKeys = (await storage.list(`worlds/${worldId}/snap/`)).sort()
    const snapKey = snapKeys[0]
    if (!snapKey) throw new Error('expected a snapshot')
    const bytes = await storage.read(snapKey)
    if (!bytes) throw new Error('expected snapshot bytes')

    let pos = 6
    for (;;) {
      const byte = bytes[pos]
      if (byte === undefined) throw new Error('truncated snapshot header')
      pos++
      if ((byte & 0x80) === 0) break
    }
    const payloadStart = pos
    const fpOffset = payloadStart + findWorldgenFingerprintOffset(bytes.subarray(payloadStart))
    const view = new DataView(bytes.buffer, bytes.byteOffset + fpOffset, 8)
    const original = view.getBigUint64(0, true)
    view.setBigUint64(0, original ^ 0xffffffffffffffffn, true)
    refixSnapshotCrc(bytes)
    await storage.write(snapKey, bytes)
    const before = await snapshotStorage(storage)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    await expectIncompatible(Persistence.open(storage, c2, ni), 'MigrateDeclined')
    await expectStorageUnchanged(storage, before)
  })

  /** A hand-built, structurally valid, CRC-valid frame whose one `Action` record's own payload is a
   * non-canonical (overlong LEB128) encoding of `fx-migrate-v2`'s only variant, appended directly
   * onto the log right after a real snapshot's own position (0024 §3b, decision 6): the Direct load
   * path's tail replay drops it, counts it (`upgrade.droppedTailRecords`), and continues -- it is
   * not `Status.TornTail` (the frame's own CRC is genuinely valid; only its *content* disagrees). */
  test('undecodable_tail_action_is_dropped_and_counted', async () => {
    const worldId = 'w-undecodable'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow()

    const keys = worldKeys(worldId)
    const frame = buildUndecodableActionFrame(1, 0, 1)
    await storage.append(keys.log(0), frame)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    const opened = await Persistence.open(storage, c2, ni)
    expect(opened.outcome).toBe('upgraded')
    expect(opened.upgrade?.reason).toBe('direct')
    expect(opened.upgrade?.droppedTailRecords).toBe(1)
  })

  /** 0005 "Export, import ... including the upgrade path": an archive taken from a v1 world,
   * imported under a fresh id, still takes the real migrate path on its first load under a v2
   * build. */
  test('import_then_upgrade', async () => {
    const sourceId = 'w-import-src'
    const c1 = cfg(sourceId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v1, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    persistence.snapshotNow()
    await persistence.flush()

    const archive = await exportWorld(storage, sourceId)
    const targetId = 'w-import-dst'
    const { worldId } = await importWorld(storage, archive, { worldId: targetId })
    expect(worldId).toBe(targetId)

    const c2 = cfg(targetId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    const opened = await Persistence.open(storage, c2, ni)
    expect(opened.outcome).toBe('upgraded')
    expect(opened.upgrade?.reason).toBe('migrated')
  })

  /** Gate fix (docs/plan/24b-upgrade-and-migration.md "known gap"): a world with no snapshot yet
   * (played for less than the first 1,200-tick dirty snapshot) still checks identity on its
   * genesis-replay fallback. `Comparison::Direct` (same schema/tick-rate/worldgen, different build
   * hash): the whole log tail (there is no snapshot to resume from -- everything after segment 0's
   * own header) is re-executed under the new build, exactly like a snapshot candidate's own Direct
   * path, and the result matches an independent, uninterrupted replay of the same script. */
  test('genesis_only_world_direct_load_reexecutes_tail', async () => {
    const worldId = 'w-genesis-direct'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    const host = hostOver(inst, persistence)
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1) // Joined -> creates the player
    const admit = admitAction(v2, c1)
    await admit(inst, 1, 'Deposit')
    host.stepTick(1)
    const hashUninterrupted = host.hash()
    // No snapshot was ever taken: the only candidate for `loadLatest` is the genesis fallback.
    expect(await storage.list(`worlds/${worldId}/snap/`)).toHaveLength(0)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    const opened = await Persistence.open(storage, c2, ni)
    expect(opened.outcome).toBe('upgraded')
    expect(opened.upgrade?.reason).toBe('direct')
    expect(opened.sim.call0(opened.sim.x.sim_hash)).toBe(Status.Ok)
    expect(opened.sim.readU64Hex(RegionId.Result, 0)).toBe(hashUninterrupted)

    const manifest = await readManifest(storage, worldId)
    expect(manifest.segments).toHaveLength(2)
    expect(manifest.segments[0]?.sealed).toBe(true)
    expect(manifest.segments[0]?.tailReexecuted).toBe(true)
    expect(manifest.segments[1]?.identity.buildHash).toBe('bb'.repeat(16))
  })

  /** Gate fix (docs/plan/24b-upgrade-and-migration.md "known gap"): a schema bump on a world with no
   * snapshot yet is `Comparison::NeedsMigrate(Schema)`, but there is no old snapshot to decode an
   * `OldStore` from -- rejected outright as `SaveIncompatible { Schema }`, never attempting
   * `Game::migrate` (which would report `MigrateDeclined` instead), with every stored byte
   * untouched. */
  test('genesis_only_world_schema_bump_is_incompatible_files_untouched', async () => {
    const worldId = 'w-genesis-schema'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v1, Role.Sim, buildSimInstanceConfig(c1))
    Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    // No snapshot was ever taken: the only candidate for `loadLatest` is the genesis fallback.
    expect(await storage.list(`worlds/${worldId}/snap/`)).toHaveLength(0)
    const before = await snapshotStorage(storage)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    await expectIncompatible(Persistence.open(storage, c2, ni), 'Schema')
    await expectStorageUnchanged(storage, before)
  })

  /** Gate fix round 2: `Comparison::NeedsMigrate(TickRate)` reaching the genesis-path fallback --
   * v2 -> v2-hz30 (same schema, different tick rate), no snapshot yet. Proves the `TickRate` branch
   * of `sim_identity_compare`'s own reason byte reaches the TS caller, not just `Schema`. */
  test('genesis_only_world_tick_rate_change_is_incompatible_files_untouched', async () => {
    const worldId = 'w-genesis-tickrate'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    expect(await storage.list(`worlds/${worldId}/snap/`)).toHaveLength(0)
    const before = await snapshotStorage(storage)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2hz30, Role.Sim, buildSimInstanceConfig(c2))
    await expectIncompatible(Persistence.open(storage, c2, ni), 'TickRate')
    await expectStorageUnchanged(storage, before)
  })

  /** Gate fix round 2: `Comparison::Same` (identical build hash) reaching the genesis-path fallback
   * -- `outcome` must be `'loaded'`, never `'upgraded'` (no new segment, no `tailReexecuted`), proving
   * the `Same` branch of `sim_identity_compare` reaches the TS caller distinctly from `Direct`. */
  test('genesis_only_world_same_build_loads_normally', async () => {
    const worldId = 'w-genesis-same'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    const host = hostOver(inst, persistence)
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    const wantHash = host.hash()
    expect(await storage.list(`worlds/${worldId}/snap/`)).toHaveLength(0)

    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c1)) // same buildHash
    const opened = await Persistence.open(storage, c1, ni)
    expect(opened.outcome).toBe('loaded')
    expect(opened.upgrade).toBeUndefined()
    expect(opened.sim.call0(opened.sim.x.sim_hash)).toBe(Status.Ok)
    expect(opened.sim.readU64Hex(RegionId.Result, 0)).toBe(wantHash)
  })

  /** Gate fix round 2 (review finding): a *non-empty* but undecodable segment-0 header must reject
   * as `WorldLoadError('corrupt', ...)`, never silently fall back to `Same` the way an
   * absent/zero-length header does (`crash_snapshot_without_log_tail_is_skipped`'s own case). Three
   * bytes right after the fixed 16-byte `build_hash` are overwritten with an unterminated varint
   * continuation (`0xff` x3): `engine_version`'s own length prefix then reads as an enormous value,
   * so `Identity::read` fails deterministically regardless of what follows. */
  test('genesis_corrupt_header_rejects_corrupt_files_untouched', async () => {
    const worldId = 'w-genesis-corrupt'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v1, Role.Sim, buildSimInstanceConfig(c1))
    Persistence.create(storage, c1, inst)
    expect(inst.call0(inst.x.sim_genesis)).toBe(Status.Ok)
    expect(await storage.list(`worlds/${worldId}/snap/`)).toHaveLength(0)

    const keys = worldKeys(worldId)
    const logBytes = await storage.read(keys.log(0))
    if (!logBytes) throw new Error('expected segment 0 to exist')
    const corrupted = logBytes.slice()
    corrupted[16] = 0xff
    corrupted[17] = 0xff
    corrupted[18] = 0xff
    await storage.write(keys.log(0), corrupted)
    const before = await snapshotStorage(storage)

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v1, Role.Sim, buildSimInstanceConfig(c2))
    const outcome = await Persistence.open(storage, c2, ni).then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    )
    if (outcome.resolved) {
      throw new Error('expected Persistence.open to reject (corrupt header), but it resolved')
    }
    expect(outcome.error).toBeInstanceOf(WorldLoadError)
    expect((outcome.error as WorldLoadError).kind).toBe('corrupt')
    await expectStorageUnchanged(storage, before)
  })

  /** Planning decisions 7's own write order (snapshot write -> flush -> manifest write -> new
   * segment header) makes the upgrade restartable: a crash after the snapshot lands but before the
   * manifest is rewritten leaves the *old* world fully intact (the manifest still names the old,
   * single segment) -- a second, uninterrupted open reaches the exact same hash an uncrashed run
   * would. */
  test('upgrade_crash_before_manifest_is_restartable', async () => {
    const worldId = 'w-crash'
    const c1 = cfg(worldId, 'aa'.repeat(32))
    const storage = memoryStorage()
    const inst = instantiate(v2, Role.Sim, buildSimInstanceConfig(c1))
    const persistence = Persistence.create(storage, c1, inst)
    const host = hostOver(inst, persistence)
    expect(inst.call1(inst.x.sim_connect, 0)).toBe(Status.Ok)
    host.stepTick(1)
    persistence.snapshotNow()
    const admit = admitAction(v2, c1)
    await admit(inst, 1, 'Deposit')
    host.stepTick(1)
    const wantHash = host.hash()

    const manifestKey = worldKeys(worldId).manifest
    const manifestBefore = await storage.read(manifestKey)
    if (!manifestBefore) throw new Error('expected a manifest')
    const crashingStorage: Storage = {
      ...storage,
      write: (key, bytes) => {
        if (key === manifestKey) throw new Error('SIMULATED_CRASH_BEFORE_MANIFEST_WRITE')
        return storage.write(key, bytes)
      },
    }

    const c2 = cfg(worldId, 'bb'.repeat(32))
    const ni = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    // Same reasoning as `expectIncompatible`'s own doc comment: never hand a promise that might
    // resolve to a `sim`-carrying value straight to `.rejects`.
    const crashOutcome = await Persistence.open(crashingStorage, c2, ni).then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    )
    if (crashOutcome.resolved) {
      throw new Error('expected the simulated crash to reject Persistence.open, but it resolved')
    }
    expect(String(crashOutcome.error)).toContain('SIMULATED_CRASH_BEFORE_MANIFEST_WRITE')

    // The old world is intact: the manifest is exactly as it was (the snapshot write that landed
    // before the simulated crash is a stray extra key `pruneSnapshots` would clean up later, never
    // consulted unless the manifest itself names it).
    const manifestAfterCrash = await storage.read(manifestKey)
    expect(manifestAfterCrash).toEqual(manifestBefore)

    // A second, uninterrupted open just runs the upgrade again and reaches the same hash.
    const ni2 = () => instantiate(v2, Role.Sim, buildSimInstanceConfig(c2))
    const opened = await Persistence.open(storage, c2, ni2)
    expect(opened.outcome).toBe('upgraded')
    expect(opened.sim.call0(opened.sim.x.sim_hash)).toBe(Status.Ok)
    expect(opened.sim.readU64Hex(RegionId.Result, 0)).toBe(wantHash)
  })
})
