// `worldgen-bench.html`'s worker: runs `tests/support/bench-worldgen.ts`'s warm-up + timed loop in
// a plain worker (docs/decisions/0008-chunk-generation.md §6, Manual device checks: M08 worldgen
// ms per chunk).
import { RegionId, Role } from '../../../../src/abi.ts'
import type { InstanceConfig } from '../../../../src/loader.ts'
import { instantiate } from '../../../../src/loader.ts'
import { runWorldgenBench } from '../../../support/bench-worldgen.ts'

type ToWorker = { type: 'run'; module: WebAssembly.Module; config: InstanceConfig }
type FromWorker =
  | { type: 'result'; medianMs: number; hash: string }
  | { type: 'error'; message: string }

const scope = self as unknown as {
  postMessage(m: FromWorker): void
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
}

scope.onmessage = (ev) => {
  const m = ev.data
  if (m.type !== 'run') return
  try {
    const inst = instantiate(m.module, Role.Gen, m.config, { onLog() {} })
    const region = inst.region(RegionId.GenOut)
    if (!region) throw new Error('worldgen fixture has no GenOut region')
    const { medianMs, hash } = runWorldgenBench(inst, region, () => performance.now())
    scope.postMessage({ type: 'result', medianMs, hash })
  } catch (e) {
    scope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
