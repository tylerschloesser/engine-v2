// `conditionLink` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Seams; docs/decisions/
// 0020-testing-strategy.md §7 "A conditioner wraps any Connection"): per link, one seeded PRNG
// draws `deliverAt = now + latency + jitter`; loss is "what TCP turns it into" -- order-preserving
// (never reordered ahead of an already-scheduled message on the same direction, matching real
// stream semantics), a head-of-line stall for a drawn RTO, or a scripted `disconnect`; "message
// drops apply only to `latest-wins` traffic on a datagram adapter" (0020 §7) -- everywhere else the
// same drawn loss event becomes a stall instead of an actual drop. No ambient randomness
// (`packages/engine/src/CLAUDE.md`: "No ambient randomness in `src/` outside `src/test/`", and this
// file is `src/net/`, not `src/test/`; `no-ambient-random.test.ts` greps for the banned globals
// literally, so this file must never even name one in a comment): the PRNG is owned, seeded,
// integer code, the same reasoning the determinism rule gives for sim/worldgen code, applied here
// to a *test's* own randomness.
import { type Connection, MsgClass } from '../server.js'
import type { VirtualClock } from '../test/virtual-clock.js'

type ConnectionSend = Connection['send']

/** xorshift32, seeded: deterministic, integer-only, never the banned ambient global (above).
 * Returns a function producing values in `[0, 1)`, one call per draw -- the same shape the ambient
 * global's own no-argument call has, so the arithmetic below reads the same either way. */
function makeRng(seed: number): () => number {
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    // `>>> 0`: unsigned, so the division below is never negative.
    return (state >>> 0) / 4294967296
  }
}

export interface StallOptions {
  /** Probability (0-1) that a given message triggers a head-of-line stall (or, for `latest-wins`
   * traffic on a datagram adapter, an outright drop) instead of an ordinary latency/jitter-only
   * delivery. */
  p: number
  /** How long the stall holds a direction, once triggered (ms, virtual time): every message
   * already queued behind it, and every message sent while it holds, is delayed by at least this
   * much beyond its own ordinary draw (0020 §7: "a head-of-line stall for a drawn RTO with order
   * preserved"). */
  rtoMs: number
}

export interface ConditionerConditions {
  latencyMs: number
  jitterMs: number
  stall?: StallOptions
}

export interface ConditionerOptions extends ConditionerConditions {
  seed: number
}

export interface ConditionedLink {
  /** The two conditioned `Connection`s a caller hands to `SimHost.accept`/a `HeadlessClient`, in
   * place of the raw pair passed to `conditionLink` itself. */
  ends: [Connection, Connection]
  /** Changes `latencyMs`/`jitterMs`/`stall` for every message drawn from here on (both
   * directions); already-scheduled deliveries are unaffected. */
  set(conditions: Partial<ConditionerConditions>): void
  /** Forces a head-of-line stall of `ms` on both directions starting now, independent of the
   * seeded `stall` draw -- a scripted disruption, not a random one. */
  stall(ms: number): void
  /** Ends the link: both ends' `onClose` fire (`code ?? 0`), and every not-yet-released pending
   * delivery on either direction is dropped, never delivered late. */
  disconnect(code?: number): void
}

interface DirectionState {
  rng: () => number
  seq: number
  /** Virtual time before which every draw on this direction is pushed back (0020 §7's own "order
   * preserved": a real stream never lets a later-sent message overtake an earlier one still in
   * flight, so each new draw is floored at the previous message's own `deliverAt`). */
  floorAt: number
  /** Set by a stall (seeded or forced): every draw before this virtual time is pushed back to it,
   * same mechanism as `floorAt`, cleared naturally once virtual time passes it (nothing un-sets it
   * early: a stall holds for its full `rtoMs`). */
  stalledUntil: number
}

/** `null` return means "drop this message outright" (datagram + `latest-wins` loss, above);
 * otherwise the virtual time it should be released at. */
function draw(
  dir: DirectionState,
  now: number,
  cond: ConditionerConditions,
  isDatagramLatestWins: boolean,
): number | null {
  const jitter = cond.jitterMs > 0 ? Math.floor(dir.rng() * (cond.jitterMs + 1)) : 0
  let deliverAt = now + cond.latencyMs + jitter
  if (cond.stall && dir.rng() < cond.stall.p) {
    if (isDatagramLatestWins) return null
    dir.stalledUntil = Math.max(dir.stalledUntil, now + cond.stall.rtoMs)
  }
  if (dir.stalledUntil > deliverAt) deliverAt = dir.stalledUntil
  if (dir.floorAt > deliverAt) deliverAt = dir.floorAt
  dir.floorAt = deliverAt
  return deliverAt
}

