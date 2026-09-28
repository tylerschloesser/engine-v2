// The clock block (docs/decisions/0015 §2 "clocks"; docs/plan/16-action-round-trip.md Scope): a
// seqlock-guarded SAB record the client worker writes after each `on_frame` (`worker/
// client-net.ts`); main reads it synchronously from `dispatch()` and, in production, from the
// per-rAF UI-ring drain and (M16b) `client.clock()`. Same hand-rolled shape as `camera/block.ts`
// (typed field views built once, not the generic `SeqlockWriter`/`SeqlockReader` of `sab/
// seqlock.ts`), for the same reason: a caller wants individual `u32` fields, not one opaque byte
// blob copied through a scratch buffer per read.
//
// `sab/layout.ts`'s `createSeqlock(CLOCK_BLOCK_DATA_BYTES)` backs `SabSet.clockBlock` with 32
// data bytes (8 `u32` slots: M06's own sizing, "M16 owns the field layout"). M16/M16b used the
// first six: `authoritativeTick, predictedTick, ticksPerSecond, sessionState, seqSeed, ackSeq`.
// docs/plan/26-prediction-rendering-and-clocks.md steps 4-6 claims the seventh, `tickFraction`
// (an `f32`, not a tick count -- `ClientCore::tick_fraction`'s own `HostClock`-derived value,
// `client_clock_stats`'s newly widened result). The eighth (offset 28) stays reserved for
// `revealed` (M28).

import { at } from './sab/bytes.js'

export const CLOCK_SEQ_BYTES = 4
export const CLOCK_OFF_AUTHORITATIVE_TICK = 0
export const CLOCK_OFF_PREDICTED_TICK = 4
export const CLOCK_OFF_TICKS_PER_SECOND = 8
export const CLOCK_OFF_SESSION_STATE = 12
export const CLOCK_OFF_SEQ_SEED = 16
export const CLOCK_OFF_ACK_SEQ = 20
/** M26 steps 4-6: an `f32`, read/written through a `Float32Array` view over the same bytes (every
 * other field here is a `u32`). */
export const CLOCK_OFF_TICK_FRACTION = 24
/** docs/plan/28-sessions-and-reconnect.md Seams: "the `revealed` clock-block word" -- the eighth
 * and last slot the 32-byte data region has room for (this file's own module doc comment: "stays
 * reserved for `revealed`"). `0`/`1` as a `u32` (`ClientCore::revealed()`'s own boolean, crossed
 * the same "numbers only" way every other field here is): true once every chunk of the visible
 * rectangle is both held by the replica and locally generated (M29 gates the first terrain draw on
 * it; steps 3-5 are the first consumer, this milestone only lands the field). */
export const CLOCK_OFF_REVEALED = 28
/** Bytes of all eight fields this file owns -- the whole 32-byte data region. */
export const CLOCK_FIELDS_BYTES = 32

/** `session_state` (docs/plan/28-sessions-and-reconnect.md Seams, extending M16's `0 Connecting, 1
 * Live`): `0 Handshaking | 1 Online | 2 Rejected(reason) | 3 Superseded | 4 Resyncing`
 * (docs/plan/28b-reconnect-and-lifecycle.md step 2). `Handshaking`/`Online` keep M16's own `0`/`1`
 * values (`Connecting`/`Live` renamed, not renumbered) so a reader that only ever compared against
 * `1` for "live" is unaffected. `Resyncing` is set the instant a second `Welcome` is detected on an
 * already-`Online` connection (0005 "clients see `Resyncing`, then the reconnect-style full
 * resync") and cleared back to `Online` once that `Welcome` is applied -- the same transition a
 * plain join makes from `Handshaking`, so "proceeds as after a join" (Scope) holds for both. */
export const SessionState = {
  Handshaking: 0,
  Online: 1,
  Rejected: 2,
  Superseded: 3,
  Resyncing: 4,
} as const
export type SessionState = (typeof SessionState)[keyof typeof SessionState]

