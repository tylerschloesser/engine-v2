// `latest-wins-datagrams` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Tests added;
// Planning decisions: "one scenario runs a datagrams: true memory pair with latest-wins drops").
// `conditioner.test.ts`'s own unit test (`src/net/conditioner.test.ts`, M27 steps 1-2) already
// proves the primitive at the TS-unit level; this scenario is the `netcode` suite's own named
// coverage of the same wire-level rule (0009: "on a transport without datagrams the engine packs
// both classes into one packet"; 0020 §7: "message drops apply only to latest-wins traffic on a
// datagram adapter") through the exported harness building blocks (`memoryConnectionPair`,
// `conditionLink`, `createVirtualClock`), independent of `createNetHarness`/`HeadlessClient` (no
// production code ever sends `MsgClass.LatestWins` yet -- Deviations: not reachable through a real
// game's own uplink/downlink today).
import { expect, test } from 'vitest'
import { MsgClass } from '../../src/server.js'
import { conditionLink, createVirtualClock, memoryConnectionPair } from '../../src/test.js'

test('latest-wins-datagrams: a stall draw on a datagram link drops the message outright', async () => {
  const clock = createVirtualClock()
  const [a, b] = memoryConnectionPair({ datagrams: true })
  // `stall.p = 1`: every draw stalls -- on a datagram link this always drops (`conditioner.ts`'s
  // own `draw()`: `isDatagramLatestWins` returns `null` instead of stalling).
  const link = conditionLink(
    a,
    b,
    { seed: 3001, latencyMs: 5, jitterMs: 0, stall: { p: 1, rtoMs: 50 } },
    clock,
  )

  let received = 0
  link.ends[1].onMessage = () => {
    received++
  }
  link.ends[0].send(MsgClass.LatestWins, new Uint8Array([9]))
  await clock.advanceBy(1000)

  expect(received).toBe(0)
})

test('latest-wins-datagrams: the same traffic, reliable-ordered, stalls instead of dropping', async () => {
  const clock = createVirtualClock()
  const [a, b] = memoryConnectionPair({ datagrams: true })
  const link = conditionLink(
    a,
    b,
    { seed: 3002, latencyMs: 5, jitterMs: 0, stall: { p: 1, rtoMs: 50 } },
    clock,
  )

  let received = 0
  link.ends[1].onMessage = () => {
    received++
  }
  link.ends[0].send(MsgClass.ReliableOrdered, new Uint8Array([9]))
  await clock.advanceBy(1000)

  // Delayed by the stall's own rtoMs, never dropped.
  expect(received).toBe(1)
})
