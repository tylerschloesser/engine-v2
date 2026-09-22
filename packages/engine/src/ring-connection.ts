// `RingConnection` (docs/plan/15b-ring-connection-and-replica-rendering.md, Scope): the 0009
// `Connection` shape over one SAB ring pair (`SabSet.uplink`/`SabSet.downlink`), `datagrams:
// false`. This is the sim role's own end of the pair -- `send`/`close` write the *downlink*
// (`RingProducer`), `onMessage` fires from draining the *uplink* (`RingConsumer`). The client
// worker's own end (writing uplink, reading downlink) is a separate, later concern (docs/plan/
// 15b-ring-connection-and-replica-rendering.md step 4, Non-scope here): it has no `Connection`
// shape to implement (0009's `Connection` is the *host's* view of a link), so it drives
// `RingProducer`/`RingConsumer` directly.
//
// Zero-allocation discipline on both the per-message (uplink) and per-frame (downlink `send`)
// paths (docs/plan/15b-ring-connection-and-replica-rendering.md, Constraints): every buffer here
// is preallocated at construction and reused; `send`'s only per-call work past the initial
// `tryPush` attempt is `Uint8Array.prototype.set` into an already-allocated retry slot (allowed:
// `.claude/rules/hot-paths.md` bans `subarray()`/`slice()`/`new Uint8Array(...)`, not `.set()`).

import type { ControlBlock } from './sab/control.js'
import { RingConsumer, RingProducer, type RingStats } from './sab/ring.js'
import type { Connection, MsgClass } from './server.js'

/** `MsgClass` values this file reads without importing the `const` object itself (avoids a
 * circular import: `server.ts` -> ... -> nothing imports `ring-connection.ts` today, but the
 * `type`-only import above keeps it that way on purpose). Mirrors `server.ts`'s own
 * `MsgClass.ReliableOrdered = 0`. */
const RELIABLE_ORDERED: MsgClass = 0

export type RingConnectionOptions = {
  /** Largest single uplink message this connection will ever receive (the sim role's own `Rx`
   * region capacity, `SIM_RX_BYTES` in `crates/engine/src/host/mod.rs`): sizes the one
   * preallocated receive buffer `onMessage` is called with, reused every message. */
  maxUplinkBytes: number
  /** Largest single downlink frame this connection will ever need to hold for a retry (the sim
   * role's own `Tx` region capacity, `SIM_TX_BYTES`): sizes each preallocated retry-queue slot. */
  maxDownlinkBytes: number
  /** Retry-queue depth: how many consecutive backpressured `send()` calls this connection holds
   * before it starts coalescing onto the newest still-queued frame instead of growing further.
   * Default 8. Provisional (Deviations): sustained backpressure past this depth is M31's pacing
   * problem, not solved here -- 0010's own bandwidth/backoff design is Non-scope for this
   * milestone. */
  retryDepth?: number
}

const DEFAULT_RETRY_DEPTH = 8

/**
 * The sim role's own 0009 `Connection` over a SAB ring pair. `send`/`close` are the producer side
 * of `downlink`; draining `uplink` (`drainUplink`, called by `SimHost.accept`'s own per-tick/
 * per-wake pump, Scope) is the consumer side that fires `onMessage`.
 *
 * **Backpressure (0015 §2: "the producer keeps the message and retries; ... never silent
 * loss").** A full `downlink` ring does not lose the frame `send()` was given (whose bytes are
 * only valid during that call, 0009's own `Connection.send` doc comment): `send()` copies it into
 * one of `retryDepth` preallocated slots and counts `downlinkRetries`. Every subsequent `send()`
 * call (and hence every subsequent tick) first tries to flush whatever is still queued, oldest
 * first, before attempting its own new frame -- so delivery stays in order and nothing already
 * built is dropped as long as the queue has room. `MsgClass.LatestWins` (never used by this
 * milestone: only `ReliableOrdered` frames are sent, Scope) is exempt from queuing by design --
 * 0009 allows a `latest-wins` message to be dropped, so a failed push there is simply not
 * retried.
 */
export class RingConnection implements Connection {
  readonly datagrams = false
  onMessage: ((bytes: Uint8Array) => void) | null = null
  onClose: ((code: number) => void) | null = null

  private readonly consumer: RingConsumer
  private readonly producer: RingProducer
  private readonly recvBuf: Uint8Array
  private recvLen = 0

  private readonly retryDepth: number
  private readonly retryBufs: Uint8Array[]
  private readonly retryLens: Uint32Array
  private retryHead = 0
  private retryCount = 0
  private _downlinkRetries = 0

  // Preallocated once, mutated in place by the `drops` getter (`.claude/rules/hot-paths.md`:
  // "preallocate scratch objects at init and mutate them").
  private readonly ringStats: RingStats = { drops: 0, pushed: 0, popped: 0 }

