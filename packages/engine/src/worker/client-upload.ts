// The client worker's upload-staging pump (docs/plan/09-renderer-terrain.md, Order of work 5;
// Planning decisions "Byte budget accounting", "`writeTexture` from a SAB view is unverified"):
// called from `worker/client.ts`'s `body()` after `frame()`, on every wake (same "costs nothing and
// answers 0 on a page with no `client::Uploader`" shape `client-gen.ts`'s pump already uses).
// `upload_stage(free)` is called with `min(ring free slots, 16)` -- Rust's own `Uploader::stage`
// already sorts/prioritises CHUNK-then-INDIR-then-PATCH and stops at the byte budget; this file's
// only job is to never ask for more records than the ring can currently accept, then copy each
// staged 4,112-byte block into its own ring slot (`RingProducer`'s slot-level API: one record, one
// slot, never spanning -- `sab/layout.ts`'s `uploadRing.slotBytes` is sized for exactly this).
import type { EngineInstance, RegionView } from '../loader.js'
import { copyBytes } from '../sab/bytes.js'
import { RingProducer } from '../sab/ring.js'

/** Matches `client::upload::RECORD_BYTES` (`crates/engine/src/client/upload.rs`): a 16-byte header
 * plus a 4,096-byte payload. */
const RECORD_BYTES = 4112
/** Matches `fixtures/terrain`'s own `MAX_STAGE_BATCH` (the `ChunkTexels` region is sized for
 * exactly this many records) and the brief's own "sized here as 16 blocks" (Seams, Provides). */
export const UPLOAD_BATCH_MAX = 16

export type UploadPump = { pump(): void }

/** Built once at setup; `pump()` itself allocates nothing. `chunkTexels` is `null` for a client
 * role with no `client::Uploader` (no terrain rendering, e.g. `fx-hash`): `upload_stage` always
 * answers `0` there, so requesting max `0` is correct and the copy loop below never runs. */
export function createUploadPump(
  inst: EngineInstance,
  uploadRingSab: SharedArrayBuffer,
  chunkTexels: RegionView | null,
): UploadPump {
  const ring = new RingProducer(uploadRingSab)

  function pump(): void {
    const want = chunkTexels ? Math.min(ring.freeSlots(), UPLOAD_BATCH_MAX) : 0
    if (want <= 0) return
    const n = inst.call1(inst.x.upload_stage, want)
    // `chunkTexels` is non-null whenever `n` can be > 0 (see the doc comment above); the cast below
    // just tells the checker what the runtime already guarantees.
    const region = chunkTexels as RegionView
    for (let i = 0; i < n; i++) {
      const claimed = ring.tryClaim()
      if (claimed < 0) break // reserved `want` >= n above: this would mean a lost race with the
      // single-threaded assumption (0015), never expected in practice.
      copyBytes(ring.slotView(claimed), 0, region.u8, i * RECORD_BYTES, RECORD_BYTES)
      ring.commit()
    }
  }

  return { pump }
}
