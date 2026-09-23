// The client worker's DrawList publish pump (docs/plan/17-drawlist-and-sprites.md, step 3): copies
// the header plus only the body blocks a frame actually used from `RegionId.DrawList` (Rust-owned
// WASM memory, written by `frame()`'s own `DrawList::sort_into`) into the `drawList` triple
// buffer's back slot, then publishes -- Planning decisions "Proportional publish": staging and each
// slot body are 32 blocks of 64 KiB with view pairs made at init (`sab/triple.ts`'s own
// `TripleWriter`), and a frame copies only the blocks it used. Called from `worker/client.ts`'s
// `body()` right after a real `frame()` call succeeds -- once per produced frame (0018 §2), never
// on a wake where `frame()` didn't run.
import type { EngineInstance, RegionView } from '../loader.js'
import { copyBytes } from '../sab/bytes.js'
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../sab/layout.js'
import { BLOCK_BYTES, TripleWriter } from '../sab/triple.js'

/** Matches `client::drawlist::DRAW_BYTES` (`crates/engine/src/client/drawlist.rs`). */
const DRAW_BYTES = 32

export type DrawlistPump = { publish(): void }

/** Built once at setup; `publish()` itself allocates nothing (`.claude/rules/hot-paths.md`: whole
 * blocks copied through `copyBytes`, never `subarray()`). `drawListRegion` is `null` for a client
 * role with no `RegionId.DrawList` declared (no `Game`, e.g. `fx-hash`'s `topology`/`echo` pages):
 * `publish` is then a no-op, the same "costs nothing on a page without the feature" shape
 * `client-upload.ts`'s `createUploadPump` already uses for `chunkTexels`. */
export function createDrawlistPump(
  inst: EngineInstance,
  drawListSab: SharedArrayBuffer,
  drawListRegion: RegionView | null,
): DrawlistPump {
  const writer = new TripleWriter(drawListSab, DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)

  function publish(): void {
    if (!drawListRegion) return
    const recordCount = inst.call0(inst.x.drawlist_len)
    const usedBytes = recordCount * DRAW_BYTES
    const blocks = Math.ceil(usedBytes / BLOCK_BYTES)
    const slot = writer.backSlot()
    copyBytes(writer.headerView(slot), 0, drawListRegion.u8, 0, DRAWLIST_HEADER_BYTES)
    for (let b = 0; b < blocks; b++) {
      const start = b * BLOCK_BYTES
      const len = Math.min(BLOCK_BYTES, usedBytes - start)
      copyBytes(
        writer.bodyBlockView(slot, b),
        0,
        drawListRegion.u8,
        DRAWLIST_HEADER_BYTES + start,
        len,
      )
    }
    writer.publish()
  }

  return { publish }
}
