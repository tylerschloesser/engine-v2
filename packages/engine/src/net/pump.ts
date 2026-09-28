// `createBytePump` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Seams; docs/decisions/
// 0015-threads-memory-and-topology.md §1): the net worker's pump core, between M06 rings
// (`SabSet.uplink`/`downlink`) and a `Connection` (docs/decisions/0009-transport-and-hosting.md).
// From the ring pair's own naming (`worker/client-net.ts`): `uplink` is produced by a client
// instance's own `client_poll_uplink` batches (client -> host, drained here and forwarded to
// `Connection.send`); `downlink` is consumed by a client instance's own `on_frame` (host -> client,
// filled here from `Connection.onMessage`). M29 wires this into a real `net`-kind worker;
// `HeadlessClient` (`src/test/headless-client.ts`) is this milestone's own caller, in-thread (no
// worker, no `Atomics.wait`) -- "the net worker's pump core" reused directly rather than
// reimplemented, matching this milestone's own "one thread, stepped actors" Planning decision.
//
// docs/plan/29-net-worker-and-reference-server.md, this cut's own step 5 (Deviations, carried
// forward from the M27 gate note and repeated at steps 1-2/3-4): this module allocated per message
// (`.slice()` on every uplink drain, `.slice()` per downlink push) -- true while it ran only inside
// `HeadlessClient`, outside `.claude/rules/hot-paths.md` (the server is exempt, 0016). Wrapped in a
// real `net`-kind worker (`worker/net.ts`), it is a hot path (the rule's own `paths` glob already
// covers `src/net/**`, steps 1-2's own Deviations).
//
// **Downlink (onMessage -> ring) is now allocation-free in the common (non-backpressured) case**:
// `RingProducer.tryPush(bytes, len)` copies synchronously into the ring's own SAB storage before
// this call returns, so the `bytes` a `Connection.onMessage` hands over (0009: "engine-owned,
// valid only during the call") never needs its own copy just to be pushed -- the old code
// unconditionally `.slice()`d, queued and immediately re-drained every message, whether or not the
// ring actually had room. A copy is now made only on genuine backpressure (the ring briefly full),
// into one of `retryDepth` preallocated slots (`ring-connection.ts`'s own `send()`/`flushRetries`/
// `enqueueRetry` shape, mirrored here for the opposite direction), `.set()` not `slice()`.
//
// **Uplink (ring -> Connection.send) still allocates one `.slice()` per message, not fixed here**:
// a first attempt (Deviations, tried in this range) reserved a resizable `ArrayBuffer` (ES2024)
// once and `.resize()`d it to the real message length in place before each `send()` -- no
// allocation, and the exact-length view every `Connection.send(cls, bytes)` 2-arg caller expects
// (0009's contract makes no promise a receiver reads an optional third `len`, the same reasoning
// `ring-connection.ts`'s own doc comment on that parameter gives -- this file's own unit test's
// plain 2-arg mock `Connection` is exactly such a caller). **Reverted, found live**: Node's own
// global `WebSocket` (`wsConnection.ts`'s own header comment: "the same function also runs under
// Node 22's global `WebSocket`", exercised by `ws/*`/`reference-server/smoke`) throws `TypeError:
// ArrayBuffer: Received a resizable ArrayBuffer` from inside `ws.send()` -- confirmed with
// `pnpm test:slow netcode -t "ws/|reference-server"`, which this change turned red. A resizable
// buffer is therefore not usable at the one real socket boundary this pump exists to reach, in
// either runtime this module has to run under (Node here, a browser `WebSocket` in production).
// `upScratch.slice(0, len)` stays: a real, small, per-uplink-message allocation, same order as the
// unavoidable one on the *receive* side (a browser/Node `WebSocket` hands `onmessage` a fresh
// `ArrayBuffer` per network message by construction -- `wsConnection.ts`'s own `new Uint8Array(ev.
// data)` -- no JS-side technique removes that either). Left as a real, measured, budgeted cost
// (`gc/multiplayer-topology`'s own `net` isolate, `class: "budgeted"` not `"strict"`, `budgets.json`)
// rather than a false "zero" claim; the downlink-side fix above is the real reduction this cut
// makes, and is what the M27 gate note's own "reused buffers" was chiefly about (the *unconditional*
// queue-and-immediately-drain shape, not a socket-API boundary that has no zero-alloc form).
import { RingConsumer, RingProducer } from '../sab/ring.js'
import { type Connection, MsgClass } from '../server.js'

// Generous relative to one `UplinkBatch`/`Frame` in practice (0011 wire format): sized only so
// `popInto`/a retry slot has somewhere to copy into.
const SCRATCH_BYTES = 64 * 1024

// Mirrors `ring-connection.ts`'s own `DEFAULT_RETRY_DEPTH`: how many consecutive backpressured
// downlink pushes this pump holds (preallocated slots, below) before it starts coalescing onto the
// newest still-queued one instead of growing further. Provisional, same as there: sustained
// backpressure past this depth is M31's pacing problem, not solved here.
const DEFAULT_RETRY_DEPTH = 8

