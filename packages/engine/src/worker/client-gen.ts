// The client worker's gen pump (docs/plan/08b-gen-workers-and-queue.md, Order of work 4; Planning
// decisions 2, 5): called from `worker/client.ts`'s `body()` after `frame`, on every wake (the
// orchestrator's own decision: `gen_take` costs nothing and returns 0 on a page whose client role
// has no `TerrainFeed`, so this file runs unconditionally rather than only when a frame was
// requested). Per worker: drain `genResult[i]` into the `GenIn` region and `gen_deliver`; then,
// while a `genRequest[i]` slot is free and `gen_take` says there is a job (claim first, take
// second: 0008 §4's backpressure), copy the 16-byte request out of `Result` and commit, which wakes
// the gen worker through its own `W_WAKE` (the request producer is constructed with it).

import { Status } from '../abi.js'
import type { EngineInstance, RegionView } from '../loader.js'
import { at, copyBytes } from '../sab/bytes.js'
import { type ControlBlock, WORKER_GEN0 } from '../sab/control.js'
import type { SabSet } from '../sab/layout.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'

const REQUEST_BYTES = 16

type WorkerPump = {
  requests: RingProducer
  results: RingConsumer
}

export type GenPump = { pump(): void }

/** Built once at setup (one `RingProducer`/`RingConsumer` pair per configured gen worker); `pump()`
 * itself allocates nothing. `genIn` is `null` for a client role with no `RegionId.GenIn` (no
 * `client::TerrainFeed`, e.g. `fx-hash`): the drain side is then skipped, which is always correct
 * there, since a `gen_take` that always returns 0 never causes a request -- and therefore never a
 * result -- to exist in the first place. */
export function createGenPump(
  inst: EngineInstance,
  control: ControlBlock,
  sabs: SabSet,
  genIn: RegionView | null,
  result: RegionView,
  fatal: (message: string) => void,
): GenPump {
  const pumps: WorkerPump[] = []
  for (let i = 0; i < sabs.genRequest.length; i++) {
    pumps.push({
      requests: new RingProducer(at(sabs.genRequest, i), { control, index: WORKER_GEN0 + i }),
      results: new RingConsumer(at(sabs.genResult, i)),
    })
  }

  function pump(): void {
    for (let i = 0; i < pumps.length; i++) {
      const w = at(pumps, i)
      if (genIn) {
        for (;;) {
          const len = w.results.popInto(genIn.u8, 0)
          if (len < 0) break
          const status = inst.call2(inst.x.gen_deliver, i, len)
          // Discarding this status let a bad-length or unsupported delivery fail silently. The
          // message is built only here, on the failure branch, never on the (allocation-free) OK
          // path (`.claude/rules/hot-paths.md`): a fixture with no `client::TerrainFeed` never
          // reaches this call at all, since `genIn` is `null` there (see this file's own doc
          // comment), so this can only ever fire for a real `TerrainFeed`.
          if (status !== Status.Ok) {
            fatal(`client gen pump: gen_deliver(worker=${i}, len=${len}) failed: status ${status}`)
            return
          }
        }
      }
      for (;;) {
        const claimed = w.requests.tryClaim()
        if (claimed < 0) break
        const took = inst.call1(inst.x.gen_take, i)
        if (took !== 1) break
        copyBytes(w.requests.slotView(claimed), 0, result.u8, 0, REQUEST_BYTES)
        w.requests.commit()
      }
    }
  }

  return { pump }
}
