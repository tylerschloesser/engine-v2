// The client worker's net pump (docs/plan/15b-ring-connection-and-replica-rendering.md, step 4):
// built and run only when this topology is linked (`worker/client.ts`'s own `message.link` gate,
// Orchestrator ruling 1). Drains the downlink ring straight into WASM linear memory --
// `on_frame(len)`, one call per message, over `RegionId.Downlink`'s own preallocated view (created
// once at setup, `.claude/rules/hot-paths.md`) -- with no intermediate buffer: unlike the sim
// role's own `RingConnection.recvBuf`, whose "same buffer every call, real length on the side"
// trick exists only because 0009's `Connection.onMessage(bytes)` takes one argument, this file
// calls `on_frame(len)` directly, so `popInto`'s own return value already *is* the real length.
// Then polls `client_poll_uplink` once every wake and pushes whatever landed in the client's own
// `Tx` region onto the uplink ring -- `RingProducer`'s own `wake` option notifies the sim worker on
// every successful push, the external wake ADR 0030's `poll()` fix (`worker/sim.ts`) exists for.
import type { EngineInstance, RegionView } from '../loader.js'
import { WORKER_HOST } from '../sab/control.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'
import type { Shell } from './shell.js'

/** Vestigial argument for `client_poll_uplink(t_ms: f64)` (`abi::client_poll_uplink`'s own doc
 * comment): the real value is read Rust-side from the just-copied `CameraBlock.frame_time_ms`, the
 * same shape `worker/client.ts`'s own `FRAME_ARG` already uses for `frame(t_ms)`. */
const POLL_UPLINK_ARG = 0

export type NetPump = { pump(): void }

/**
 * Built once at setup; `pump()` itself allocates nothing. `downlink`/`tx` are `null` only for a
 * hand-rolled `Instance` fixture with no such region (never true in practice when linked, since a
 * link is only ever wired for a real `GameInstance`, `client.ts`'s own `host.connect` gate) --
 * kept null-tolerant anyway, the same "costs nothing, answers nothing" shape every other pump here
 * uses for a role/instance that doesn't have what it needs.
 */
export function createNetPump(
  inst: EngineInstance,
  shell: Shell,
  uplinkSab: SharedArrayBuffer,
  downlinkSab: SharedArrayBuffer,
  downlink: RegionView | null,
  tx: RegionView | null,
): NetPump {
  const downlinkConsumer = new RingConsumer(downlinkSab)
  const uplinkProducer = new RingProducer(uplinkSab, {
    control: shell.control,
    index: WORKER_HOST,
  })

  function pump(): void {
    if (downlink) {
      for (;;) {
        const len = downlinkConsumer.popInto(downlink.u8, 0)
        if (len < 0) break
        inst.call1(inst.x.on_frame, len)
      }
    }
    if (tx) {
      const len = inst.call1(inst.x.client_poll_uplink, POLL_UPLINK_ARG)
      if (len > 0 && !uplinkProducer.tryPush(tx.u8, len)) {
        // Full ring (Deviations: not retried, unlike the sim role's own downlink backpressure --
        // `client_poll_uplink`'s own pacing keeps this rare, and a dropped camera report is
        // superseded by the next one regardless): counted, not silently lost from the ring's own
        // perspective (`sab/ring.ts`'s own "a producer that has decided to drop calls this").
        uplinkProducer.recordDrop()
      }
    }
  }

  return { pump }
}
