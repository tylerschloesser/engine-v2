// `createLink` (docs/plan/28-sessions-and-reconnect.md Scope/Seams; docs/decisions/
// 0013-sessions-and-integrity.md "Client policy"): the one dead-timer/probe/backoff state machine
// a client side keeps over a `Connection` (0009) -- pure TS over an injected `Clock`/`Scheduler`
// (`../clock.js`, docs/decisions/0020 §8), so it is exactly as testable under a virtual clock as
// `conditionLink` already is, and so `src/net/` (outside `src/test/`) still names no ambient timer
// or randomness (`packages/engine/src/CLAUDE.md`). Used by `HeadlessClient` (M28) and the net
// worker (M29); neither owns dead-timer/probe/backoff logic of its own.
//
// 0013 Client policy, verbatim: "Dead after 3 s without a frame (heartbeats arrive every 500 ms)
// or on `close`. On `visibilitychange -> visible` or `online`, probe at once with a 1 s deadline.
// Backoff 0, 0.5, 1, 2, 5 s (cap), jittered; the new socket opens before the old one is
// discarded." This file owns exactly that: it does not parse frames (a `Connection.onMessage`
// call of any shape counts as "a frame" for the dead timer -- the byte content is M29's problem,
// same "close code, not the message body" spirit as `host/handshake.ts`'s own `CloseCode` doc
// comment) and does not listen for `visibilitychange`/`online` itself (DOM events belong to
// whatever page owns `window`, M29) -- the caller calls `probe()`.
import type { Clock, Scheduler } from '../clock.js'
import { CloseCode } from '../host/handshake.js'
import type { Connection, MsgClass } from '../server.js'

/** 0013 Client policy: "Dead after 3 s without a frame". */
export const DEAD_MS = 3000
/** 0013 Client policy: "probe at once with a 1 s deadline". */
export const PROBE_DEADLINE_MS = 1000
/** 0013 Client policy: "Backoff 0, 0.5, 1, 2, 5 s (cap)", milliseconds, in order; the last entry
 * repeats once the schedule is exhausted ("cap"). */
export const BACKOFF_SCHEDULE_MS = [0, 500, 1000, 2000, 5000]
/** Jitter half-width, as a fraction of the scheduled delay (Planning decisions, this file: "+/-
 * 25%, uniform" is not named by 0013 -- a reasonable reading of "jittered", pinned by
 * `backoff-schedule`'s own literals so a later change is a deliberate, reviewed one). `0` stays
 * `0` (no jitter on the immediate first attempt). */
const JITTER_FRACTION = 0.25
/** How recently a message must have arrived for `probe()` to treat the link as genuinely live
 * (Planning decisions: reusing the probe deadline itself as "recent enough" -- a link that has
 * heard nothing for at least as long as a fresh probe is willing to wait is exactly the case
 * `probe-on-visible` describes as "silently dead", not live). */
const PROBE_LIVE_THRESHOLD_MS = PROBE_DEADLINE_MS

export const LinkState = {
  /** No confirmed-current connection yet, or the current one is presumed dead; a (re)dial is
   * scheduled or in flight. */
  Down: 0,
  /** A dialed connection is current; `onUp` has fired for it. */
  Up: 1,
  /** `stop()` was called: no timer is armed, no further dial ever happens. */
  Stopped: 2,
} as const
export type LinkState = (typeof LinkState)[keyof typeof LinkState]

/** Why `onDown` fired (Seams: "stops for good on `Superseded`, `BadKey`, `Full`, and reports
 * `VersionMismatch` without retrying by itself"). `'dead'`/`'close'` are ordinary transient
 * reasons a link keeps retrying through; the four `CloseCode` reasons map 1:1 to 0013's own
 * three-plus-one list (`ProtocolError` is treated as transient -- Seams names only the other
 * four as special, and a protocol error closing a *live, already-attached* connection is exactly
 * the kind of hiccup backoff exists for). */
export type DownReason = 'dead' | 'close' | 'superseded' | 'bad-key' | 'full' | 'version-mismatch'

