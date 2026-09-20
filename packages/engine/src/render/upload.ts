// The main-thread upload ferry (docs/decisions/0018-renderer.md §3; docs/plan/09-renderer-
// terrain.md Scope, Planning decisions "Byte budget accounting", "Which chunks upload"): drains
// `uploadRing` at frame start under a per-frame byte budget, applying CHUNK/PATCH/INDIR records to
// a `TerrainRenderer` with reused descriptor objects (`.claude/rules/hot-paths.md`). One record is
// one ring slot (never spanning: `sab/layout.ts`'s `uploadRing.slotBytes` is sized for exactly one
// `RECORD_BYTES` payload), so the slot-level `RingConsumer` API (`peek`/`slotView`/`release`) is
// enough -- no `popInto` assembly step.
import type { RingConsumer } from '../sab/ring.js'
import type { IndirEntry, TerrainRenderer, Texel } from './terrain.js'

/** Matches `client::upload::RECORD_BYTES`. */
const HEADER_BYTES = 16
const KIND_CHUNK = 1
const KIND_PATCH = 2
const KIND_INDIR = 3
const CHUNK_EDGE = 32
const CHUNK_TEXELS = CHUNK_EDGE * CHUNK_EDGE
const INDIR_MAX_ENTRIES = 1024
/** Matches `client::upload::INDIR_NONE`/`render/terrain.ts`'s own `INDIR_NONE` (Open gate failures
 * item 3, gate round 1). */
const INDIR_NONE = 0xffff

/** Planning decisions "Byte budget accounting": a proxy for per-call cost, not the record's own
 * byte size (a CHUNK's on-wire payload is exactly 4,096 bytes; PATCH/INDIR charge per entry). */
const CHUNK_BYTE_COST = 4096
const ENTRY_BYTE_COST = 64

/** 0018 §3: "drained from the upload ring at frame start under a byte budget (default 64 KiB per
 * frame)". */
export const DEFAULT_UPLOAD_BUDGET_BYTES = 64 * 1024

export type UploadDrain = {
  /** Drains at most as many records as fit `budgetBytes`, always taking at least one when the ring
   * is non-empty (Planning decisions). Returns the bytes/records accounted by *this call*. */
  drain(budgetBytes: number): { bytes: number; records: number }
  /** Cumulative bytes drained since this `UploadDrain` was created, across every `drain()` call
   * (Open gate failures item 7, gate round 1): `engine/test`'s `uploadBytes` counter reads this. */
  bytesTotal(): number
  /** Cumulative records drained since creation (`engine/test`'s `uploadRecords` counter). */
  recordsTotal(): number
  /** Cumulative CHUNK records drained since creation (Open gate failures item 3, gate round 1: the
   * zero-GC page's own "uploaded CHUNK records > 0 inside the window" assertion). */
  chunkRecordsTotal(): number
  /** Cumulative count of INDIR entries seen with `value === INDIR_NONE` (Open gate failures item 3:
   * a proxy for "an eviction reached the render side", one entry per `CacheEvent::Evicted` that
   * made it through `Uploader::stage`'s own INDIR queue -- no new ABI export needed). */
  evictedTotal(): number
}

function readU16(u8: Uint8Array, off: number): number {
  return (u8[off] as number) | ((u8[off + 1] as number) << 8)
}

/** Built once per renderer/ring pair; `drain()` itself allocates nothing (`.claude/rules/
 * hot-paths.md`): every scratch object below is created here, at setup, and mutated in place on
 * every call.
 *
 * `sabWriteTextureOk` (Planning decisions "`writeTexture` from a SAB view is unverified", `render/
 * device.ts`'s own probe): when `true`, a CHUNK record's texel payload is handed to `writeTexture`
 * straight from its own ring-slot view (`chunkViews`, one `Uint16Array` per slot, precomputed here
 * at setup -- never derived mid-drain, so a first-sight `subarray`-equivalent never lands inside a
 * measured window); when `false` (the default: unverified on the caller's device, or the caller
 * never probed), each record's payload is copied byte-for-byte into one preallocated non-shared
 * `stagingU16` first. Both paths allocate nothing per record either way. */