export type ClockFields = {
  authoritativeTick: number
  predictedTick: number
  ticksPerSecond: number
  sessionState: number
  seqSeed: number
  ackSeq: number
  /** M26 steps 4-6: real from this milestone on (`ClientCore::last_tick_fraction`). */
  tickFraction: number
  /** docs/plan/28-sessions-and-reconnect.md: `0`/`1`, `ClientCore::revealed()`'s own value. */
  revealed: number
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
  /** M26 steps 4-6: the one non-`u32` field here -- a plain `Float32Array` view over the same SAB
   * bytes, same construction shape as every other field. */
  private readonly tickFraction: Float32Array
  /** docs/plan/28-sessions-and-reconnect.md: `ClientCore::revealed()`'s own `u32` (`0`/`1`). */
  private readonly revealed: Uint32Array
  private readonly bytes: Uint8Array
  private readonly scratch: Uint8Array
  /** A view over `scratch`'s own (non-shared) buffer, built once here so a read never allocates a
   * fresh typed-array view (`.claude/rules/hot-paths.md`). `tickFraction`'s own bits ride along in
   * slot 6 as a `u32`-typed copy of the same bytes (a bitwise-exact copy at this granularity, not
   * a numeric conversion) -- `scratchFieldsFloatView` is the reinterpreting view a reader uses to
   * read that one slot back out as the `f32` it actually is. */
  private readonly scratchFields: Uint32Array
  private readonly scratchFieldsFloat: Float32Array

  constructor(sab: SharedArrayBuffer) {
    const base = CLOCK_SEQ_BYTES
    this.seq = new Int32Array(sab, 0, 1)
    this.authoritativeTick = new Uint32Array(sab, base + CLOCK_OFF_AUTHORITATIVE_TICK, 1)
    this.predictedTick = new Uint32Array(sab, base + CLOCK_OFF_PREDICTED_TICK, 1)
    this.ticksPerSecond = new Uint32Array(sab, base + CLOCK_OFF_TICKS_PER_SECOND, 1)
    this.sessionState = new Uint32Array(sab, base + CLOCK_OFF_SESSION_STATE, 1)
    this.seqSeed = new Uint32Array(sab, base + CLOCK_OFF_SEQ_SEED, 1)
    this.ackSeq = new Uint32Array(sab, base + CLOCK_OFF_ACK_SEQ, 1)
    this.tickFraction = new Float32Array(sab, base + CLOCK_OFF_TICK_FRACTION, 1)
    this.revealed = new Uint32Array(sab, base + CLOCK_OFF_REVEALED, 1)
    this.bytes = new Uint8Array(sab, 0, base + CLOCK_FIELDS_BYTES)
    this.scratch = new Uint8Array(base + CLOCK_FIELDS_BYTES)
    this.scratchFields = new Uint32Array(this.scratch.buffer, base, 8)
    this.scratchFieldsFloat = new Float32Array(
      this.scratch.buffer,
      base + CLOCK_OFF_TICK_FRACTION,
      1,
    )
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
  /** M26 steps 4-6: reads `scratchFields`'s own slot 6 back out as the `f32` it actually is (the
   * same underlying bytes `readClockBlockInto` already copied there this call, reinterpreted, not
   * converted) -- call *after* a successful `readClockBlockInto`, never on its own. */
  tickFractionView(): Float32Array {
    return this.tickFraction
  }
  scratchFieldsFloatView(): Float32Array {
    return this.scratchFieldsFloat
  }
  revealedView(): Uint32Array {
    return this.revealed
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
  block.tickFractionView()[0] = f.tickFraction
  block.revealedView()[0] = f.revealed
  Atomics.add(block.seqWord(), 0, 1) // end: even, published
}

/** Reader: copy-with-retry into `out` (caller-owned, built once -- a `Uint32Array(7)`: the first
 * six in `CLOCK_FIELD`'s own order, the seventh the raw bits of `tickFraction`, read back out as
 * a float through `block.scratchFieldsFloatView()` after this call, never through `out` itself --
 * `CLOCK_FIELD` deliberately has no entry for it, so `at(out, ...)` can never return the bits as
 * if they were a plain `u32`). Returns `false`, leaving `out` untouched, only if every retry raced
 * the writer (same shape as `camera/block.ts`'s `readCameraBlockInto`). */
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
/** A little-endian `f32` read from `u8[off..off+4)`, bit-reinterpreted, no `DataView`
 * (`.claude/rules/hot-paths.md`): `client-net.ts`'s own reader for `client_clock_stats`'s widened
 * result (docs/plan/26-prediction-rendering-and-clocks.md steps 4-6, `tick_fraction`). Built once
 * per owner (its own constructor, the same "created at setup" shape every SAB view in this file
 * already uses) and reused on every call; not in `sab/bytes.ts` alongside `readU32LE` because
 * `sab.no_alloc_syntax` (docs/plan/06-sab-primitives-and-workers.md) bans a bare top-level `new`
 * anywhere under `src/sab/**` outside a constructor/`create*` factory, and a scratch `Float32Array`
 * view has nowhere to live there except as exactly that -- this file is outside that scan. */
export class F32Reader {
  private readonly scratch = new Uint8Array(4)
  private readonly view = new Float32Array(this.scratch.buffer)

  read(u8: Uint8Array, off: number): number {
    this.scratch[0] = at(u8, off)
    this.scratch[1] = at(u8, off + 1)
    this.scratch[2] = at(u8, off + 2)
    this.scratch[3] = at(u8, off + 3)
    return at(this.view, 0)
  }
}

export const CLOCK_FIELD = {
  AuthoritativeTick: 0,
  PredictedTick: 1,
  TicksPerSecond: 2,
  SessionState: 3,
  SeqSeed: 4,
  AckSeq: 5,
  // Slot 6 is `tickFraction`'s raw bits (an `f32`, read back through `scratchFieldsFloatView()`,
  // never through `out` as if it were a plain `u32` -- this map deliberately has no entry for it).
  /** docs/plan/28-sessions-and-reconnect.md: `ClientCore::revealed()`, `0`/`1`. */
  Revealed: 7,
} as const
