import { expect, test } from 'vitest'
import { RingConnection } from './ring-connection.js'
import { createRing, RingConsumer, RingProducer } from './sab/ring.js'
import { MsgClass } from './server.js'

/** A minimal "client side" of the ring pair, in the same thread (docs/plan/
 * 15b-ring-connection-and-replica-rendering.md step 2: "Vitest with real SAB rings in one
 * thread"): writes `uplink` (what `RingConnection` consumes) and reads `downlink` (what
 * `RingConnection` produces). Real `RingProducer`/`RingConsumer`, no mocks. */
function clientSide(uplink: SharedArrayBuffer, downlink: SharedArrayBuffer) {
  return {
    uplinkOut: new RingProducer(uplink),
    downlinkIn: new RingConsumer(downlink),
  }
}

test('ring_connection_roundtrip', () => {
  const uplink = createRing(64, 8) // 56-byte payload
  const downlink = createRing(64, 8)
  const client = clientSide(uplink, downlink)
  const conn = new RingConnection(uplink, downlink, {
    maxUplinkBytes: 56,
    maxDownlinkBytes: 56,
  })

  // Client -> sim: a real uplink message, drained into `onMessage`.
  const received: number[][] = []
  conn.onMessage = (bytes) => {
    received.push(Array.from(bytes.subarray(0, conn.lastMessageLength)))
  }
  const up = new Uint8Array([1, 2, 3, 4, 5])
  expect(client.uplinkOut.tryPush(up, up.length)).toBe(true)
  conn.drainUplink()
  expect(received).toEqual([[1, 2, 3, 4, 5]])

  // Draining an empty ring calls `onMessage` zero more times.
  conn.drainUplink()
  expect(received.length).toBe(1)

  // Sim -> client: `send` (ReliableOrdered) reaches the client's own downlink consumer.
  const down = new Uint8Array([9, 8, 7])
  conn.send(MsgClass.ReliableOrdered, down)
  const dst = new Uint8Array(56)
  const n = client.downlinkIn.popInto(dst, 0)
  expect(n).toBe(3)
  expect(Array.from(dst.subarray(0, n))).toEqual([9, 8, 7])

  expect(conn.downlinkRetries).toBe(0)
  expect(conn.drops).toBe(0)
})

test('ring_connection_backpressure_retries_not_drops', () => {
  // 4 slots, tiny payload: fills fast, so a handful of sends overflow it.
  const uplink = createRing(32, 4)
  const downlink = createRing(32, 4)
  const client = clientSide(uplink, downlink)
  const conn = new RingConnection(uplink, downlink, {
    maxUplinkBytes: 24,
    maxDownlinkBytes: 24,
    retryDepth: 8,
  })

  // Send 10 one-byte frames back to back, each tagged with its own index, without draining the
  // client's downlink consumer at all: the ring (4 slots) fills after the 4th, and every send
  // past that must be queued (retried), never silently dropped.
  const sent: number[] = []
  for (let i = 0; i < 10; i++) {
    const frame = new Uint8Array([i])
    conn.send(MsgClass.ReliableOrdered, frame)
    sent.push(i)
  }
  expect(conn.downlinkRetries).toBeGreaterThan(0)
  expect(conn.drops).toBe(0) // backpressure, never loss

  // Drain the ring and give the connection's retry queue a chance to flush (`pumpRetries`, what
  // `SimHost.accept` calls every tick regardless of whether that tick built a fresh frame): the
  // ring only holds 4 slots, so this must alternate drain/flush several times before everything
  // queued has actually left the retry queue and landed in the ring.
  const dst = new Uint8Array(24)
  const got: number[] = []
  for (let round = 0; round < 20 && got.length < sent.length; round++) {
    for (;;) {
      const n = client.downlinkIn.popInto(dst, 0)
      if (n < 0) break
      got.push(dst[0] as number)
    }
    conn.pumpRetries()
  }

  expect(got).toEqual(sent) // every frame arrived exactly once, in order
  expect(conn.drops).toBe(0)
})

test('ring_connection_spans_slots', () => {
  // 16-byte payload per slot, 8 slots: a message longer than one slot must span several.
  const uplink = createRing(24, 8) // 16-byte payload
  const downlink = createRing(24, 8)
  const client = clientSide(uplink, downlink)
  const conn = new RingConnection(uplink, downlink, {
    maxUplinkBytes: 100,
    maxDownlinkBytes: 100,
  })

  const big = new Uint8Array(40)
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff

  // Client -> sim, spanning slots.
  expect(client.uplinkOut.tryPush(big, big.length)).toBe(true)
  const received: Uint8Array[] = []
  conn.onMessage = (bytes) => {
    received.push(bytes.slice(0, conn.lastMessageLength))
  }
  conn.drainUplink()
  expect(received.length).toBe(1)
  expect(Array.from(received[0] as Uint8Array)).toEqual(Array.from(big))

  // Sim -> client, spanning slots.
  conn.send(MsgClass.ReliableOrdered, big)
  const dst = new Uint8Array(100)
  const n = client.downlinkIn.popInto(dst, 0)
  expect(n).toBe(big.length)
  expect(Array.from(dst.subarray(0, n))).toEqual(Array.from(big))

  expect(conn.downlinkRetries).toBe(0)
  expect(conn.drops).toBe(0)
})
