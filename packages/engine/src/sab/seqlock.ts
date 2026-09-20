// Seqlock: a small latest-wins record (camera block, clocks; docs/decisions/0015 §2). Layout:
// `[seq: i32][data: bytes]`. Writer `begin()`/`end()` bracket a write with two `Atomics.add`s (the
// word is odd mid-write, even once published). Reader `readInto()` retries up to 8 times (docs/plan/
// 06-sab-primitives-and-workers.md, Planning decisions "Seqlock reader rule"): a clean copy is
// staged in a scratch buffer first and only moved into the caller's `dst` once verified, so a torn
// attempt never overwrites the caller's previous good copy. Both copies move a whole preallocated
// view (`TypedArray.set`, not `sab/bytes.ts`'s per-byte `copyBytes`): keeping the window between the
// two seq checks as short as possible is what keeps a real writer/reader race from exhausting the
// retry budget (measured while developing `seqlock.test.ts`).

const SEQ_BYTES = 4
const MAX_RETRIES = 8

export function createSeqlock(bytes: number): SharedArrayBuffer {
  return new SharedArrayBuffer(SEQ_BYTES + bytes)
}

export class SeqlockWriter {
  private readonly seq: Int32Array
  private readonly data: Uint8Array

  constructor(sab: SharedArrayBuffer) {
    this.seq = new Int32Array(sab, 0, 1)
    this.data = new Uint8Array(sab, SEQ_BYTES)
  }

  /** Marks a write in progress (odd) and returns the preallocated data view to write into. */
  begin(): Uint8Array {
    Atomics.add(this.seq, 0, 1)
    return this.data
  }

  /** Marks the write complete (even): publishes it to readers. */
  end(): void {
    Atomics.add(this.seq, 0, 1)
  }
}

export class SeqlockReader {
  private readonly seq: Int32Array
  private readonly data: Uint8Array
  private readonly scratch: Uint8Array
  private tornCount: number

  constructor(sab: SharedArrayBuffer) {
    this.seq = new Int32Array(sab, 0, 1)
    this.data = new Uint8Array(sab, SEQ_BYTES)
    this.scratch = new Uint8Array(this.data.length)
    this.tornCount = 0
  }

  /** Copies a clean snapshot into `dst[off..)`. Returns false (and leaves `dst` untouched, bumping
   * `torn()`) only if every retry raced a writer. */
  readInto(dst: Uint8Array, off: number): boolean {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const s1 = Atomics.load(this.seq, 0)
      if ((s1 & 1) === 1) continue // write in progress
      this.scratch.set(this.data)
      const s2 = Atomics.load(this.seq, 0)
      if (s1 === s2) {
        dst.set(this.scratch, off)
        return true
      }
    }
    this.tornCount += 1
    return false
  }

  torn(): number {
    return this.tornCount
  }
}