function makeSend(
  underlying: Connection,
  dir: DirectionState,
  link: number,
  clock: VirtualClock,
  getConditions: () => ConditionerConditions,
  disconnected: { value: boolean },
): ConnectionSend {
  return (cls, bytes) => {
    if (disconnected.value) return
    // "engine-owned buffer, valid only during the call" (0009): copy now, released later from
    // `advanceTo`'s own deferred pass.
    const copy = bytes.slice()
    const cond = getConditions()
    const isDatagramLatestWins = underlying.datagrams && cls === MsgClass.LatestWins
    const deliverAt = draw(dir, clock.now(), cond, isDatagramLatestWins)
    if (deliverAt === null) return // dropped: never scheduled, never delivered
    const seq = dir.seq++
    clock.scheduleDelivery({
      deliverAt,
      link,
      seq,
      // A promise, not a bare call: `VirtualClock.advanceTo`'s own doc comment ("awaits physical
      // arrival") needs a point *after* the underlying connection's own delivery has actually run --
      // for `memoryConnectionPair` that delivery is one microtask away from `send()` returning
      // (`memory-connection.ts`'s own `scheduleDrain`), scheduled strictly before this resolution's
      // own microtask (both `queueMicrotask` calls, FIFO order, this one queued second). A future
      // real `ws` end (M29) resolves this the same way once its own bytes are actually on the wire.
      run: () =>
        new Promise<void>((resolve) => {
          if (disconnected.value) {
            resolve()
            return
          }
          underlying.send(cls, copy)
          queueMicrotask(resolve)
        }),
    })
  }
}

/**
 * `conditionLink(a, b, opts, clock)` (Seams): wraps a real `Connection` pair -- `memoryConnectionPair`
 * now, a real `ws` pair in M29 (0009: "Wraps any `Connection` pair"). Returns a *new* pair
 * (`ends`) a caller treats exactly like an unconditioned one: sending on `ends[0]` draws this
 * link's own delay/loss before the underlying `a.send()` ever runs, and `ends[1].onMessage` only
 * ever fires once that draw's own `deliverAt` has been released by a `VirtualClock.advanceTo`/
 * `advanceBy` call on `clock`. `a`/`b` are taken over completely: their own `onMessage`/`onClose`
 * are set here and must not be touched by the caller afterward.
 */
export function conditionLink(
  a: Connection,
  b: Connection,
  opts: ConditionerOptions,
  clock: VirtualClock,
): ConditionedLink {
  const link = clock.nextLinkId()
  let cond: ConditionerConditions = {
    latencyMs: opts.latencyMs,
    jitterMs: opts.jitterMs,
    ...(opts.stall !== undefined ? { stall: opts.stall } : {}),
  }
  const disconnected = { value: false }

  // Two independent PRNG streams, one per direction, both derived from the one seed but never
  // sharing draws (`makeRng(seed)` for endA -> b, `makeRng(seed + 1)` for endB -> a): otherwise the
  // two directions would draw identical jitter/loss sequences whenever their message counts line
  // up, which is not "one seeded PRNG" per link direction read as two independent streams.
  const dirAtoB: DirectionState = { rng: makeRng(opts.seed), seq: 0, floorAt: 0, stalledUntil: 0 }
  const dirBtoA: DirectionState = {
    rng: makeRng(opts.seed + 1),
    seq: 0,
    floorAt: 0,
    stalledUntil: 0,
  }

  const endA: Connection = {
    datagrams: a.datagrams,
    onMessage: null,
    onClose: null,
    send: makeSend(a, dirAtoB, link, clock, () => cond, disconnected),
    close(code) {
      if (disconnected.value) return
      disconnected.value = true
      a.close(code)
    },
  }
  const endB: Connection = {
    datagrams: b.datagrams,
    onMessage: null,
    onClose: null,
    send: makeSend(b, dirBtoA, link, clock, () => cond, disconnected),
    close(code) {
      if (disconnected.value) return
      disconnected.value = true
      b.close(code)
    },
  }
  // The underlying pair's own delivery is already the conditioned message (conditioning happens on
  // the *send* side, above, before `a.send`/`b.send` is ever called) -- a straight, immediate
  // passthrough to the public end's own callback, no further delay here.
  a.onMessage = (bytes) => {
    endA.onMessage?.(bytes)
  }
  b.onMessage = (bytes) => {
    endB.onMessage?.(bytes)
  }
  a.onClose = (code) => {
    disconnected.value = true
    endA.onClose?.(code)
  }
  b.onClose = (code) => {
    disconnected.value = true
    endB.onClose?.(code)
  }

  return {
    ends: [endA, endB],
    set(conditions) {
      cond = { ...cond, ...conditions }
    },
    stall(ms) {
      const until = clock.now() + ms
      dirAtoB.stalledUntil = Math.max(dirAtoB.stalledUntil, until)
      dirBtoA.stalledUntil = Math.max(dirBtoA.stalledUntil, until)
    },
    disconnect(code) {
      if (disconnected.value) return
      disconnected.value = true
      const c = code ?? 0
      // Nulled first: `a`/`b`'s own `onClose` (wired above) would otherwise also fire `endA`/
      // `endB`'s callback through the underlying pair's peer-notify cascade (`memory-connection.ts`
      // `close()`'s own doc comment), double-firing whichever one that cascade reaches.
      a.onClose = null
      b.onClose = null
      a.close(c)
      b.close(c)
      endA.onClose?.(c)
      endB.onClose?.(c)
    },
  }
}
