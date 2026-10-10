// Grace + idle world lifecycle (M28b step 4;
// docs/decisions/0013-sessions-and-integrity.md "A disconnected player's state" / "World
// lifecycle"). A pure state machine over an injected `Clock`/`Scheduler` -- the same "one
// dead-timer/probe/backoff state machine on an injected Clock/Scheduler" shape `net/link.ts`'s own
// `createLink` already uses -- so it is exactly as testable under a virtual clock, and `server.ts`
// (outside `src/test/`) still names no ambient timer.
//
// Presence removal and freeing the connection slot happen *at once*, on an ordinary close --
// `server.ts`'s own `onClose` handler, unchanged by this file. This module owns only the *delayed*
// half: when (if ever) `Record::Player { Disconnected }` actually gets logged, and when the world
// pauses and calls `onIdle`.
import type { Clock, Scheduler } from '../clock.js'

/** 0013 "A disconnected player's state": "The logged `Disconnected` event is injected only after
 * a **10 s grace**". */
export const GRACE_MS = 10_000
/** 0013 "World lifecycle": "if nobody returns within **30 s** the host snapshots ... and calls
 * `onIdle`". */
export const IDLE_MS = 30_000

export interface LifecycleDeps {
  clock: Clock
  scheduler: Scheduler
  /** `WorldConfig.keepTickingWhenEmpty` (`sim-config.ts`). */
  keepTickingWhenEmpty: boolean
  /** Queues `Record::Player { Disconnected }` for `player` (`sim.simLogDisconnected`), delivered
   * at the next `tick()`. */
  logDisconnected(player: number): void
  /** Disarms the pacing timer *now*, synchronously -- no snapshot, no `flush()` (those belong to
   * the idle sequence below, once the delay actually elapses; "the tick that applies the last
   * `Disconnected` is the last tick run" names only the tick loop, not a premature snapshot). */
  stopTicking(): void
  /** `SimHost.pause()` (snapshot-if-dirty, prune, `flush()`) then `HostServices.onIdle?.()`. */
  idle(): Promise<void>
}

export interface LifecycleTracker {
  /** A connection (re)attached for `player` -- a real join, or a reconnect, whether within or
   * after its own grace window. Cancels any pending grace timer for this player and (for a
   * genuinely new arrival, not a within-grace reconnect that never actually left the online set)
   * counts them online again; also cancels a pending idle timer, since the world is no longer
   * empty. Call *after* deciding `isWithinGrace` for the same attach (below) -- this clears the
   * very state that decision reads. */
  playerAttached(player: number): void
  /** `true` iff `player` currently has a live (not yet expired) grace timer -- read by the
   * handshake path *before* `playerAttached`, to decide `sim_attach`'s own `suppressConnected`
   * byte (0013 "a Hello with the same secret inside the grace logs nothing"). */
  isWithinGrace(player: number): boolean
  /** An ungraceful close (no `Bye`): starts this player's own grace timer. Presence/the connection
   * slot are already gone by the time this is called (`server.ts`'s own `onClose`, at once). */
  connectionDropped(player: number): void
  /** An explicit `Bye{Leave}`: skips the grace, logs `Disconnected` at once. */
  playerLeft(player: number): void
  /** Called at the tail of every completed tick (`runOneTick`): if that tick just applied the
   * world's last `Disconnected` (no players left online, `keepTickingWhenEmpty` unset), stops
   * ticking and arms the idle timer. A no-op on every other tick. */
  afterTick(): void
  /** Cancels every pending timer -- `SimHost.stop()`'s own teardown. */
  dispose(): void
}

export function createLifecycleTracker(deps: LifecycleDeps): LifecycleTracker {
  // Every player currently counted online (Planning decisions, this file: a `Set`, not a bare
  // counter -- a within-grace reconnect must not double-count a player who was never actually
  // removed from it, `connectionDropped` below deliberately does not touch this).
  const online = new Set<number>()
  const graceTimers = new Map<number, number>()
  let idleTimer: number | null = null
  let stopAfterNextTick = false

  function cancelGrace(player: number): void {
    const id = graceTimers.get(player)
    if (id !== undefined) {
      deps.scheduler.clearTimer(id)
      graceTimers.delete(player)
    }
  }

  function cancelIdleTimer(): void {
    if (idleTimer !== null) {
      deps.scheduler.clearTimer(idleTimer)
      idleTimer = null
    }
  }

  function armIdleTimer(): void {
    cancelIdleTimer()
    idleTimer = deps.scheduler.setTimer(() => {
      idleTimer = null
      // `Scheduler.setTimer`'s own callback shape is synchronous (`() => void`): `idle()` (async:
      // `SimHost.pause()` then `onIdle()`) is necessarily fire-and-forget from here. A caller that
      // needs to observe its completion synchronously with the timer firing (a test driving a
      // `VirtualClock`, since production never needs to) awaits its own microtask queue drained a
      // few times after the `Scheduler.setTimer`-triggering call returns -- `net-harness.ts`'s own
      // `advanceTo`/`advanceTicks` do not themselves await a fire-and-forgotten callback chain.
      deps.idle().catch(() => {
        // `idle()`'s own two calls (`SimHost.pause()`, `onIdle`) are not expected to throw in
        // practice; swallowed here only so a rejection can never become an unhandled promise
        // rejection that crashes an unrelated later test in the same process.
      })
    }, IDLE_MS)
  }

  function logNow(player: number): void {
    deps.logDisconnected(player)
    online.delete(player)
    if (online.size === 0 && !deps.keepTickingWhenEmpty) {
      stopAfterNextTick = true
    }
  }

  return {
    playerAttached(player) {
      cancelGrace(player)
      online.add(player)
      cancelIdleTimer()
    },
    isWithinGrace(player) {
      return graceTimers.has(player)
    },
    connectionDropped(player) {
      if (graceTimers.has(player)) return // one connection per player: not expected twice
      const id = deps.scheduler.setTimer(() => {
        graceTimers.delete(player)
        logNow(player)
      }, GRACE_MS)
      graceTimers.set(player, id)
    },
    playerLeft(player) {
      cancelGrace(player)
      logNow(player)
    },
    afterTick() {
      if (!stopAfterNextTick) return
      stopAfterNextTick = false
      deps.stopTicking()
      armIdleTimer()
    },
    dispose() {
      for (const id of graceTimers.values()) deps.scheduler.clearTimer(id)
      graceTimers.clear()
      cancelIdleTimer()
    },
  }
}
