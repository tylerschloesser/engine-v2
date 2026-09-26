// The 0005 Upgrades sequence (docs/decisions/0005-persistence-and-recovery.md "Upgrades";
// docs/plan/24b-upgrade-and-migration.md step 4), driven from inside `Persistence.loadLatest`
// (`persistence.ts`) in place of a plain `sim_restore_begin`/`push`/`end` call: since M24b, a
// candidate snapshot's own identity may legitimately differ from the running build's, and only
// `sim_upgrade_end` (`crates/engine/src/host/mod.rs`) -- which alone has `persist::Identity::
// compare`'s verdict -- knows whether that means a direct load, a `Game::migrate` run, or a clean
// `SaveIncompatible`. This module is the low-level ABI driver plus the "open a new segment after an
// upgrade" write sequence (Planning decisions 7); `persistence.ts` owns the per-candidate loop,
// `WorldLoadError` and the manifest/chunk-bits policy around it.
import { RegionId, Status } from '../abi.js'
import type { EngineInstance } from '../loader.js'
import type { Storage, WorldKeys } from '../storage/types.js'
import type { IdentityJson, ManifestV1 } from './persistence.js'

/** `IncompatReason` (`crates/engine/src/abi/registry.rs`), by its wire discriminant --
 * `sim_upgrade_end` never writes `ChunkSize` (Scope: raised by `persistence.ts` itself, from the
 * manifest, before any ABI call at all). */
const INCOMPAT_REASON_BY_BYTE = [
  'Schema',
  'TickRate',
  'Worldgen',
  'MigrateDeclined',
  'Container',
  'Decode',
] as const

export type IncompatReasonName = (typeof INCOMPAT_REASON_BY_BYTE)[number] | 'ChunkSize'

function decodeIncompatReason(byte: number): IncompatReasonName {
  return INCOMPAT_REASON_BY_BYTE[byte] ?? 'Decode'
}

/** Gate-fix (docs/plan/24b-upgrade-and-migration.md: "known gap" flagged in this milestone's own
 * Deviations): mirrors `persist::Identity::compare`'s own decision matrix
 * (`crates/engine/src/persist/identity.rs`) for the one path that can never reach that Rust
 * function at all -- `Persistence.loadLatest`'s genesis-replay fallback (no snapshot has ever been
 * written yet) has no snapshot container to feed `sim_upgrade_begin`/`push`/`end` (that trio decodes
 * 0005 Formats' `magic|container_version|varint(len)|identity|...` envelope, which does not exist
 * before the first snapshot does). `stored`/`running` are the two `IdentityJson` values
 * `persistence.ts` already decodes with plain JS (`decodeIdentity`, no ABI call either): `stored` is
 * segment 0's own on-disk header (`SegmentHeader::write` writes `identity.write` first, with no
 * envelope in front of it -- `Persistence.create` already decodes the same bytes the same way), and
 * `running` is this build's own (`sim_segment_header(0, GENESIS_BASE_TICK)`). Field priority (schema,
 * then tick rate, then worldgen) matches `Identity::compare` exactly -- keep this in lockstep with
 * that matrix if it ever changes; a world this young (no snapshot yet) can only take `Same`/`Direct`
 * here, never `NeedsMigrate`'s own `migrate` path (there is no old snapshot to decode an `OldStore`
 * from), so `Persistence.loadLatest` rejects a `NeedsMigrate` verdict outright, with no write of any
 * kind, rather than attempting anything further. */
export function compareIdentity(
  stored: IdentityJson,
  running: IdentityJson,
): { kind: 'same' } | { kind: 'direct' } | { kind: 'needsMigrate'; reason: MismatchReasonName } {
  if (stored.buildHash === running.buildHash) return { kind: 'same' }
  if (
    stored.schemaVersion === running.schemaVersion &&
    stored.tickRateHz === running.tickRateHz &&
    stored.worldgen.version === running.worldgen.version &&
    stored.worldgen.fingerprint === running.worldgen.fingerprint
  ) {
    return { kind: 'direct' }
  }
  if (stored.schemaVersion !== running.schemaVersion) {
    return { kind: 'needsMigrate', reason: 'Schema' }
  }
  if (stored.tickRateHz !== running.tickRateHz) return { kind: 'needsMigrate', reason: 'TickRate' }
  return { kind: 'needsMigrate', reason: 'Worldgen' }
}

