// `liveness` (docs/plan/28-sessions-and-reconnect.md, Tests added): `src/net/link.ts`'s own
// dead-timer/probe/backoff state machine. `dead-after-silence`/`stale-socket-ignored`/`probe-on-
// visible`/`backoff-schedule` drive `createLink` directly, over a virtual `ManualClock` (`engine/
// test`'s own `Clock` + `Scheduler`, docs/decisions/0020 §8) with a plain hand-written `Connection`
// double -- no real transport, no real heartbeat, exactly "heartbeats disabled" (Constraints):
// `dead-after-silence` is that scenario, proving the dead timer alone, unaided, does fire.
// `heartbeat-idle-world` is the real end-to-end counterpart: a real `createNetHarness` world with
// nothing happening in it, a real `HeadlessClient` wired onto a real `createLink` (step 4), proving
// the host's own tick-based heartbeat (`Host::build_frame`, `host/mod.rs`) keeps that dead timer
// from ever firing.
import { describe, expect, test } from 'vitest'
import { CloseCode } from '../../src/host/handshake.js'
import {
  BACKOFF_SCHEDULE_MS,
  type Connection,
  createLink,
  DEAD_MS,
  type DownReason,
  type Link,
  LinkState,
  PROBE_DEADLINE_MS,
} from '../../src/net/link.js'
import { createManualClock } from '../../src/test/manual-clock.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

/** A hand-written `Connection` double (0009): `link.ts` only ever sets `onMessage`/`onClose` and
 * reads nothing else off it. `send`/`close` are recorded, never acted on -- this file tests the
 * state machine, not a transport. */
function fakeConnection(): Connection & { closeCalls: number[] } {
  const closeCalls: number[] = []
  return {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send: () => {},
    close: (code) => {
      closeCalls.push(code)
    },
    closeCalls,
  }
}

interface Harness {
  clock: ReturnType<typeof createManualClock>
  link: Link
  dials: (Connection & { closeCalls: number[] })[]
  ups: { conn: Connection; gen: number; atMs: number }[]
  downs: { why: DownReason; atMs: number }[]
}

function makeHarness(seed: number, onUp?: (raw: Connection) => void): Harness {
  const clock = createManualClock()
  const dials: (Connection & { closeCalls: number[] })[] = []
  const ups: { conn: Connection; gen: number; atMs: number }[] = []
  const downs: { why: DownReason; atMs: number }[] = []
  const harness: Harness = { clock, dials, ups, downs, link: undefined as unknown as Link }
  harness.link = createLink({
    dial: () => {
      const c = fakeConnection()
      dials.push(c)
      return c
    },
    clock,
    scheduler: clock,
    seed,
    onUp: (conn, gen) => {
      ups.push({ conn, gen, atMs: clock.now() })
      // `conn` (Deviations, `link.ts`) is a *wrapper*: `link.ts` itself owns `onMessage`/
      // `onClose` on the raw dial (its own dead-timer bookkeeping), so a test simulating "the
      // remote side sent/closed" must fire them on the raw connection this same harness's own
      // `dials` just pushed, not on the wrapper (whose slots are null until a real caller like
      // `HeadlessClient` sets them).
      onUp?.(dials[dials.length - 1] as Connection)
    },
    onDown: (why) => {
      downs.push({ why, atMs: clock.now() })
    },
  })
  return harness
}

