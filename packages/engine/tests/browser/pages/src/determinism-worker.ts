// The bare worker of docs/decisions/0020 §5 ("a bare page with the .wasm in a worker"): instantiate
// once, run the whole cross-engine golden scenario with `tests/support/scenario.ts`'s own driver
// (the same function the native, Node and Bun legs use), reply with the checkpoints. No harness/SAB
// machinery: `sim_admit` runs on every 7th tick throughout 10,000 ticks, for which the harness's
// postMessage-only `admit` (park-required, setup-rate) would be far too slow.
import { Role } from '../../../../src/abi.ts'
import { instantiate } from '../../../../src/loader.ts'
import { type HashScenario, runHashScenario } from '../../../support/scenario.ts'

type ToWorker = { type: 'run'; module: WebAssembly.Module; scenario: HashScenario }
type FromWorker = { type: 'result'; checkpoints: string[] } | { type: 'error'; message: string }

const scope = self as unknown as {
  postMessage(m: FromWorker): void
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
}

scope.onmessage = (ev) => {
  const m = ev.data
  if (m.type !== 'run') return
  try {
    const inst = instantiate(m.module, Role.Sim, m.scenario.config, { onLog() {} })
    const checkpoints = runHashScenario(inst, m.scenario)
    scope.postMessage({ type: 'result', checkpoints })
  } catch (e) {
    scope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
