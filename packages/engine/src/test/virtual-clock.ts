// `createVirtualClock` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Seams): "M03's
// `ManualClock` plus `advanceTo(t)` ... and `advanceBy(ms)`" -- docs/decisions/0020-testing-
// strategy.md §7's "Time is a virtual clock" paragraph: "`advanceTo(t)` awaits physical arrival of
// every message with `deliverAt <= t`, then releases them in the total order `(deliverAt, link,
// seq)`". `../net/conditioner.ts`'s `conditionLink` is the one caller of `scheduleDelivery`/
// `nextLinkId` below (Deviations: not named in the brief's own Seams line for `VirtualClock`, which
// only calls out `advanceTo`/`advanceBy` -- this is the registration hook those two need to
// interleave *several* links' pending releases in one global order, so one `advanceTo` caller
// settles every conditioned link sharing this clock, not just one).
import { createManualClock, type ManualClock } from './manual-clock.js'

/** One pending, not-yet-released delivery. `link`/`seq` are the last two total-order keys (0020
 * §7): `link` is a small integer a conditioner is handed once by `nextLinkId()`, `seq` its own
 * per-link send counter -- both exist so two links with colliding `deliverAt` (frequent: virtual
 * time is whole milliseconds) still release in one deterministic order, and so does a single link's
 * own same-millisecond burst. `run` may return a `Promise`: `advanceTo` awaits each one in turn
 * before moving to the next entry, which is what "awaits physical arrival" means for an in-memory
 * pair (`memoryConnectionPair`'s own `send` defers delivery to a microtask -- `run`'s own promise is
 * how a caller of `advanceTo` gets a point after which that microtask has actually fired). */
export interface PendingDelivery {
  deliverAt: number
  link: number
  seq: number
  run: () => void | Promise<void>
}

export interface VirtualClock extends ManualClock {
  /** Awaits physical arrival of every registered delivery with `deliverAt <= t` (Seams), releasing
   * them in `(deliverAt, link, seq)` order, then advances the underlying `ManualClock` to `t`
   * (firing any real `setTimer` callbacks registered on this same clock along the way). Throws if
   * `t` is before the clock's current time (time never runs backward). */
  advanceTo(t: number): Promise<void>
  /** `advanceTo(this.now() + ms)`. */
  advanceBy(ms: number): Promise<void>
  /** `conditionLink`'s own registration hook (Deviations, above): queues one delivery, released by
   * a future `advanceTo`/`advanceBy` whose `t` reaches `entry.deliverAt`. */
  scheduleDelivery(entry: PendingDelivery): void
  /** One small integer per call, starting at 0: `conditionLink`'s own `link` key, assigned once per
   * conditioned link so several links sharing one clock still sort deterministically against each
   * other. */
  nextLinkId(): number
}

function sortKey(entry: PendingDelivery): [number, number, number] {
  return [entry.deliverAt, entry.link, entry.seq]
}

function compareEntries(a: PendingDelivery, b: PendingDelivery): number {
  const [ad, al, as] = sortKey(a)
  const [bd, bl, bs] = sortKey(b)
  if (ad !== bd) return ad - bd
  if (al !== bl) return al - bl
  return as - bs
}

export function createVirtualClock(startMs = 0): VirtualClock {
  const manual = createManualClock(startMs)
  let pending: PendingDelivery[] = []
  let nextLink = 0

  async function advanceTo(t: number): Promise<void> {
    if (t < manual.now()) {
      throw new Error(`VirtualClock.advanceTo: t (${t}) is before now() (${manual.now()})`)
    }
    for (;;) {
      // Re-scanned every loop, not computed once up front: a `run()` below may itself schedule a
      // further delivery at or before `t` (a retry, a multi-hop relay) that must also release
      // before this call returns -- "releases them" (Seams) means every one due by `t`, including
      // one only just registered.
      let due: PendingDelivery | null = null
      for (const entry of pending) {
        if (entry.deliverAt > t) continue
        if (due === null || compareEntries(entry, due) < 0) due = entry
      }
      if (due === null) break
      pending = pending.filter((e) => e !== due)
      // `clock.now()` reads as this entry's own `deliverAt` while its `run()` executes (a
      // conditioner's own `send` inside `run()` computes a fresh draw relative to "now", which must
      // be the virtual instant this message is actually arriving at, not the time `advanceTo` was
      // called from) -- advanced one entry at a time, monotonically, never past `t`.
      manual.advance(due.deliverAt - manual.now())
      // Sequential, not `Promise.all`: the total order (Seams) is a release *order*, and awaiting
      // one at a time is what lets a real (future `ws`) adapter's own asynchronous delivery land
      // before the next entry's own `run()` reads state it depends on.
      await due.run()
    }
    manual.advance(t - manual.now())
  }

  return {
    ...manual,
    scheduleDelivery(entry) {
      pending.push(entry)
    },
    nextLinkId() {
      return nextLink++
    },
    advanceTo,
    advanceBy(ms) {
      return advanceTo(manual.now() + ms)
    },
  }
}