export function createUploadDrain(
  consumer: RingConsumer,
  renderer: TerrainRenderer,
  opts?: { sabWriteTextureOk?: boolean },
): UploadDrain {
  const sabWriteTextureOk = opts?.sabWriteTextureOk ?? false
  const chunkViews: Uint16Array[] = []
  if (sabWriteTextureOk) {
    for (let i = 0; i < consumer.slotCount(); i++) {
      const payload = consumer.slotView(i)
      chunkViews.push(
        new Uint16Array(payload.buffer, payload.byteOffset + HEADER_BYTES, CHUNK_TEXELS * 2),
      )
    }
  }
  const stagingU16 = new Uint16Array(CHUNK_TEXELS * 2)
  const stagingU8 = new Uint8Array(stagingU16.buffer)

  const indirScratch: IndirEntry[] = []
  for (let i = 0; i < INDIR_MAX_ENTRIES; i++) indirScratch.push({ x: 0, y: 0, value: 0 })
  const patchTexelScratch: Texel = { base: 0, resource: 0 }

  // Cumulative counters (Open gate failures items 3 and 7, gate round 1): plain numbers mutated in
  // place, never reset, never allocating (`.claude/rules/hot-paths.md`).
  let bytesTotal = 0
  let recordsTotal = 0
  let chunkRecordsTotal = 0
  let evictedTotal = 0

  function applyChunk(slot: number, ringIdx: number, payload: Uint8Array): void {
    if (sabWriteTextureOk) {
      renderer.writePageChunkBytes(slot, chunkViews[ringIdx] as Uint16Array)
      return
    }
    for (let i = 0; i < CHUNK_TEXELS * 4; i++) stagingU8[i] = payload[HEADER_BYTES + i] as number
    renderer.writePageChunkBytes(slot, stagingU16)
  }

  function applyIndir(count: number, payload: Uint8Array): void {
    const n = Math.min(count, INDIR_MAX_ENTRIES)
    for (let i = 0; i < n; i++) {
      const e = indirScratch[i] as IndirEntry
      const base = HEADER_BYTES + i * 4
      e.x = payload[base] as number
      e.y = payload[base + 1] as number
      e.value = readU16(payload, base + 2)
      if (e.value === INDIR_NONE) evictedTotal += 1
    }
    renderer.writeIndir(indirScratch, n)
  }

  function applyPatch(count: number, payload: Uint8Array): void {
    for (let i = 0; i < count; i++) {
      const base = HEADER_BYTES + i * 8
      const slot = readU16(payload, base)
      const index = readU16(payload, base + 2)
      patchTexelScratch.base = readU16(payload, base + 4)
      patchTexelScratch.resource = readU16(payload, base + 6)
      renderer.writePageTexel(slot, index, patchTexelScratch)
    }
  }

  function drain(budgetBytes: number): { bytes: number; records: number } {
    let bytes = 0
    let records = 0
    for (;;) {
      const idx = consumer.peek()
      if (idx < 0) break
      const payload = consumer.slotView(idx)
      const kind = readU16(payload, 0)
      const slot = readU16(payload, 2)
      const count = readU16(payload, 4)
      const cost = kind === KIND_CHUNK ? CHUNK_BYTE_COST : count * ENTRY_BYTE_COST
      if (records > 0 && bytes + cost > budgetBytes) break
      if (kind === KIND_CHUNK) {
        applyChunk(slot, idx, payload)
        chunkRecordsTotal += 1
      } else if (kind === KIND_INDIR) applyIndir(count, payload)
      else if (kind === KIND_PATCH) applyPatch(count, payload)
      consumer.release()
      bytes += cost
      records += 1
    }
    bytesTotal += bytes
    recordsTotal += records
    return { bytes, records }
  }

  return {
    drain,
    bytesTotal: () => bytesTotal,
    recordsTotal: () => recordsTotal,
    chunkRecordsTotal: () => chunkRecordsTotal,
    evictedTotal: () => evictedTotal,
  }
}
