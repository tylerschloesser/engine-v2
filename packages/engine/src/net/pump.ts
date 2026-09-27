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

import { RingConsumer, RingProducer } from '../sab/ring.js'
import { type Connection, MsgClass } from '../server.js'

// Generous relative to one `UplinkBatch`/`Frame` in practice (0011 wire format): sized only so
// `popInto` has somewhere to copy into. This module is test-support (never imported by production
// code, `engine/test`'s own re-export, `src/test.ts`), the same standing `src/net/memory-
// connection.ts`/`src/net/conditioner.ts` already claim for their own per-message `.slice()`
// copies -- not a per-frame/per-tick production hot path `.claude/rules/hot-paths.md` binds.
const SCRATCH_BYTES = 64 * 1024

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
}: {
  uplink: SharedArrayBuffer
  downlink: SharedArrayBuffer
}): BytePump {
  const uplinkConsumer = new RingConsumer(uplink)
  const downlinkProducer = new RingProducer(downlink)
  const upScratch = new Uint8Array(SCRATCH_BYTES)
  // FIFO of not-yet-pushed downlink messages (backpressure, never a drop -- `attach`'s own doc
  // comment above). Unbounded here: 0015's real net worker would bound this against the
  // transport's own backpressure signal (`Connection.bufferedAmount`), Non-scope this milestone
  // (M31's token bucket/soft cap).
  const pendingDown: Uint8Array[] = []
  let conn: Connection | null = null

  function drainDown(): void {
    while (pendingDown.length > 0) {
      const msg = pendingDown[0] as Uint8Array
      if (!downlinkProducer.tryPush(msg, msg.length)) return // still full: retry next drain()
      pendingDown.shift()
    }
  }

  function drainUp(): void {
    if (!conn) return
    for (;;) {
      const len = uplinkConsumer.popInto(upScratch, 0)
      if (len < 0) break
      // "engine-owned buffer, valid only during the call" (0009): a fresh, exactly-sized copy, not
      // a view over the reused `upScratch` -- `memory-connection.ts`/`conditioner.ts`'s own
      // precedent for this net-support code.
      conn.send(MsgClass.ReliableOrdered, upScratch.slice(0, len))
    }
  }

  return {
    attach(c) {
      if (conn) conn.onMessage = null
      conn = c
      conn.onMessage = (bytes) => {
        pendingDown.push(bytes.slice())
        drainDown()
      }
      drainUp()
    },
    detach() {
      if (conn) conn.onMessage = null
      conn = null
    },
    drain() {
      drainDown()
      drainUp()
    },
  }
}
