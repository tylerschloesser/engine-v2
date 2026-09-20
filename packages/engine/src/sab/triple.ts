// Triple buffer: a large latest-wins frame (the DrawList; docs/decisions/0015 §2). Three
// `(header, body)` slots plus one `Int32` state word: bits 0-1 the "middle" (free) slot index, bit 2
// dirty (docs/plan/06-sab-primitives-and-workers.md, Planning decisions "Triple-buffer state
// word"). Writer and reader each own one slot outright and race only over the third, handed off by
// one `Atomics.exchange` each side: `publish()` swaps the writer's back slot into the state
// (dirty), taking back whatever was there; `acquire()` swaps the reader's front slot in only when
// dirty. No slot is ever visible to both sides.
import { at } from './bytes.js'

const STATE_BYTES = 4
const SLOT_INDEX_MASK = 0b011
const DIRTY = 0b100
const BLOCK_BYTES = 65536 // M17's proportional-copy block size

function slotOffset(headerBytes: number, bodyBytes: number, slot: number): number {
  return STATE_BYTES + slot * (headerBytes + bodyBytes)
}

export function createTriple(headerBytes: number, bodyBytes: number): SharedArrayBuffer {
  return new SharedArrayBuffer(STATE_BYTES + 3 * (headerBytes + bodyBytes))
}

/** Shared per-slot view construction; called once by each side's real constructor. */
function createTripleViews(sab: SharedArrayBuffer, headerBytes: number, bodyBytes: number) {
  const state = new Int32Array(sab, 0, 1)
  const headers: Uint8Array[] = []
  const bodies: Uint8Array[] = []
  const bodyBlocks: Uint8Array[][] = []
  const blocksPerSlot = Math.ceil(bodyBytes / BLOCK_BYTES)
  for (let slot = 0; slot < 3; slot++) {
    const off = slotOffset(headerBytes, bodyBytes, slot)
    headers.push(new Uint8Array(sab, off, headerBytes))
    const body = new Uint8Array(sab, off + headerBytes, bodyBytes)
    bodies.push(body)
    const blocks: Uint8Array[] = []
    for (let b = 0; b < blocksPerSlot; b++) {
      const start = b * BLOCK_BYTES
      const len = Math.min(BLOCK_BYTES, bodyBytes - start)
      blocks.push(new Uint8Array(sab, off + headerBytes + start, len))
    }
    bodyBlocks.push(blocks)
  }
  return { state, headers, bodies, bodyBlocks }
}

export class TripleWriter {
  private readonly state: Int32Array
  private readonly headers: Uint8Array[]
  private readonly bodies: Uint8Array[]
  private readonly bodyBlocks: Uint8Array[][]
  private back: number

  constructor(sab: SharedArrayBuffer, headerBytes: number, bodyBytes: number) {
    const v = createTripleViews(sab, headerBytes, bodyBytes)
    this.state = v.state
    this.headers = v.headers
    this.bodies = v.bodies
    this.bodyBlocks = v.bodyBlocks
    this.back = 1 // 0 starts as the state's initial "middle"; the reader starts owning 2
  }

  backSlot(): number {
    return this.back
  }

  headerView(slot: number): Uint8Array {
    return at(this.headers, slot)
  }

  bodyView(slot: number): Uint8Array {
    return at(this.bodies, slot)
  }

  bodyBlockView(slot: number, block: number): Uint8Array {
    return at(at(this.bodyBlocks, slot), block)
  }

  /** Publishes the back slot and takes whatever slot the reader last released. */
  publish(): void {
    const old = Atomics.exchange(this.state, 0, this.back | DIRTY)
    this.back = old & SLOT_INDEX_MASK
  }
}

export class TripleReader {
  private readonly state: Int32Array
  private readonly headers: Uint8Array[]
  private readonly bodies: Uint8Array[]
  private readonly bodyBlocks: Uint8Array[][]
  private front: number
  /** Whether the last `acquire()` actually swapped in a new frame. */
  fresh: boolean

  constructor(sab: SharedArrayBuffer, headerBytes: number, bodyBytes: number) {
    const v = createTripleViews(sab, headerBytes, bodyBytes)
    this.state = v.state
    this.headers = v.headers
    this.bodies = v.bodies
    this.bodyBlocks = v.bodyBlocks
    this.front = 2
    this.fresh = false
  }

  headerView(slot: number): Uint8Array {
    return at(this.headers, slot)
  }

  bodyView(slot: number): Uint8Array {
    return at(this.bodies, slot)
  }

  bodyBlockView(slot: number, block: number): Uint8Array {
    return at(at(this.bodyBlocks, slot), block)
  }

  /** Returns the current front slot index, swapping in the writer's latest publish if dirty. */
  acquire(): number {
    const s = Atomics.load(this.state, 0)
    if ((s & DIRTY) === 0) {
      this.fresh = false
      return this.front
    }
    const old = Atomics.exchange(this.state, 0, this.front)
    this.front = old & SLOT_INDEX_MASK
    this.fresh = true
    return this.front
  }
}
