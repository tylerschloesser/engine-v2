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
