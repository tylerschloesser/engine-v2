// `liveness` (docs/plan/28-sessions-and-reconnect.md, Tests added): `src/net/link.ts`'s own
// dead-timer/probe/backoff state machine, driven entirely by a virtual `ManualClock` (`engine/
// test`'s own `Clock` + `Scheduler`, docs/decisions/0020 §8) -- no real time, no real transport
// (`Connection` is a plain hand-written double here; `link.ts` never parses its bytes). `heartbeat-
// idle-world` (the host actually sending an empty frame every 500 ms with nothing else to say) is
// not covered here: it needs a host-side heartbeat feature this milestone's own step 4 has not
// built yet (see this milestone's Deviations).
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

function makeHarness(seed: number, onUp?: (conn: Connection) => void): Harness {
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
      onUp?.(conn)
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
})