/** `persist::MismatchReason`'s three variants (`Identity::compare`'s own return type) -- a subset of
 * `IncompatReasonName` (excludes the four reasons only ever produced downstream of `compare`, per
 * this module's own Deviations). */
export type MismatchReasonName = 'Schema' | 'TickRate' | 'Worldgen'

/** One `sim_upgrade_begin`/`push`/`end` run over one candidate snapshot's bytes, mirroring
 * `Persistence.loadLatest`'s own pre-M24b `sim_restore_*` loop body exactly (same block-feeding
 * shape) but reporting the richer outcome `sim_upgrade_end` can now return. Never throws: a
 * `SaveIncompatible` result is reported, not thrown, so the caller (which knows the candidate's raw
 * bytes and the running identity already) can build the richest possible `WorldLoadError` itself. */
export type UpgradeCandidateResult =
  | { kind: 'ok'; outcome: 'direct-or-same'; logSegment: number; logOffset: number }
  | { kind: 'ok'; outcome: 'migrated'; logSegment: number; logOffset: number }
  | { kind: 'incompatible'; reason: IncompatReasonName }
  | { kind: 'unusable' } // `Status.Corrupt`/`ContainerVersion`/a torn envelope: try an older candidate.

export function runUpgradeCandidate(
  inst: EngineInstance,
  bytes: Uint8Array,
): UpgradeCandidateResult {
  const beginStatus = inst.call1(inst.x.sim_upgrade_begin, bytes.length)
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('runUpgradeCandidate: the Persist region is absent')
  let pushesOk = beginStatus === Status.Ok
  if (pushesOk) {
    for (let off = 0; off < bytes.length; ) {
      const n = Math.min(region.len, bytes.length - off)
      region.u8.set(bytes.subarray(off, off + n), 0)
      const pushStatus = inst.call1(inst.x.sim_upgrade_push, n)
      if (pushStatus !== Status.Ok) {
        pushesOk = false
        break
      }
      off += n
    }
  }
  const endStatus = inst.call0(inst.x.sim_upgrade_end)
  const result = inst.region(RegionId.Result)
  if (!result) throw new Error('runUpgradeCandidate: the Result region is absent')
  if (!pushesOk) return { kind: 'unusable' }
  if (endStatus === Status.SaveIncompatible) {
    return { kind: 'incompatible', reason: decodeIncompatReason(result.u8[0] ?? 5) }
  }
  if (endStatus !== Status.Ok) return { kind: 'unusable' }
  const view = new DataView(result.u8.buffer, result.u8.byteOffset, 9)
  const outcome = view.getUint8(0) === 1 ? 'migrated' : 'direct-or-same'
  const logSegment = view.getUint32(1, true)
  const logOffset = view.getUint32(5, true)
  return { kind: 'ok', outcome, logSegment, logOffset }
}

/** Runs the scan pass alone (`sim_replay_scan_begin`/`push`/`end`, never `sim_replay_begin`/`push`/
 * `end`) purely to count records over `tail` -- the `migrated` outcome's own "how many records this
 * abandoned tail held" report (decision 6): that path never replays the tail at all, so this is the
 * only count ever taken of it. Requires a live `Sim` (the migrated one `sim_upgrade_end` just built).
 */
export function scanRecordCount(inst: EngineInstance, segment: number, tail: Uint8Array): number {
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('scanRecordCount: the Persist region is absent')
  inst.call1(inst.x.sim_replay_scan_begin, segment)
  for (let off = 0; off < tail.length; ) {
    const n = Math.min(region.len, tail.length - off)
    region.u8.set(tail.subarray(off, off + n), 0)
    inst.call1(inst.x.sim_replay_scan_push, n)
    off += n
  }
  inst.call0(inst.x.sim_replay_scan_end)
  const result = inst.region(RegionId.Result)
  if (!result) return 0
  return new DataView(result.u8.buffer, result.u8.byteOffset, 4).getUint32(0, true)
}

