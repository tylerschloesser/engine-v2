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
//
// docs/plan/16-action-round-trip.md: also the clock block's own writer (Scope: "written by the
// client worker after each `on_frame`"). Only this pump ever learns whether `on_frame` actually
// applied a real frame (its own `Status` return, `Status.Ok`) -- the one reliable "a session is
// live" signal (`ClientCore::last_summary()`'s default is indistinguishable from a genuine first
// frame at `tick == 0, ack_seq == 0`) -- so `session_state`/`seq_seed` bookkeeping lives here, not
// in a separate always-on pump.
import { Status } from '../abi.js'
import {
  ClockBlockView,
  type ClockFields,
  F32Reader,
  SessionState,
  writeClockBlock,
} from '../clock-block.js'
import type { EngineInstance, RegionView } from '../loader.js'
import { readU32LE } from '../sab/bytes.js'
import { WORKER_HOST } from '../sab/control.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'
import type { Shell } from './shell.js'

/** Vestigial argument for `client_poll_uplink(t_ms: f64)` (`abi::client_poll_uplink`'s own doc
 * comment): the real value is read Rust-side from the just-copied `CameraBlock.frame_time_ms`, the
 * same shape `worker/client.ts`'s own `FRAME_ARG` already uses for `frame(t_ms)`. */
const POLL_UPLINK_ARG = 0

export type NetPump = {
  pump(): void
  /** docs/plan/28-sessions-and-reconnect.md (Scope: "seq_seed/session_state in the clock block are
   * set from `Welcome` instead of the first frame's `ack_seq`, M16's interim rule"): the caller
   * (whoever just applied `client_on_welcome`, e.g. `HeadlessClient`) calls this once, right after
   * a successful attach and before this pump's own `pump()` ever runs for the first time. Writes
   * the clock block immediately (so a `dispatch()` right after `Welcome`, before any real frame has
   * arrived, already sees a live session and the right `seq` baseline) and marks this pump "already
   * seeded", so `pump()`'s own first-frame bootstrap (below) never re-seeds it from `ack_seq`. */
  seedFromWelcome(seqSeed: number): void
}

/**
 * Built once at setup; `pump()` itself allocates nothing. `downlink`/`tx` are `null` only for a
 * hand-rolled `Instance` fixture with no such region (never true in practice when linked, since a
 * link is only ever wired for a real `GameInstance`, `client.ts`'s own `host.connect` gate) --
 * kept null-tolerant anyway, the same "costs nothing, answers nothing" shape every other pump here
 * uses for a role/instance that doesn't have what it needs.
 *
 * `ticksPerSecond` is read once at setup (`worker/client.ts`'s own `tick_hz()` call, docs/plan/
 * 16-action-round-trip.md: "need not be re-plumbed per frame") and mirrored into the clock block
 * unchanged on every write; `clockBlock`/`result` are `null`/absent only for the same hand-rolled-
 * fixture case as `downlink`/`tx`, above -- a real `GameInstance` always has a `Result` region.
 */
export function createNetPump(
  inst: EngineInstance,
  shell: Shell,
  uplinkSab: SharedArrayBuffer,
  downlinkSab: SharedArrayBuffer,
  downlink: RegionView | null,
  tx: RegionView | null,
  clockBlockSab: SharedArrayBuffer,
  result: RegionView | null,
  ticksPerSecond: number,
): NetPump {
  const downlinkConsumer = new RingConsumer(downlinkSab)
  const uplinkProducer = new RingProducer(uplinkSab, {
    control: shell.control,
    index: WORKER_HOST,
  })
  const clockView = new ClockBlockView(clockBlockSab)
  const tickFractionReader = new F32Reader()
  // Preallocated once (`.claude/rules/hot-paths.md`): mutated in place on every clock-block write
  // instead of a fresh object literal per wake.
  const clockFields: ClockFields = {
    authoritativeTick: 0,
    predictedTick: 0,
    ticksPerSecond,
    sessionState: SessionState.Handshaking,
    seqSeed: 0,
    ackSeq: 0,
    tickFraction: 0,
    revealed: 0,
  }
  let live = false

  function pump(): void {
    let sawFrame = false
    if (downlink) {
      for (;;) {
        const len = downlinkConsumer.popInto(downlink.u8, 0)
        if (len < 0) break
        if (inst.call1(inst.x.on_frame, len) === Status.Ok) sawFrame = true
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
    if (sawFrame && result && inst.call0(inst.x.client_clock_stats) === Status.Ok) {
      const tick = readU32LE(result.u8, 0)
      const ackSeq = readU32LE(result.u8, 4)
      // docs/plan/26-prediction-rendering-and-clocks.md steps 4-6 (`ABI_VERSION` 23 -> 24):
      // `client_clock_stats`'s own widened result -- `predicted_tick` (real from this milestone,
      // 0012 "Two clocks") and `tick_fraction` (`ClientCore::last_tick_fraction`'s bits).
      const predictedTick = readU32LE(result.u8, 8)
      const tickFraction = tickFractionReader.read(result.u8, 12)
      const revealed = readU32LE(result.u8, 16)
      // docs/plan/28-sessions-and-reconnect.md: `live`/`seqSeed`/`sessionState` are now seeded by
      // `seedFromWelcome` (below), called once by the caller right after a successful `Welcome`,
      // *before* this pump's own first `pump()` call -- this bootstrap-from-the-first-frame path
      // (M16's interim rule) is unreachable in production from this milestone on, and kept only so
      // a caller that never calls `seedFromWelcome` (a hand-rolled fixture, an old test) still goes
      // live eventually rather than dispatch()ing forever.
      if (!live) {
        live = true
        clockFields.seqSeed = ackSeq
        clockFields.sessionState = SessionState.Online
      }
      clockFields.authoritativeTick = tick
      clockFields.predictedTick = predictedTick
      clockFields.ackSeq = ackSeq
      clockFields.tickFraction = tickFraction
      clockFields.revealed = revealed
      writeClockBlock(clockView, clockFields)
    }
  }

  return {
    pump,
    seedFromWelcome(seqSeed) {
      live = true
      clockFields.seqSeed = seqSeed
      clockFields.sessionState = SessionState.Online
      writeClockBlock(clockView, clockFields)
    },
  }
}
