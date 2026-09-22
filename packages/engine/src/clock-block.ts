// The clock block (docs/decisions/0015 §2 "clocks"; docs/plan/16-action-round-trip.md Scope): a
// seqlock-guarded SAB record the client worker writes after each `on_frame` (`worker/
// client-net.ts`); main reads it synchronously from `dispatch()` and, in production, from the
// per-rAF UI-ring drain and (M16b) `client.clock()`. Same hand-rolled shape as `camera/block.ts`
// (typed field views built once, not the generic `SeqlockWriter`/`SeqlockReader` of `sab/
// seqlock.ts`), for the same reason: a caller wants individual `u32` fields, not one opaque byte
// blob copied through a scratch buffer per read.
//
// `sab/layout.ts`'s `createSeqlock(CLOCK_BLOCK_DATA_BYTES)` backs `SabSet.clockBlock` with 32
// data bytes (8 `u32` slots: M06's own sizing, "M16 owns the field layout"). This milestone uses
// the first six: `authoritativeTick, predictedTick, ticksPerSecond, sessionState, seqSeed,
// ackSeq`. The remaining 8 bytes are reserved for `revealed` (M28) and `tick_fraction` (M26) and
// are never read or written here, so this file's own read/write window only ever needs to cover
// the 24 bytes it actually uses.

export const CLOCK_SEQ_BYTES = 4
export const CLOCK_OFF_AUTHORITATIVE_TICK = 0
export const CLOCK_OFF_PREDICTED_TICK = 4
export const CLOCK_OFF_TICKS_PER_SECOND = 8
export const CLOCK_OFF_SESSION_STATE = 12
export const CLOCK_OFF_SEQ_SEED = 16
export const CLOCK_OFF_ACK_SEQ = 20
/** Bytes of the six fields this milestone owns (not the whole 32-byte data region). */
export const CLOCK_FIELDS_BYTES = 24

/** `session_state` (Scope: "0 connecting, 1 live"). */
export const SessionState = { Connecting: 0, Live: 1 } as const
export type SessionState = (typeof SessionState)[keyof typeof SessionState]

export type ClockFields = {
  authoritativeTick: number
  predictedTick: number
  ticksPerSecond: number
  sessionState: number
  seqSeed: number
  ackSeq: number
}

const MAX_RETRIES = 8

export class ClockBlockView {
  private readonly seq: Int32Array
  private readonly authoritativeTick: Uint32Array
  private readonly predictedTick: Uint32Array
  private readonly ticksPerSecond: Uint32Array
  private readonly sessionState: Uint32Array
  private readonly seqSeed: Uint32Array
  private readonly ackSeq: Uint32Array
  private readonly bytes: Uint8Array
  private readonly scratch: Uint8Array
  /** A view over `scratch`'s own (non-shared) buffer, built once here so a read never allocates a
   * fresh typed-array view (`.claude/rules/hot-paths.md`). */
  private readonly scratchFields: Uint32Array

  constructor(sab: SharedArrayBuffer) {
    const base = CLOCK_SEQ_BYTES
    this.seq = new Int32Array(sab, 0, 1)
    this.authoritativeTick = new Uint32Array(sab, base + CLOCK_OFF_AUTHORITATIVE_TICK, 1)
    this.predictedTick = new Uint32Array(sab, base + CLOCK_OFF_PREDICTED_TICK, 1)
    this.ticksPerSecond = new Uint32Array(sab, base + CLOCK_OFF_TICKS_PER_SECOND, 1)
    this.sessionState = new Uint32Array(sab, base + CLOCK_OFF_SESSION_STATE, 1)
    this.seqSeed = new Uint32Array(sab, base + CLOCK_OFF_SEQ_SEED, 1)
    this.ackSeq = new Uint32Array(sab, base + CLOCK_OFF_ACK_SEQ, 1)
    this.bytes = new Uint8Array(sab, 0, base + CLOCK_FIELDS_BYTES)
    this.scratch = new Uint8Array(base + CLOCK_FIELDS_BYTES)
    this.scratchFields = new Uint32Array(this.scratch.buffer, base, 6)
  }

  seqWord(): Int32Array {
    return this.seq
  }
  authoritativeTickView(): Uint32Array {
    return this.authoritativeTick
  }
  predictedTickView(): Uint32Array {
    return this.predictedTick
  }
  ticksPerSecondView(): Uint32Array {
    return this.ticksPerSecond
  }
  sessionStateView(): Uint32Array {
    return this.sessionState
  }
  seqSeedView(): Uint32Array {
    return this.seqSeed
  }
  ackSeqView(): Uint32Array {
    return this.ackSeq
  }
  bytesView(): Uint8Array {
    return this.bytes
  }
  scratchView(): Uint8Array {
    return this.scratch
  }
  scratchFieldsView(): Uint32Array {
    return this.scratchFields
  }
}

/** Writer: the client worker, after each `on_frame` that actually produced a fresh summary (not
 * every wake -- Scope: "written by the client worker after each `on_frame`"). Not concurrent with
 * itself (one writer), so the seq word only needs `Atomics` for the cross-thread fence. */
export function writeClockBlock(block: ClockBlockView, f: ClockFields): void {
  Atomics.add(block.seqWord(), 0, 1) // begin: odd
  block.authoritativeTickView()[0] = f.authoritativeTick
  block.predictedTickView()[0] = f.predictedTick
  block.ticksPerSecondView()[0] = f.ticksPerSecond
  block.sessionStateView()[0] = f.sessionState
  block.seqSeedView()[0] = f.seqSeed
  block.ackSeqView()[0] = f.ackSeq
  Atomics.add(block.seqWord(), 0, 1) // end: even, published
}

/** Reader: copy-with-retry into `out` (caller-owned, built once -- a `Uint32Array(6)` in the same
 * field order as `ClockFields`'s own keys). Returns `false`, leaving `out` untouched, only if
 * every retry raced the writer (same shape as `camera/block.ts`'s `readCameraBlockInto`). */
export function readClockBlockInto(block: ClockBlockView, out: Uint32Array): boolean {
  const seq = block.seqWord()
  const bytes = block.bytesView()
  const scratch = block.scratchView()
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const s1 = Atomics.load(seq, 0)
    if ((s1 & 1) === 1) continue
    scratch.set(bytes) // TypedArray.set, not copyBytes: see sab/seqlock.ts on why the window matters
    const s2 = Atomics.load(seq, 0)
    if (s1 === s2) {
      out.set(block.scratchFieldsView())
      return true
    }
  }
  return false
}

/** Field indices into `readClockBlockInto`'s own `out` (same order `ClockFields` declares them,
 * and the same order `writeClockBlock` writes them). */
export const CLOCK_FIELD = {
  AuthoritativeTick: 0,
  PredictedTick: 1,
  TicksPerSecond: 2,
  SessionState: 3,
  SeqSeed: 4,
  AckSeq: 5,
} as const
