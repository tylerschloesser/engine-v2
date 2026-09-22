// The client worker's action/UI-result pump (docs/plan/16-action-round-trip.md, step 3): built
// once at setup, run every wake, the same "costs nothing, answers nothing" shape as `client-gen.
// ts`/`client-upload.ts`/`client-input.ts`. Drains `actionRing` (main's `dispatch()` writes) into
// `on_action(len)` over `RegionId.Rx` (shared with `on_input`'s own, differently-shaped records --
// a different message kind on the same client-role receive buffer), then drains `client_poll_ui`'s
// own output onto `uiRing` for main's per-rAF drain (`client.ts`) to pick up. Unrelated to
// `worker/client.ts`'s own `echo`-gated test-only actionRing/uiRing usage (the `gc-echo` page's SAB
// -> region -> region -> SAB round trip): that path never calls `on_action`/`client_poll_ui` at
// all, and the two are mutually exclusive (`worker/client.ts`'s `setup()` builds this pump only
// when `echo` is not set).
import type { EngineInstance, RegionView } from '../loader.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'

export type ActionPump = { pump(): void }

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

  function pump(): void {
    if (rx) {
      for (;;) {
        const len = actionConsumer.popInto(rx.u8, 0)
        if (len < 0) break
        inst.call1(inst.x.on_action, len)
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

  return { pump }
}
