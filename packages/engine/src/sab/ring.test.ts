import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'
import { createRing, RingConsumer, RingProducer, type RingStats } from './ring.js'

test('ring.spsc_sequence', async () => {
  const slotBytes = 64
  const slots = 64
  const count = 200_000
  const sab = createRing(slotBytes, slots)
  const payloadBytes = slotBytes - 8
  const consumer = new RingConsumer(sab)
  const worker = new Worker(new URL('../test/sab-ring-worker.mjs', import.meta.url), {
    workerData: { sab, count, payloadBytes },
  })
  let workerError: unknown

  const dst = new Uint8Array(payloadBytes * 5)
  let expectedSeq = 0
  let popped = 0
  let seqErrors = 0
  // A deadline backstop, not a pacing mechanism: this loop is meant to spin as fast as possible
  // (an empty ring is `continue`d immediately), so an iteration count is not a useful bound -- an
  // idle spin can run hundreds of millions of iterations in well under a second. Checked against
  // `process.hrtime.bigint()` (a duration, not one of `packages/engine/src/**`'s banned ambient-
  // time globals) so a genuine stall (the producer worker never running at all) fails with this
  // file's own message inside this test's 15s Vitest timeout, instead of Vitest's generic one.
  const deadlineNs = 12_000_000_000n
  const loopStart = process.hrtime.bigint()
  while (popped < count) {
    if (process.hrtime.bigint() - loopStart > deadlineNs) {
      throw new Error(
        `ring.spsc_sequence: consumer made no progress (popped=${popped}/${count}) within ${deadlineNs}ns`,
      )
    }
    if (workerError) throw workerError
    const len = consumer.popInto(dst, 0)
    if (len < 0) continue
    const seq =
      (dst[0] as number) |
      ((dst[1] as number) << 8) |
      ((dst[2] as number) << 16) |
      ((dst[3] as number) << 24)
    if (seq !== expectedSeq) seqErrors++
    for (let b = 4; b < len; b++) {
      if (dst[b] !== ((seq + b) & 0xff)) seqErrors++
    }
    expectedSeq = seq + 1
    popped++
  }

  await new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve())
    worker.once('error', (e) => {
      workerError = e
      reject(e)
    })
  })

  const stats: RingStats = { drops: -1, pushed: -1, popped: -1 }
  consumer.stats(stats)
  expect(seqErrors).toBe(0)
  expect(stats.drops).toBe(0)
  expect(stats.pushed).toBe(count)
  expect(stats.popped).toBe(count)
}, 15_000)

test('ring.full_is_backpressure', () => {
  const sab = createRing(32, 4) // 24-byte payload, 4 slots: fills fast
  const producer = new RingProducer(sab)
  const consumer = new RingConsumer(sab)
  const stats: RingStats = { drops: -1, pushed: -1, popped: -1 }

  // Fill the ring exactly, then overflow it.
  for (let i = 0; i < 4; i++) expect(producer.tryPush(new Uint8Array([i]), 1)).toBe(true)
  expect(producer.tryPush(new Uint8Array([9]), 1)).toBe(false)
  producer.stats(stats)
  expect(stats.drops).toBe(0) // backpressure, not loss: nothing was silently discarded

  // Draining one slot makes room for exactly one more push; nothing already written was lost.
  const dst = new Uint8Array(1)
  expect(consumer.popInto(dst, 0)).toBe(1)
  expect(dst[0]).toBe(0)
  expect(producer.tryPush(new Uint8Array([9]), 1)).toBe(true)
  expect(producer.tryPush(new Uint8Array([10]), 1)).toBe(false)

  const expected = [1, 2, 3, 9]
  for (const want of expected) {
    expect(consumer.popInto(dst, 0)).toBe(1)
    expect(dst[0]).toBe(want)
  }
  producer.stats(stats)
  expect(stats.drops).toBe(0)
})

