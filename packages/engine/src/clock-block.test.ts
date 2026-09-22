import { expect, test } from 'vitest'
import {
  CLOCK_FIELD,
  CLOCK_FIELDS_BYTES,
  ClockBlockView,
  readClockBlockInto,
  writeClockBlock,
} from './clock-block.js'
import { CLOCK_BLOCK_DATA_BYTES } from './sab/layout.js'
import { createSeqlock } from './sab/seqlock.js'

test('clock_block: fields fit inside M06 own seqlock allocation', () => {
  expect(CLOCK_FIELDS_BYTES).toBeLessThanOrEqual(CLOCK_BLOCK_DATA_BYTES)
})

test('clock_block: write then read round-trips every field', () => {
  const sab = createSeqlock(CLOCK_BLOCK_DATA_BYTES)
  const writer = new ClockBlockView(sab)
  const reader = new ClockBlockView(sab)
  writeClockBlock(writer, {
    authoritativeTick: 7,
    predictedTick: 7,
    ticksPerSecond: 20,
    sessionState: 1,
    seqSeed: 3,
    ackSeq: 3,
  })
  const out = new Uint32Array(6)
  expect(readClockBlockInto(reader, out)).toBe(true)
  expect(out[CLOCK_FIELD.AuthoritativeTick]).toBe(7)
  expect(out[CLOCK_FIELD.PredictedTick]).toBe(7)
  expect(out[CLOCK_FIELD.TicksPerSecond]).toBe(20)
  expect(out[CLOCK_FIELD.SessionState]).toBe(1)
  expect(out[CLOCK_FIELD.SeqSeed]).toBe(3)
  expect(out[CLOCK_FIELD.AckSeq]).toBe(3)
})

test('clock_block: a read that never sees an even seq word exhausts its retries and reports it', () => {
  // docs/plan/16-action-round-trip.md (gate check): `readClockBlockInto`'s own retry loop
  // (`sab/seqlock.ts`'s `SeqlockReader`/`SeqlockWriter` are a *different* implementation --
  // `clock-block.ts`'s own module doc comment: "hand-rolled shape ... for the same reason" as
  // `camera/block.ts` -- so `seqlock.no_torn_read`'s real cross-worker race does not exercise this
  // file's own loop) had no committed test at all before this one: every existing test here reads
  // only after a write has fully completed, so the `(s1 & 1) === 1` branch never ran. A writer
  // stuck mid-update (the seq word held odd) is the worst case that branch exists for: every
  // attempt sees an odd seq, every attempt retries, and the read must give up and report `false`
  // rather than hand back torn bytes -- `out` is untouched, still whatever it held before the call.
  const sab = createSeqlock(CLOCK_BLOCK_DATA_BYTES)
  const writer = new ClockBlockView(sab)
  const reader = new ClockBlockView(sab)
  writeClockBlock(writer, {
    authoritativeTick: 1,
    predictedTick: 1,
    ticksPerSecond: 20,
    sessionState: 1,
    seqSeed: 0,
    ackSeq: 0,
  })
  // Force the seq word odd, simulating a writer paused between its own `begin`/`end` (a real
  // cross-thread race would see this transiently; here it is held, the worst case).
  Atomics.store(writer.seqWord(), 0, 1)

  const out = new Uint32Array([9, 9, 9, 9, 9, 9]) // sentinel: must survive a failed read untouched
  expect(readClockBlockInto(reader, out)).toBe(false)
  expect(Array.from(out)).toEqual([9, 9, 9, 9, 9, 9])
})

test('clock_block: a second write is what a second read sees', () => {
  const sab = createSeqlock(CLOCK_BLOCK_DATA_BYTES)
  const writer = new ClockBlockView(sab)
  const reader = new ClockBlockView(sab)
  writeClockBlock(writer, {
    authoritativeTick: 1,
    predictedTick: 1,
    ticksPerSecond: 20,
    sessionState: 0,
    seqSeed: 0,
    ackSeq: 0,
  })
  writeClockBlock(writer, {
    authoritativeTick: 9,
    predictedTick: 9,
    ticksPerSecond: 20,
    sessionState: 1,
    seqSeed: 5,
    ackSeq: 8,
  })
  const out = new Uint32Array(6)
  expect(readClockBlockInto(reader, out)).toBe(true)
  expect(out[CLOCK_FIELD.AuthoritativeTick]).toBe(9)
  expect(out[CLOCK_FIELD.AckSeq]).toBe(8)
})
