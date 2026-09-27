import { expect, test } from 'vitest'
import { MsgClass } from '../server.js'
import { createVirtualClock } from '../test/virtual-clock.js'
import { conditionLink } from './conditioner.js'
import { memoryConnectionPair } from './memory-connection.js'

interface Received {
  byte: number
  at: number
}

function setupLink(seed: number, latencyMs: number, jitterMs: number) {
  const clock = createVirtualClock()
  const [a, b] = memoryConnectionPair()
  const link = conditionLink(a, b, { seed, latencyMs, jitterMs }, clock)
  const [endA, endB] = link.ends
  const received: Received[] = []
  endB.onMessage = (bytes) =>
    received.push({ byte: (bytes as Uint8Array)[0] as number, at: clock.now() })
  return { clock, endA, endB, link, received }
}

/**
 * Pinned for seed 1 / latencyMs 10 / jitterMs 5 (computed once from the checked-in PRNG, `node -e`
 * against `makeRng`): three messages sent at virtual time 0 draw jitter `[0, 0, 3]`, and "order
 * preserved" (0020 §7) floors the second message's own draw at the first's `deliverAt` (both land
 * at 10) -- `(deliverAt, link, seq)` then orders them `[0, 1]` at t=10 before `[2]` at t=13.
 */
test('conditioner: same seed gives an identical release order and timing, twice', async () => {
  const run = async () => {
    const { clock, endA, received } = setupLink(1, 10, 5)
    endA.send(MsgClass.ReliableOrdered, new Uint8Array([0]))
    endA.send(MsgClass.ReliableOrdered, new Uint8Array([1]))
    endA.send(MsgClass.ReliableOrdered, new Uint8Array([2]))
    await clock.advanceTo(20)
    return received
  }

  const first = await run()
  const second = await run()

  const expected: Received[] = [
    { byte: 0, at: 10 },
    { byte: 1, at: 10 },
    { byte: 2, at: 13 },
  ]
  expect(first).toEqual(expected)
  expect(second).toEqual(expected)
})

test('conditioner: a different seed gives a different release order or timing', async () => {
  const run = async (seed: number) => {
    const { clock, endA, received } = setupLink(seed, 10, 5)
    for (let i = 0; i < 6; i++) endA.send(MsgClass.ReliableOrdered, new Uint8Array([i]))
    await clock.advanceTo(50)
    return received
  }

  const withSeed1 = await run(1)
  const withSeed2 = await run(2)

  expect(withSeed1).not.toEqual(withSeed2)
})

test('conditioner: latency and jitter delay delivery, never deliver early', async () => {
  const { clock, endA, received } = setupLink(7, 20, 10)
  endA.send(MsgClass.ReliableOrdered, new Uint8Array([1]))
  await clock.advanceTo(19)
  expect(received).toHaveLength(0) // below the minimum possible deliverAt (latency alone)
  await clock.advanceTo(40)
  expect(received).toHaveLength(1)
  expect(received[0]?.at).toBeGreaterThanOrEqual(20)
  expect(received[0]?.at).toBeLessThanOrEqual(30)
})

