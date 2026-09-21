// The client worker's input-drain pump (docs/plan/11-camera-and-input.md, Order of work step 5):
// called from `worker/client.ts`'s `body()` after the frame/gen/upload pumps, on every wake (same
// "built once at setup, pump() itself allocates nothing" shape `client-gen.ts`/`client-upload.ts`
// already use). Drains whole `inputRing` records into `Rx` and calls `on_input(len)` once when
// there is anything new -- `rx` is `null` for a client role with no `RegionId.Rx` for input (most
// fixtures today; `fixtures/hash`'s own `Rx` is unconditional but unrelated, its `echo` test path,
// so `on_input` there just answers `Status.Unsupported` on the rare occasion this ever calls it,
// which in practice never happens: nothing feeds `inputRing` on that fixture's own test pages).

import { INPUT_RECORD_BYTES } from '../input/record.js'
import type { EngineInstance, RegionView } from '../loader.js'
import { RingConsumer } from '../sab/ring.js'

export type InputPump = { pump(): void }

export function createInputPump(
  inst: EngineInstance,
  inputRingSab: SharedArrayBuffer,
  rx: RegionView | null,
): InputPump {
  const ring = new RingConsumer(inputRingSab)
  const capacityBytes = rx ? rx.u8.length : 0

  function pump(): void {
    if (!rx) return
    let offset = 0
    for (;;) {
      if (offset + INPUT_RECORD_BYTES > capacityBytes) break
      const len = ring.popInto(rx.u8, offset)
      if (len < 0) break
      offset += len
    }
    if (offset > 0) inst.call1(inst.x.on_input, offset)
  }

  return { pump }
}