describe('liveness', () => {
  test('dead-after-silence', () => {
    const h = makeHarness(1)
    expect(h.dials).toHaveLength(1) // dialed synchronously at construction
    expect(h.link.state).toBe(LinkState.Up)

    h.clock.advance(DEAD_MS - 1)
    expect(h.downs).toHaveLength(0) // not yet -- "dead after 3 s", not before

    h.clock.advance(1)
    expect(h.downs).toHaveLength(1)
    expect(h.downs[0]?.why).toBe('dead')
    // Non-terminal: the schedule's own first entry is 0 ms, so a redial already happened on the
    // same `advance()` call that declared it dead.
    expect(h.dials.length).toBeGreaterThanOrEqual(2)
  })

  test('stale-socket-ignored', () => {
    const h = makeHarness(2)
    const first = h.dials[0]
    if (!first) throw new Error('no first dial')
    expect(h.link.state).toBe(LinkState.Up)

    // The first connection drops (a real close): a redial (backoff step 0 = 0 ms) happens on the
    // next `advance()`.
    first.onClose?.(0)
    expect(h.downs).toHaveLength(1)
    h.clock.advance(1)
    expect(h.dials).toHaveLength(2)
    expect(h.ups).toHaveLength(2)
    const upsBefore = h.ups.length
    const downsBefore = h.downs.length

    // Seams: "Messages and closes from a connection that is no longer current are ignored" --
    // the *first* (now-superseded) connection's own callbacks firing late must change nothing.
    first.onMessage?.(new Uint8Array())
    first.onClose?.(CloseCode.Superseded)
    expect(h.ups).toHaveLength(upsBefore)
    expect(h.downs).toHaveLength(downsBefore)
    expect(h.link.state).toBe(LinkState.Up)
  })

  test('probe-on-visible', () => {
    // Silently dead: no message ever arrives, but well under the 3 s dead timer.
    const dead = makeHarness(3)
    dead.clock.advance(DEAD_MS - PROBE_DEADLINE_MS) // e.g. 2000 ms in: still "up", dead timer
    // has not fired, but this connection has never proven itself with a real message either.
    expect(dead.downs).toHaveLength(0)
    dead.link.probe()
    // `probe()` redials at once (no 3 s wait): a second dial exists immediately, before any
    // further time passes.
    expect(dead.dials).toHaveLength(2)
    expect(dead.ups).toHaveLength(2)

    // Live: a message arrived recently (within the probe-live threshold) -- `probe()` is a no-op.
    const live = makeHarness(3, (conn) => {
      // Prove liveness immediately after every dial, including the very first.
      conn.onMessage?.(new Uint8Array())
    })
    const dialsBefore = live.dials.length
    const upsBefore = live.ups.length
    live.clock.advance(1)
    live.link.probe()
    expect(live.dials).toHaveLength(dialsBefore) // unchanged: "on a live link it changes nothing"
    expect(live.ups).toHaveLength(upsBefore)
    expect(live.link.state).toBe(LinkState.Up)
  })

  test('backoff-schedule', () => {
    // One fixed seed: self-closes on every `onUp` with *no* message in between, so `backoffIndex`
    // never resets and the schedule escalates through every entry. `nextBackoffMs()`'s own
    // jitter (Planning decisions, `link.ts`: "+/- 25%, uniform") makes these literals a real
    // regression pin, not a tautology -- a change to the jitter formula or `BACKOFF_SCHEDULE_MS`
    // moves them, and that is exactly the point of pinning them. `ManualClock.advance(ms)` jumps
    // straight to `now + ms` and fires everything due in one pass (unlike `VirtualClock.advanceTo`,
    // which only steps incrementally around its own conditioner deliveries -- there are none
    // here), so every cascading redial within one big `advance()` call would otherwise read the
    // *same* final `now()`: stepping 1 ms at a time is what makes each entry's own real deadline
    // observable.
    const upTimes: number[] = []
    const h = makeHarness(4242, (conn) => {
      conn.onClose?.(0)
    })
    upTimes.push(h.ups[0]?.atMs as number)
    for (let i = 0; i < BACKOFF_SCHEDULE_MS.length; i++) {
      const targetCount = h.ups.length + 1
      let steps = 0
      while (h.ups.length < targetCount) {
        h.clock.advance(1)
        steps++
        if (steps > 20_000) throw new Error('backoff-schedule: redial did not happen in time')
      }
      upTimes.push(h.ups[h.ups.length - 1]?.atMs as number)
    }

    // Real virtual times, seed 4242 (measured, not computed by the test itself): `advance(1)`'s
    // own granularity is why the 0 ms schedule entry reads back as 1, not 0 (Deviations).
    expect(upTimes).toEqual([0, 1, 438, 1588, 3869, 8398])
  })

  test('heartbeat-idle-world', async () => {
    // M31b R1/R2: hash-all off. A heartbeat carries the hashes due, so it is longer than the
    // header-only 10 bytes this test counts; the heartbeat still flows with hashing on (every other
    // scenario relies on it).
    const harness = await createNetHarness({
      fixture: await putsFixture(),
      seed: 7001,
      clients: 1,
      hashAll: false,
    })
    try {
      const client = harness.clients[0]
      if (!client) throw new Error('heartbeat-idle-world: no client 0')
      client.setCamera(square(0))
      await harness.settle()
      expect(client.status().live).toBe(true)
      expect(client.status().linkUpCount).toBe(1)

      // Deviations: `fx-puts`'s own `tick()` has a once-a-second "walk/day bump" (`puts_
      // scenarios.rs`'s own doc comment) that writes real `Global` state every 20 ticks (1 s at
      // 20 Hz) with *no* client action involved -- well under the 3 s dead timer on its own, so
      // this world is not actually silent enough for `createLink`'s own dead timer to distinguish
      // "heartbeat kept it alive" from "the game's own ambient ticking kept it alive". The precise,
      // walk-bump-independent signature instead: a heartbeat is *exactly* the 10-byte header with
      // no sections (`wire/CLAUDE.md`), strictly smaller than any real section-carrying frame (the
      // walk bump's own `Global` section alone is several bytes on top of that same header) and
      // only ever built when nothing else was due (`Host::build_frame`'s own "nothing to say"
      // gate) -- so a `bytesDown === 10` tick can only be a heartbeat, and one must appear inside
      // any 10-tick (500 ms) idle window this world ever has between real sends.
      await harness.advanceTicks(100)

      expect(client.status().live).toBe(true)
      const heartbeatTicks = harness.counters(0).perTick.filter((row) => row.bytesDown === 10)
      expect(heartbeatTicks.length).toBeGreaterThan(0)
    } finally {
      await harness.dispose()
    }
  })
})