test('conditioner: order is preserved on one direction even when a later draw would be earlier', async () => {
  const { clock, endA, received } = setupLink(3, 5, 50)
  // Enough sends that at least one later jitter draw is smaller than an earlier one -- if the
  // conditioner ever let deliverAt run backward relative to send order, this would show up as a
  // received-order mismatch against the send order below.
  for (let i = 0; i < 8; i++) endA.send(MsgClass.ReliableOrdered, new Uint8Array([i]))
  await clock.advanceTo(1000)
  expect(received.map((r) => r.byte)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  // Monotonic deliverAt too, not merely monotonic seq (the actual "order preserved" guarantee).
  for (let i = 1; i < received.length; i++) {
    expect((received[i] as Received).at).toBeGreaterThanOrEqual((received[i - 1] as Received).at)
  }
})

test('conditioner: a forced stall delays delivery on both directions', async () => {
  const { clock, endA, endB, link, received } = setupLink(4, 5, 0)
  const receivedAtA: Received[] = []
  endA.onMessage = (bytes) =>
    receivedAtA.push({ byte: (bytes as Uint8Array)[0] as number, at: clock.now() })

  link.stall(30)
  endA.send(MsgClass.ReliableOrdered, new Uint8Array([1])) // a->b: ordinary deliverAt is 5, stalled to 30
  endB.send(MsgClass.ReliableOrdered, new Uint8Array([2])) // b->a: same

  await clock.advanceTo(29)
  expect(received).toHaveLength(0)
  expect(receivedAtA).toHaveLength(0)

  await clock.advanceTo(31)
  expect(received).toHaveLength(1)
  expect(received[0]?.at).toBe(30)
  expect(receivedAtA).toHaveLength(1)
  expect(receivedAtA[0]?.at).toBe(30)
})

test('conditioner: set() changes future draws, not already-scheduled ones', async () => {
  const { clock, endA, link, received } = setupLink(9, 10, 0)
  endA.send(MsgClass.ReliableOrdered, new Uint8Array([1])) // deliverAt 10, under the original latency
  link.set({ latencyMs: 100 })
  endA.send(MsgClass.ReliableOrdered, new Uint8Array([2])) // deliverAt 100, under the new latency

  await clock.advanceTo(10)
  expect(received.map((r) => r.byte)).toEqual([1]) // the first send's own draw is untouched by set()

  await clock.advanceTo(100)
  expect(received.map((r) => r.byte)).toEqual([1, 2])
})

test('conditioner: disconnect fires onClose on both ends and drops pending deliveries', async () => {
  const clock = createVirtualClock()
  const [a, b] = memoryConnectionPair()
  const link = conditionLink(a, b, { seed: 5, latencyMs: 100, jitterMs: 0 }, clock)
  const [endA, endB] = link.ends
  let closedA: number | null = null
  let closedB: number | null = null
  endA.onClose = (code) => {
    closedA = code
  }
  endB.onClose = (code) => {
    closedB = code
  }
  const received: Uint8Array[] = []
  endB.onMessage = (bytes) => received.push(bytes)

  endA.send(MsgClass.ReliableOrdered, new Uint8Array([1])) // scheduled for t=100
  link.disconnect(13)
  await clock.advanceTo(200)

  expect(closedA).toBe(13)
  expect(closedB).toBe(13)
  expect(received).toHaveLength(0) // the pending delivery above was never released
})

test('conditioner: latest-wins traffic on a datagram link can be dropped outright', async () => {
  const clock = createVirtualClock()
  const [a, b] = memoryConnectionPair({ datagrams: true })
  // p: 1 forces every draw to hit the loss branch.
  const link = conditionLink(
    a,
    b,
    { seed: 1, latencyMs: 5, jitterMs: 0, stall: { p: 1, rtoMs: 50 } },
    clock,
  )
  const [endA, endB] = link.ends
  const received: Uint8Array[] = []
  endB.onMessage = (bytes) => received.push(bytes)

  endA.send(MsgClass.LatestWins, new Uint8Array([1]))
  await clock.advanceTo(1000)
  expect(received).toHaveLength(0) // dropped, never merely delayed
})

test('conditioner: the same loss draw stalls (does not drop) reliable-ordered traffic', async () => {
  const clock = createVirtualClock()
  const [a, b] = memoryConnectionPair({ datagrams: true })
  const link = conditionLink(
    a,
    b,
    { seed: 1, latencyMs: 5, jitterMs: 0, stall: { p: 1, rtoMs: 50 } },
    clock,
  )
  const [endA, endB] = link.ends
  const received: Uint8Array[] = []
  endB.onMessage = (bytes) => received.push(bytes)

  endA.send(MsgClass.ReliableOrdered, new Uint8Array([1]))
  await clock.advanceTo(1000)
  expect(received).toHaveLength(1) // delayed by the stall, but still delivered
})