  constructor(
    uplink: SharedArrayBuffer,
    downlink: SharedArrayBuffer,
    opts: RingConnectionOptions,
    wake?: { control: ControlBlock; index: number },
  ) {
    this.consumer = new RingConsumer(uplink)
    this.producer = new RingProducer(downlink, wake)
    this.recvBuf = new Uint8Array(opts.maxUplinkBytes)
    this.retryDepth = opts.retryDepth ?? DEFAULT_RETRY_DEPTH
    this.retryBufs = []
    for (let i = 0; i < this.retryDepth; i++) {
      this.retryBufs.push(new Uint8Array(opts.maxDownlinkBytes))
    }
    this.retryLens = new Uint32Array(this.retryDepth)
  }

  /** Count of `send()` calls that could not push immediately and were queued instead (0009
   * backpressure, above). Only ever grows; never resets. */
  get downlinkRetries(): number {
    return this._downlinkRetries
  }

  /** The underlying `downlink` ring's own drop counter (`sab/ring.ts`'s `RingProducer.
   * recordDrop`, never called here): stays 0 for the life of this connection -- a full ring is
   * backpressure (queued, above), never a silent loss. Exposed live from the ring itself, not a
   * separately tracked field, so it cannot drift from what the ring actually recorded. */
  get drops(): number {
    this.producer.stats(this.ringStats)
    return this.ringStats.drops
  }

  /** Valid length of the buffer most recently handed to `onMessage` (side channel: 0009's
   * `Connection.onMessage` takes one argument, and this class hands the *same* preallocated
   * receive buffer every call rather than a freshly sized one -- `.claude/rules/hot-paths.md`'s
   * "views are created once ... reused", not a per-message `subarray()`). Read from inside the
   * `onMessage` callback, synchronously, before the next `drainUplink()` iteration overwrites it. */
  get lastMessageLength(): number {
    return this.recvLen
  }

  /** 0009 `Connection.send`: `bytes` is engine-owned, valid only during this call. */
  send(cls: MsgClass, bytes: Uint8Array): void {
    if (cls !== RELIABLE_ORDERED) {
      // `latest-wins` (Scope: unused this milestone -- camera reports and presence are uplink,
      // never sent through this method): one attempt, dropped (not queued) on failure, per 0009
      // ("may be dropped"). Never touches `downlinkRetries` (that counter is this milestone's own
      // reliable-frame backpressure signal) or the retry queue.
      this.producer.tryPush(bytes, bytes.length)
      return
    }
    this.flushRetries()
    if (this.retryCount > 0 || !this.producer.tryPush(bytes, bytes.length)) {
      this.enqueueRetry(bytes)
    }
  }

  /** Attempts to flush whatever is still queued from an earlier backpressured `send()`, without
   * sending anything new. `SimHost.accept`'s own per-tick procedure calls this every tick
   * (Scope), not only on a tick whose `sim_build_frame` produced a fresh frame -- a tick with
   * nothing new to say (`build_frame`'s own "nothing to say" `0`) must still give a previously
   * queued frame another chance to drain, or a connection that falls behind during a burst could
   * stay behind forever once the world goes idle. */
  pumpRetries(): void {
    this.flushRetries()
  }

  /** 0009 `Connection.close`: nothing to release at the ring level this milestone (the ring pair
   * is owned and torn down by whatever spawned this connection's worker, not by `close()` itself
   * -- session teardown is M28/M29, Non-scope here). */
  close(_code: number): void {
    // Intentionally empty; see the doc comment above.
  }

  /** Drains every pending `uplink` message, calling `onMessage` once per message with the shared
   * receive buffer (`lastMessageLength` gives its valid length). The caller (`SimHost.accept`'s
   * own per-tick/per-wake pump, Scope) decides when this runs; `RingConnection` never polls on
   * its own. */
  drainUplink(): void {
    for (;;) {
      const len = this.consumer.popInto(this.recvBuf, 0)
      if (len < 0) break
      this.recvLen = len
      if (this.onMessage) this.onMessage(this.recvBuf)
    }
  }

  private flushRetries(): void {
    while (this.retryCount > 0) {
      const idx = this.retryHead
      const buf = this.retryBufs[idx] as Uint8Array
      const len = this.retryLens[idx] as number
      if (!this.producer.tryPush(buf, len)) break
      this.retryHead = (this.retryHead + 1) % this.retryDepth
      this.retryCount--
    }
  }

  private enqueueRetry(bytes: Uint8Array): void {
    this._downlinkRetries++
    if (this.retryCount >= this.retryDepth) {
      // Sustained backpressure past the queue's own depth (doc comment above): coalesce onto the
      // newest still-queued slot rather than grow unboundedly or touch the ring out of order.
      // Provisional (Deviations): a connection that falls this far behind is M31's pacing problem.
      const tailIdx = (this.retryHead + this.retryDepth - 1) % this.retryDepth
      const buf = this.retryBufs[tailIdx] as Uint8Array
      buf.set(bytes)
      this.retryLens[tailIdx] = bytes.length
      return
    }
    const idx = (this.retryHead + this.retryCount) % this.retryDepth
    const buf = this.retryBufs[idx] as Uint8Array
    buf.set(bytes)
    this.retryLens[idx] = bytes.length
    this.retryCount++
  }
}
