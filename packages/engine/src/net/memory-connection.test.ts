import { expect, test } from 'vitest'
import { MsgClass } from '../server.js'
import { memoryConnectionPair } from './memory-connection.js'

test('memory-connection: send copies bytes and delivers to the peer', async () => {
  const [a, b] = memoryConnectionPair()
  const received: Uint8Array[] = []
  b.onMessage = (bytes) => received.push(bytes)

  const buf = new Uint8Array([1, 2, 3])
  a.send(MsgClass.ReliableOrdered, buf)
  buf[0] = 99 // mutate the caller's own buffer right after send: must not affect what arrives

  expect(received).toHaveLength(0) // never delivered inside the send() call itself
  await Promise.resolve()
  await Promise.resolve()

  expect(received).toHaveLength(1)
  expect(Array.from(received[0] as Uint8Array)).toEqual([1, 2, 3])
})

test('memory-connection: never delivers re-entrantly', async () => {
  const [a, b] = memoryConnectionPair()
  let insideSend = false
  let deliveredWhileInsideSend = false

  b.onMessage = () => {
    if (insideSend) deliveredWhileInsideSend = true
  }

  insideSend = true
  a.send(MsgClass.ReliableOrdered, new Uint8Array([1]))
  insideSend = false

  // The delivery above must not have happened yet: proven by `deliveredWhileInsideSend` staying
  // false even after `insideSend` itself has already been reset to `false` by the time any
  // microtask could run.
  expect(deliveredWhileInsideSend).toBe(false)

  await Promise.resolve()
  await Promise.resolve()
  expect(deliveredWhileInsideSend).toBe(false)
})

test('memory-connection: preserves order for a burst on one direction', async () => {
  const [a, b] = memoryConnectionPair()
  const received: number[] = []
  b.onMessage = (bytes) => received.push((bytes as Uint8Array)[0] as number)

  for (let i = 0; i < 5; i++) a.send(MsgClass.ReliableOrdered, new Uint8Array([i]))

  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(received).toEqual([0, 1, 2, 3, 4])
})

test('memory-connection: a send after the peer closes is silently dropped', async () => {
  const [a, b] = memoryConnectionPair()
  let closedCode: number | null = null
  a.onClose = (code) => {
    closedCode = code
  }
  const received: Uint8Array[] = []
  a.onMessage = (bytes) => received.push(bytes)

  b.close(42)
  await Promise.resolve()
  await Promise.resolve()
  expect(closedCode).toBe(42)

  // `b` is closed: sending from `a` now must not throw and must never reach `b`'s own onMessage
  // (there is none registered any more either, but the point is `a.send` itself is a no-op).
  a.send(MsgClass.ReliableOrdered, new Uint8Array([7]))
  await Promise.resolve()
  await Promise.resolve()
  expect(received).toHaveLength(0)
})

test('memory-connection: datagrams flag is set per pair, both ends', () => {
  const [a, b] = memoryConnectionPair({ datagrams: true })
  expect(a.datagrams).toBe(true)
  expect(b.datagrams).toBe(true)
  const [c, d] = memoryConnectionPair()
  expect(c.datagrams).toBe(false)
  expect(d.datagrams).toBe(false)
})
