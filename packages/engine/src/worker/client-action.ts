// The client worker's action/UI-result pump (M16, step 3): built
// once at setup, run every wake, the same "costs nothing, answers nothing" shape as `client-gen.
// ts`/`client-upload.ts`/`client-input.ts`. Drains `actionRing` (main's `dispatch()` writes) into
// `on_action(len)` over `RegionId.Rx` (shared with `on_input`'s own, differently-shaped records --
// a different message kind on the same client-role receive buffer), then drains `client_poll_ui`'s
// own output onto `uiRing` for main's per-rAF drain (`client.ts`) to pick up. Unrelated to
// `worker/client.ts`'s own `echo`-gated test-only actionRing/uiRing usage (the `gc-echo` page's SAB
// -> region -> region -> SAB round trip): that path never calls `on_action`/`client_poll_ui` at
// all, and the two are mutually exclusive (`worker/client.ts`'s `setup()` builds this pump only
// when `echo` is not set).
//
// `on_action`'s own `Status` is checked (gate fix): a locally dropped action (a malformed ring
// record, or the outbox backstop at capacity) produces no `onActionResult` and no host verdict --
// see this file's own `pump()` for why -- so it is counted via `RingConsumer.recordDrop()` rather
// than silently discarded, the same `stats().drops` counter `netCounters`/a HUD's own "ring drops"
// field already reads for every other SAB ring in this package.
import { Status } from '../abi.js'
import type { EngineInstance, RegionView } from '../loader.js'
import { readU32LE } from '../sab/bytes.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'

export type ActionPump = {
  pump(): void
  /** The highest `seq` this pump has handed to `on_action` (`-1` before the first): read off a dead
   * pump by the client worker's trap reaction (M37 step 1) to learn
   * how far dispatched seqs reach. Updated before the call, so an action the instance trapped on
   * counts. */
  lastSeq(): number
  /** Writes one `Lost` result record (`[kind 2][len][{"seq":N,"result":"Lost"}]`, the shape
   * `game_instance::push_lost_record` produces) per seq in `(afterSeq, throughSeq]` onto the UI
   * ring, for the actions a replaced client instance can no longer resolve (M28b's `Lost`: the host
   * may have processed them, nothing here can tell). Rare path (a trap), allocation is fine. */
  pushLost(afterSeq: number, throughSeq: number): void
}

/**
 * `rx`/`ui` are `null` only for a hand-rolled `Instance` fixture with no such region (a low-level
 * fixture that never calls `export_game!`) -- kept null-tolerant anyway, matching every other pump
 * here. No `wake` option on `uiProducer`: unlike a worker-to-worker ring, main never blocks in
 * `Atomics.wait` (0015 §2), so it drains `uiRing` on its own per-rAF poll instead of being woken.
 */
export function createActionPump(
  inst: EngineInstance,
  actionRingSab: SharedArrayBuffer,
  uiRingSab: SharedArrayBuffer,
  rx: RegionView | null,
  ui: RegionView | null,
): ActionPump {
  const actionConsumer = new RingConsumer(actionRingSab)
  const uiProducer = new RingProducer(uiRingSab)
  let lastSeq = -1

  function pump(): void {
    if (rx) {
      for (;;) {
        const len = actionConsumer.popInto(rx.u8, 0)
        if (len < 0) break
        lastSeq = readU32LE(rx.u8, 0)
        if (inst.call1(inst.x.on_action, len) !== Status.Ok) {
          // `ActionError::Malformed -> Status.Decode` (a corrupt ring record: never expected from
          // main's own `dispatch`/`dispatchRaw`, but `on_action` decodes untrusted-shaped bytes
          // regardless) or `ActionError::Full -> Status.OutOfMemory` (the outbox backstop: main's
          // own `dispatch` already enforces capacity synchronously by counting `seq - ack_seq`
          // before ever writing a record, so this path is reachable only through `dispatchRaw`,
          // test-only, or a real race between that check and this pump's own drain). Either way
          // `dispatch()` has already handed the app a `seq` that will never resolve -- no host
          // verdict exists for it (0004's `Rejected<G>` is a host-only shape; synthesising a local
          // one is M25's pending-queue job, not this backstop's) -- so it is counted here, the same
          // "drop and count, never block or retry" policy every other full/rejected ring write in
          // this codebase already uses (`recordDrop`'s own doc comment).
          actionConsumer.recordDrop()
        }
      }
    }
    if (ui) {
      for (;;) {
        const n = inst.call0(inst.x.client_poll_ui)
        if (n <= 0) break
        if (!uiProducer.tryPush(ui.u8, n)) {
          // `uiRing` (256 slots x 1024 B, `sab/layout.ts`) dwarfs `UI_BYTES` (4,096 B, the most
          // one `client_poll_ui` call can ever return), so this is not expected to fire in
          // practice; counted rather than silently lost, the same policy `client-net.ts`'s own
          // uplink drop uses, and this wake's own `client_poll_ui` output for the batch already
          // drained from Rust's `ui_buf` is what would be lost -- stop rather than spin against a
          // full ring.
          uiProducer.recordDrop()
          break
        }
      }
    }
  }

  function pushLost(afterSeq: number, throughSeq: number): void {
    const encoder = new TextEncoder()
    for (let seq = afterSeq + 1; seq <= throughSeq; seq++) {
      const json = encoder.encode(`{"seq":${seq},"result":"Lost"}`)
      const record = new Uint8Array(5 + json.length)
      record[0] = 2
      record[1] = json.length & 0xff
      record[2] = (json.length >>> 8) & 0xff
      record[3] = (json.length >>> 16) & 0xff
      record[4] = (json.length >>> 24) & 0xff
      record.set(json, 5)
      if (!uiProducer.tryPush(record, record.length)) uiProducer.recordDrop()
    }
  }

  return { pump, lastSeq: () => lastSeq, pushLost }
}
