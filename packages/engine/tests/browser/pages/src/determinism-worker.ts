// The bare worker of docs/decisions/0020 §5 ("a bare page with the .wasm in a worker"): instantiate
// once, run the whole cross-engine golden scenario with `tests/support/scenario.ts`'s own driver
// (`runGoldenScenario`, the function the Node leg runs every discovered golden with: one instance of
// the scenario's role, or for a `script` scenario a sim instance plus a client-role encoder, M57),
// reply with the checkpoints. No harness/SAB
// machinery: `sim_admit` runs on every 7th tick throughout 10,000 ticks, for which the harness's
// postMessage-only `admit` (park-required, setup-rate) would be far too slow.
import { instantiate } from '../../../../src/loader.ts'
import { replayLog } from '../../../../src/test/replay.ts'
import { type HashScenario, runGoldenScenario } from '../../../support/scenario.ts'

/** `replay`: a recorded log (M34b's reference full-game golden) replayed from genesis, one hash per
 * checkpoint tick, through `replayLog` (the same driver the Node and Bun legs use). */
type ToWorker =
  | { type: 'run'; module: WebAssembly.Module; scenario: HashScenario }
  | {
      type: 'replay'
      module: WebAssembly.Module
      params: { seed: string; worldgen: unknown; maxLines?: number; maxItems?: number }
      frames: Uint8Array
      ticks: number[]
    }
type FromWorker = { type: 'result'; checkpoints: string[] } | { type: 'error'; message: string }

const scope = self as unknown as {
  postMessage(m: FromWorker): void
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
}

scope.onmessage = (ev) => {
  const m = ev.data
  if (m.type === 'replay') {
    replayLog({ wasm: m.module, params: m.params, frames: m.frames, checkpoints: m.ticks }).then(
      (got) => scope.postMessage({ type: 'result', checkpoints: got.map((c) => c.hash) }),
      (e) =>
        scope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return
  }
  if (m.type !== 'run') return
  try {
    const checkpoints = runGoldenScenario(instantiate, m.module, m.scenario)
    scope.postMessage({ type: 'result', checkpoints })
  } catch (e) {
    scope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