test('ring.fixed_records', () => {
  const recordBytes = 12 // 20-byte slot: 8-byte header + 12-byte fixed record
  const sab = createRing(20, 8)
  const producer = new RingProducer(sab)
  const consumer = new RingConsumer(sab)

  for (let i = 0; i < 8; i++) {
    const idx = producer.tryClaim()
    expect(idx).toBeGreaterThanOrEqual(0)
    const view = producer.slotView(idx)
    for (let b = 0; b < recordBytes; b++) view[b] = (i * 3 + b) & 0xff
    producer.commit()
  }
  expect(producer.tryClaim()).toBe(-1) // full: nothing consumed yet

  for (let i = 0; i < 8; i++) {
    const idx = consumer.peek()
    expect(idx).toBeGreaterThanOrEqual(0)
    const view = consumer.slotView(idx)
    for (let b = 0; b < recordBytes; b++) expect(view[b]).toBe((i * 3 + b) & 0xff)
    consumer.release()
  }
  expect(consumer.peek()).toBe(-1)

  const stats: RingStats = { drops: -1, pushed: -1, popped: -1 }
  consumer.stats(stats)
  expect(stats).toEqual({ drops: 0, pushed: 8, popped: 8 })
})

test('ring.wrap_and_span', () => {
  // A 3-slot ring with 24-byte payloads: repeated push/pop forces HEAD/TAIL wraparound, and a
  // 2-slot message pushed near the end wraps physically from the last slot back to slot 0.
  const payloadBytes = 24
  const sab = createRing(payloadBytes + 8, 3)
  const producer = new RingProducer(sab)
  const consumer = new RingConsumer(sab)
  const dst = new Uint8Array(payloadBytes * 2)

  // Cycle single-slot messages several times so HEAD/TAIL pass well beyond `slots`.
  for (let round = 0; round < 5; round++) {
    const msg = new Uint8Array([round, 1, 2, 3])
    expect(producer.tryPush(msg, msg.length)).toBe(true)
    expect(consumer.popInto(dst, 0)).toBe(msg.length)
    expect(Array.from(dst.subarray(0, msg.length))).toEqual(Array.from(msg))
  }

  // Now push a 2-slot (spanning) message: with HEAD at an odd offset into the physical ring, this
  // wraps from the last physical slot back to slot 0.
  const big = new Uint8Array(payloadBytes + 5)
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff
  expect(producer.tryPush(big, big.length)).toBe(true)
  const len = consumer.popInto(dst, 0)
  expect(len).toBe(big.length)
  expect(Array.from(dst.subarray(0, len))).toEqual(Array.from(big))

  const stats: RingStats = { drops: -1, pushed: -1, popped: -1 }
  consumer.stats(stats)
  expect(stats.drops).toBe(0)
  expect(stats.pushed).toBe(6)
  expect(stats.popped).toBe(6)
})

test('ring.consumer_record_drop_shares_the_producers_counter', () => {
  // docs/plan/16-action-round-trip.md (gate item 3): `RingConsumer.recordDrop()` is the consumer
  // side of the same policy `RingProducer.recordDrop()` already has -- a message this ring
  // delivered, but whose consumer rejected on its own terms after popping it, is still counted as
  // a drop. Both sides share one `RING_DROPS` counter (the same physical control block), so a
  // producer's own drop and a consumer's own drop are indistinguishable to `stats()`, by design.
  const sab = createRing(20, 8)
  const producer = new RingProducer(sab)
  const consumer = new RingConsumer(sab)
  const msg = new Uint8Array([1, 2, 3])
  const dst = new Uint8Array(12)

  expect(producer.tryPush(msg, msg.length)).toBe(true)
  expect(consumer.popInto(dst, 0)).toBe(msg.length) // popped fine; the consumer rejects it itself
  consumer.recordDrop()

  const fromConsumer: RingStats = { drops: -1, pushed: -1, popped: -1 }
  consumer.stats(fromConsumer)
  expect(fromConsumer).toEqual({ drops: 1, pushed: 1, popped: 1 })

  const fromProducer: RingStats = { drops: -1, pushed: -1, popped: -1 }
  producer.stats(fromProducer)
  expect(fromProducer).toEqual({ drops: 1, pushed: 1, popped: 1 }) // same counter, either view

  consumer.recordDrop()
  consumer.recordDrop()
  producer.stats(fromProducer)
  expect(fromProducer.drops).toBe(3)
})