const TERMINAL_REASONS: ReadonlySet<DownReason> = new Set<DownReason>([
  'superseded',
  'bad-key',
  'full',
  'version-mismatch',
])

function closeCodeReason(code: number): DownReason {
  switch (code) {
    case CloseCode.Superseded:
      return 'superseded'
    case CloseCode.BadKey:
      return 'bad-key'
    case CloseCode.Full:
      return 'full'
    case CloseCode.VersionMismatch:
      return 'version-mismatch'
    default:
      return 'close'
  }
}

/** xorshift32, seeded (mirrors `net/conditioner.ts`'s own `makeRng`, Deviations: the same
 * reasoning applies verbatim here -- deterministic, integer-only, never the ambient global
 * `no-ambient-random.test.ts` bans outside `src/test/`). */
function makeRng(seed: number): () => number {
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

export interface CreateLinkOptions {
  /** Synchronous: 0009's `Connection` is already open (or open-enough to send/receive) the
   * instant it is returned, so there is no separate "connecting" phase for this file to model. */
  dial: () => Connection
  clock: Clock
  scheduler: Scheduler
  /** Seeds this link's own backoff jitter (Deviations: distinct from `conditionLink`'s network
   * conditioning -- unrelated randomness, unrelated seed space). */
  seed: number
  /** Fires once per dial the instant that dial's own `Connection` becomes current (Seams: "the
   * new socket opens before the old one is discarded" -- a caller wires its own protocol
   * on top, e.g. `HeadlessClient`'s own `Hello`). `gen` is this dial's generation (Seams: "a
   * `Superseded` aimed at a socket the client already replaced is harmless" -- `gen` is how a
   * caller that keeps its own state keyed by connection can tell an old callback from a current
   * one, the same role `net-harness.ts`'s own `linkIdx` plays for a test). */
  onUp(conn: Connection, gen: number): void
  /** Fires once per down transition (never twice in a row without an intervening `onUp`). */
  onDown(why: DownReason): void
}

export interface Link {
  /** 0013: "On `visibilitychange -> visible` or `online`, probe at once with a 1 s deadline." A
   * no-op on a link that has heard from its current connection within `PROBE_DEADLINE_MS`
   * (Planning decisions: "live, changes nothing"); otherwise redials immediately, superseding any
   * scheduled backoff wait, and if the new connection has not proven itself (a message, or a
   * further `probe()`) within `PROBE_DEADLINE_MS`, falls back to the ordinary backoff schedule
   * from its current position. A no-op once `stop()`ped. */
  probe(): void
  /** Disarms every timer and closes the current connection (if any); no further dial ever
   * happens. Idempotent. */
  stop(): void
  readonly state: LinkState
}

export function createLink(opts: CreateLinkOptions): Link {
  const rng = makeRng(opts.seed)
  let state: LinkState = LinkState.Down
  let gen = 0
  let currentConn: Connection | null = null
  let deadTimer: number | null = null
  let backoffTimer: number | null = null
  let probeDeadlineTimer: number | null = null
  let backoffIndex = 0
  let lastActivityAtMs = 0
  let stopped = false

  function clearTimerIfSet(id: number | null): null {
    if (id !== null) opts.scheduler.clearTimer(id)
    return null
  }

  function armDeadTimer(): void {
    deadTimer = clearTimerIfSet(deadTimer)
    deadTimer = opts.scheduler.setTimer(() => {
      deadTimer = null
      goDown('dead')
    }, DEAD_MS)
  }

  function disarmAll(): void {
    deadTimer = clearTimerIfSet(deadTimer)
    backoffTimer = clearTimerIfSet(backoffTimer)
    probeDeadlineTimer = clearTimerIfSet(probeDeadlineTimer)
  }

  /** The jittered delay for `BACKOFF_SCHEDULE_MS[backoffIndex]` (capped at the last entry),
   * `+/- JITTER_FRACTION` uniform, floored to a whole millisecond (a virtual clock's own unit,
   * `VirtualClock`'s doc comment: "virtual time is whole milliseconds"). `0` never jitters
   * negative (the schedule's own first entry, "no wait for the very first attempt"). */
  function nextBackoffMs(): number {
    const idx = Math.min(backoffIndex, BACKOFF_SCHEDULE_MS.length - 1)
    const base = BACKOFF_SCHEDULE_MS[idx] as number
    if (base === 0) return 0
    const jitter = (rng() * 2 - 1) * JITTER_FRACTION * base
    return Math.max(0, Math.floor(base + jitter))
  }

  function scheduleRedial(immediate: boolean): void {
    backoffTimer = clearTimerIfSet(backoffTimer)
    const delay = immediate ? 0 : nextBackoffMs()
    if (!immediate) backoffIndex++
    backoffTimer = opts.scheduler.setTimer(() => {
      backoffTimer = null
      dial()
    }, delay)
  }

  function goDown(why: DownReason): void {
    if (stopped) return
    disarmAll()
    currentConn = null
    state = LinkState.Down
    opts.onDown(why)
    if (TERMINAL_REASONS.has(why)) {
      // Seams: "stops for good on `Superseded`, `BadKey`, `Full`, and reports `VersionMismatch`
      // without retrying by itself" -- `stop()`-equivalent, minus the terminal `state` (a caller
      // reading `state` after a terminal `onDown` sees `Down`, not a fourth "gave up" value this
      // milestone's own Seams never names).
      stopped = true
      return
    }
    scheduleRedial(false)
  }

  function dial(): void {
    if (stopped) return
    gen++
    const myGen = gen
    const conn = opts.dial()
    currentConn = conn
    lastActivityAtMs = opts.clock.now()
    conn.onMessage = () => {
      if (myGen !== gen || stopped) return // Seams: a superseded socket's traffic is harmless
      lastActivityAtMs = opts.clock.now()
      probeDeadlineTimer = clearTimerIfSet(probeDeadlineTimer)
      // Backoff resets on *confirmed* traffic, not merely on a fresh dial (Deviations: a dial
      // that is immediately closed again, over and over with no traffic in between, must still
      // escalate through the schedule -- resetting here instead of in `dial()` is what makes
      // that true; `backoff-schedule`'s own literals depend on it).
      backoffIndex = 0
      armDeadTimer()
    }
    conn.onClose = (code) => {
      if (myGen !== gen || stopped) return
      goDown(closeCodeReason(code))
    }
    state = LinkState.Up
    armDeadTimer()
    opts.onUp(conn, myGen)
  }

  dial()

  return {
    probe() {
      if (stopped) return
      const idleMs = opts.clock.now() - lastActivityAtMs
      if (state === LinkState.Up && idleMs < PROBE_LIVE_THRESHOLD_MS) return // live: no-op
      // Silently dead (or already down): redial now, not on the dead timer's own schedule.
      backoffTimer = clearTimerIfSet(backoffTimer)
      deadTimer = clearTimerIfSet(deadTimer)
      const preProbeGen = gen
      dial()
      probeDeadlineTimer = opts.scheduler.setTimer(() => {
        probeDeadlineTimer = null
        // No traffic since this probe's own dial: it did not pan out -- resume ordinary backoff
        // from here rather than trusting a connection that never proved itself. `preProbeGen`
        // guards against a `probe()` that already succeeded (a message bumped `gen`'s own dead
        // timer, not `gen` itself) being second-guessed after the fact.
        if (gen === preProbeGen && opts.clock.now() - lastActivityAtMs >= PROBE_DEADLINE_MS) {
          goDown('dead')
        }
      }, PROBE_DEADLINE_MS)
    },
    stop() {
      if (stopped) return
      stopped = true
      disarmAll()
      currentConn?.close(0)
      currentConn = null
      state = LinkState.Stopped
    },
    get state() {
      return state
    },
  }
}

// Re-exported only so a caller building a `Connection` to hand `dial()` never has to import
// `MsgClass` from `../server.js` on top of this module purely to type its own dial function.
export type { Connection, MsgClass }