/** The direct/same path's own apply-pass dropped-undecodable-record count (decision 6, 0024 §3b):
 * read from `Result[0..4]` right after `sim_replay_end` (which this module does not itself call --
 * `persistence.ts`'s existing scan+replay sequence already does, unchanged; this is just the reader
 * for the new count it now also writes there). */
export function replayDroppedCount(inst: EngineInstance): number {
  const result = inst.region(RegionId.Result)
  if (!result) return 0
  return new DataView(result.u8.buffer, result.u8.byteOffset, 4).getUint32(0, true)
}

const textEncoder = new TextEncoder()

/** Planning decisions 7's own write order, for the segment an upgrade always opens (0005
 * Consequences: "a changed `.wasm` always starts a new segment, even for a rules-only change"):
 * `write` the migrated/re-executed state's own snapshot -> `flush()` -> `write` the manifest (old
 * segment sealed with `tailReexecuted`, new segment entry) -> `append` the new segment's own header.
 * A crash before the manifest write leaves the old world intact (a stray new snapshot is pruned
 * later, `Persistence.pruneSnapshots`); `sim` must already be the *new* (migrated or re-executed)
 * live instance, and its own tick is the new segment's base. Returns the healed manifest plus the
 * new segment's own position, for the caller to continue a live `Persistence` from. */
export async function openNewSegmentAfterUpgrade(
  storage: Storage,
  keys: WorldKeys,
  manifest: ManifestV1,
  runningIdentity: IdentityJson,
  inst: EngineInstance,
  oldSegment: number,
  tailReexecuted: boolean,
): Promise<{ manifest: ManifestV1; newSegment: number; logOffset: number; tick: number }> {
  const tick = inst.call0(inst.x.sim_tick_now)
  const newSegment = oldSegment + 1
  const headerLen = inst.call2(inst.x.sim_segment_header, newSegment, tick)
  if (headerLen < 0) {
    throw new Error(`openNewSegmentAfterUpgrade: sim_segment_header failed: status ${-headerLen}`)
  }
  const region = inst.region(RegionId.Persist)
  if (!region) throw new Error('openNewSegmentAfterUpgrade: the Persist region is absent')
  const headerBytes = region.u8.slice(0, headerLen)
  const logOffset = headerBytes.length

  // Decision 7 step 1: the new snapshot, at the position right after the new segment's own header
  // (there is no tail to resume from -- the header is the whole of the new segment so far).
  const beginStatus = inst.call2(inst.x.sim_snapshot_begin, newSegment, logOffset)
  if (beginStatus !== Status.Ok) {
    throw new Error(`openNewSegmentAfterUpgrade: sim_snapshot_begin failed: status ${beginStatus}`)
  }
  const snapshotChunks: Uint8Array[] = []
  let snapshotLen = 0
  for (;;) {
    const n = inst.call0(inst.x.sim_snapshot_next)
    if (n < 0) throw new Error(`openNewSegmentAfterUpgrade: sim_snapshot_next failed: status ${-n}`)
    if (n === 0) break
    snapshotChunks.push(region.u8.slice(0, n))
    snapshotLen += n
  }
  const snapshotBytes = new Uint8Array(snapshotLen)
  let pos = 0
  for (const chunk of snapshotChunks) {
    snapshotBytes.set(chunk, pos)
    pos += chunk.length
  }
  await storage.write(keys.snap(tick), snapshotBytes)

  // Decision 7 step 2.
  await Promise.resolve(storage.flush())

  // Decision 7 step 3: seal the old segment, add the new one (with the *running* identity -- the
  // whole reason this segment exists at all).
  const lastIndex = manifest.segments.length - 1
  const healedManifest: ManifestV1 = {
    ...manifest,
    segments: [
      ...manifest.segments.map((s, i) =>
        i === lastIndex ? { ...s, sealed: true, tailReexecuted } : s,
      ),
      {
        index: newSegment,
        identity: runningIdentity,
        base: tick,
        sealed: false,
        tailReexecuted: false,
      },
    ],
  }
  await storage.write(keys.manifest, textEncoder.encode(JSON.stringify(healedManifest)))

  // Decision 7 step 4.
  storage.append(keys.log(newSegment), headerBytes)

  return { manifest: healedManifest, newSegment, logOffset, tick }
}