export interface BytePump {
  /**
   * Wires `conn` as this pump's `Connection`: `onMessage`/`onClose` are set here and must not be
   * touched by the caller afterward (the same convention `conditionLink`'s own `ends` carry).
   * Detaches any previously attached connection first. Immediately drains whatever the uplink ring
   * already holds onto the new connection.
   */
  attach(conn: Connection): void
  /** Detaches the current connection (`onMessage` nulled, so no further deliveries land). Queued,
   * not-yet-pushed downlink bytes are kept: a connection re-attached later still gets them, in
   * order, on its next `drain()`. */
  detach(): void
  /**
   * Retries every queued downlink delivery (bytes the attached `Connection` already handed over
   * via `onMessage`, but the downlink ring had no room for yet -- a real transport's own receive
   * buffer backs this in production, so losing one here would be a protocol bug, not a policy:
   * unlike `client-net.ts`'s own uplink camera-report push, this never drops, only retries), then
   * drains everything `client_poll_uplink` has produced onto the uplink ring since the last call,
   * forwarding each message to the attached `Connection.send`. A caller (`HeadlessClient.pump()`)
   * runs this once per pump, after the client instance's own net pump has had a chance to fill the
   * uplink ring.
   */
  drain(): void
}

export function createBytePump({
  uplink,
  downlink,
  retryDepth = DEFAULT_RETRY_DEPTH,
}: {
  uplink: SharedArrayBuffer
  downlink: SharedArrayBuffer
  /** Test-only override (`pump.test.ts`'s own small-ring backpressure scenario doesn't need this
   * deep a queue to prove "retries, never drops"); production (`worker/net.ts`) always takes the
   * default. */
  retryDepth?: number
}): BytePump {
  const uplinkConsumer = new RingConsumer(uplink)
  const downlinkProducer = new RingProducer(downlink)
  const upScratch = new Uint8Array(SCRATCH_BYTES)

  // Preallocated downlink retry queue (backpressure only, never a drop -- `attach`'s own doc
  // comment below): `ring-connection.ts`'s own `send()`/`flushRetries()`/`enqueueRetry()` shape,
  // mirrored for the opposite direction (bytes arriving off a `Connection`, retried *into* the
  // downlink ring, rather than a tick's own frame retried out of one) -- preallocated slots,
  // `.set()` never `slice()`, coalesce onto the newest slot past `retryDepth` rather than grow
  // unboundedly. Provisional, same as there: sustained backpressure past this depth is M31's
  // pacing problem, not solved here.
  const retryBufs: Uint8Array[] = []
  for (let i = 0; i < retryDepth; i++) retryBufs.push(new Uint8Array(SCRATCH_BYTES))
  const retryLens = new Uint32Array(retryDepth)
  let retryHead = 0
  let retryCount = 0

  let conn: Connection | null = null

  function flushDown(): void {
    while (retryCount > 0) {
      const idx = retryHead
      const buf = retryBufs[idx] as Uint8Array
      const len = retryLens[idx] as number
      if (!downlinkProducer.tryPush(buf, len)) return // still full: retry next drain()
      retryHead = (retryHead + 1) % retryDepth
      retryCount--
    }
  }

  function enqueueDown(bytes: Uint8Array, len: number): void {
    if (retryCount >= retryDepth) {
      // Sustained backpressure past the queue's own depth: coalesce onto the newest still-queued
      // slot (`ring-connection.ts`'s own precedent) rather than grow unboundedly or touch the ring
      // out of order.
      const tailIdx = (retryHead + retryDepth - 1) % retryDepth
      const buf = retryBufs[tailIdx] as Uint8Array
      buf.set(bytes)
      retryLens[tailIdx] = len
      return
    }
    const idx = (retryHead + retryCount) % retryDepth
    const buf = retryBufs[idx] as Uint8Array
    buf.set(bytes)
    retryLens[idx] = len
    retryCount++
  }

  function drainUp(): void {
    if (!conn) return
    for (;;) {
      const len = uplinkConsumer.popInto(upScratch, 0)
      if (len < 0) break
      // "engine-owned buffer, valid only during the call" (0009): a fresh, exactly-sized copy, not
      // a view over the reused `upScratch` -- the module header comment above records why this one
      // remains (a resizable-buffer alternative was tried and reverted: real Node/browser
      // `WebSocket.send()` needs an exact-length, non-resizable view, and 0009's `Connection.send`
      // is a generic 2-arg contract no caller can assume a `len` hint past).
      conn.send(MsgClass.ReliableOrdered, upScratch.slice(0, len))
    }
  }

  return {
    attach(c) {
      if (conn) conn.onMessage = null
      conn = c
      conn.onMessage = (bytes) => {
        flushDown()
        // Ordering (`attach`'s own doc comment): a message that arrives while something is still
        // queued from an earlier backpressure episode must queue behind it, never jump the ring.
        if (retryCount > 0 || !downlinkProducer.tryPush(bytes, bytes.length)) {
          enqueueDown(bytes, bytes.length)
        }
      }
      drainUp()
    },
    detach() {
      if (conn) conn.onMessage = null
      conn = null
    },
    drain() {
      flushDown()
      drainUp()
    },
  }
}
