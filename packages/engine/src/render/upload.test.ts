// `render/upload.ts` unit coverage (docs/plan/09-renderer-terrain.md, Tests added:
// `upload.budget_stops_and_takes_one`; Open gate failures item 5, gate round 1 -- this test did not
// exist before this round). Drives `createUploadDrain` against a real ring (`sab/ring.ts`, the same
// `createRing(4120, 4)` shape every other terrain page uses) loaded with hand-built records, and a
// fake `TerrainRenderer` (the `frame-loop.test.ts` pattern) that only counts calls -- no GPU device
// needed, since `render/upload.ts` never touches `renderer.device` itself.
import { expect, test } from 'vitest'
import { createRing, RingConsumer, RingProducer } from '../sab/ring.js'
import type { TerrainRenderer } from './terrain.js'
import { createUploadDrain } from './upload.js'

const RECORD_BYTES = 4112
const KIND_CHUNK = 1
const KIND_INDIR = 3
const CHUNK_BYTE_COST = 4096
const ENTRY_BYTE_COST = 64

/** One record's worth of bytes, header only (the payload stays zero-filled -- `render/upload.ts`'s
 * own cost accounting reads only the header's `kind`/`count`, never the payload's content). */
function record(kind: number, count: number): Uint8Array {
  const bytes = new Uint8Array(RECORD_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, kind, true)
  view.setUint16(2, 0, true) // slot: unused by this test's fake renderer
  view.setUint16(4, count, true)
  return bytes
}

function fakeRenderer(): TerrainRenderer {
  return {
    device: {} as GPUDevice,
    writeFrameUniform() {},
    writeVisualTable() {},
    writePageChunk() {},
    writePageChunkBytes() {},
    writePageTexel() {},
    writeIndir() {},
    setTileArray() {},
    draw() {},
    drawCalls: () => 0,
    pageSlotsUsed: () => 0,
    frameUniform: {
      camTileX: 0,
      camTileY: 0,
      camFracX: 0,
      camFracY: 0,
      viewportPxW: 0,
      viewportPxH: 0,
      tilesPerPx: 1,
      seed: 0,
      cursorTileX: 0,
      cursorTileY: 0,
      cursorValid: 0,
      neighbourCutoffPx: 0,
    },
    viewport: { widthPx: 0, heightPx: 0, dpr: 1, renderScale: 1 },
    onViewportChange() {},
    notifyViewportChange() {},
  }
}

function push(producer: RingProducer, bytes: Uint8Array): void {
  const claimed = producer.tryClaim()
  if (claimed < 0) throw new Error('test ring full')
  producer.slotView(claimed).set(bytes)
  producer.commit()
}

test('upload.budget_stops_and_takes_one', () => {
  const sab = createRing(RECORD_BYTES + 8, 4)
  const producer = new RingProducer(sab)
  const consumer = new RingConsumer(sab)
  const drain = createUploadDrain(consumer, fakeRenderer())

  // One CHUNK (4,096) and two INDIR records (2 entries = 128, 1 entry = 64): matches
  // `client::upload`'s own accounting exactly (`CHUNK_BYTE_COST`/`ENTRY_BYTE_COST` above mirror
  // `render/upload.ts`'s private constants of the same name).
  push(producer, record(KIND_CHUNK, 0))
  push(producer, record(KIND_INDIR, 2))
  push(producer, record(KIND_INDIR, 1))

  // A budget that fits the first record (4,096) but not the first + second (4,096 + 128 = 4,224):
  // stops before the record that would pass the budget.
  const first = drain.drain(CHUNK_BYTE_COST + ENTRY_BYTE_COST * 2 - 1)
  expect(first).toEqual({ bytes: CHUNK_BYTE_COST, records: 1 })

  // The two remaining records both fit comfortably under a generous budget in one further call.
  const second = drain.drain(1_000_000)
  expect(second).toEqual({ bytes: ENTRY_BYTE_COST * 2 + ENTRY_BYTE_COST, records: 2 })

  // Always takes at least one record, even when the very first one already exceeds the budget.
  push(producer, record(KIND_CHUNK, 0))
  const third = drain.drain(0)
  expect(third).toEqual({ bytes: CHUNK_BYTE_COST, records: 1 })

  // The ring is now empty: a further drain does nothing.
  expect(drain.drain(1_000_000)).toEqual({ bytes: 0, records: 0 })
})
