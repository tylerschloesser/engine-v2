// `byte-pump-backpressure` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Tests added):
// "full ring retries, drops stays 0" -- a downlink ring too small to hold every message at once
// must never drop one (`RingProducer.recordDrop`'s own counter, `RING_DROPS`, shared with the
// consumer side): `createBytePump`'s own `attach`/`drain` retry a not-yet-pushed delivery instead.
import { expect, test } from 'vitest'
import { createRing, RingConsumer, RingProducer, type RingStats } from '../sab/ring.js'
import type { Connection } from '../server.js'
import { createBytePump } from './pump.js'

test('byte-pump-backpressure: full ring retries, drops stays 0', () => {
  const uplink = createRing(64, 4)
  // Only 2 slots: fewer than the 5 messages below, so backpressure is real, not incidental.
  const downlink = createRing(64, 2)
  const pump = createBytePump({ uplink, downlink })

  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: () => {},
    close: () => {},
  }
  pump.attach(conn)

  for (let i = 0; i < 5; i++) {
    conn.onMessage?.(new Uint8Array([i]))
  }

  const reader = new RingConsumer(downlink)
  const dst = new Uint8Array(64)
  const received: number[] = []

  // Drain what fits, let the pump retry the rest, repeat -- a real consumer's own per-wake poll.
  for (let round = 0; round < 5; round++) {
    for (;;) {
      const len = reader.popInto(dst, 0)
      if (len < 0) break
      received.push(dst[0] as number)
    }
    pump.drain()
  }

  const stats: RingStats = { drops: 0, pushed: 0, popped: 0 }
  reader.stats(stats)
  expect(received).toEqual([0, 1, 2, 3, 4])
  expect(stats.drops).toBe(0)
  expect(stats.popped).toBe(5)
})

test('byte-pump-backpressure: drain() forwards queued uplink bytes to the connection', () => {
  const uplink = createRing(64, 4)
  const downlink = createRing(64, 4)
  const pump = createBytePump({ uplink, downlink })

  const sent: Uint8Array[] = []
  const conn: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: (_cls, bytes) => sent.push(bytes.slice()),
    close: () => {},
  }
  pump.attach(conn)

  const up = new RingProducer(uplink)
  up.tryPush(new Uint8Array([9, 9]), 2)
  pump.drain()

  expect(sent.length).toBe(1)
  expect(Array.from(sent[0] as Uint8Array)).toEqual([9, 9])
})
