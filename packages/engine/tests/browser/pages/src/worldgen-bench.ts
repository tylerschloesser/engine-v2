// `worldgen-bench.html`'s script: median ms/chunk, the golden match, the user agent and
// `navigator.hardwareConcurrency` (docs/decisions/0008-chunk-generation.md §6's deferred "ms per
// chunk on real devices" item, closed by [device-checks.md, M08: Worldgen ms per
// chunk](../../../../../../docs/plan/device-checks.md#m08-worldgen-ms-per-chunk)). Runs the same
// loop as the Node slow test (`tests/wasm/worldgen-bench.test.ts`) via
// `tests/support/bench-worldgen.ts`, in a dedicated worker.
import benchGolden from '../../../../fixtures/worldgen/golden/bench.json' with { type: 'json' }
import type { InstanceConfig } from '../../../../src/loader.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __worldgenBench?: {
      medianMs: number
      hash: string
      pass: boolean
      userAgent: string
      hardwareConcurrency: number
    }
    __pageReady?: true
  }
}

type ToWorker = { type: 'run'; module: WebAssembly.Module; config: InstanceConfig }
type FromWorker =
  | { type: 'result'; medianMs: number; hash: string }
  | { type: 'error'; message: string }

const wasm = await fixtureWasm('worldgen')
const res = await fetch(wasm.url)
const module = await WebAssembly.compileStreaming(res)

const worker = new Worker(new URL('./worldgen-bench-worker.js', import.meta.url), {
  type: 'module',
})
const outcome = await new Promise<FromWorker>((resolve, reject) => {
  worker.onmessage = (ev: MessageEvent<FromWorker>) => resolve(ev.data)
  worker.onerror = (e) => reject(new Error(`worldgen-bench worker error: ${e.message}`))
  worker.postMessage({
    type: 'run',
    module,
    config: benchGolden.config as InstanceConfig,
  } satisfies ToWorker)
})
if (outcome.type === 'error') throw new Error(outcome.message)

const pass = outcome.hash === benchGolden.hash
window.__worldgenBench = {
  medianMs: outcome.medianMs,
  hash: outcome.hash,
  pass,
  userAgent: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency,
}

const result = document.getElementById('result')
if (result) {
  result.textContent = [
    pass ? 'PASS' : 'FAIL',
    `median ms/chunk: ${outcome.medianMs.toFixed(4)}`,
    `hash: ${outcome.hash} ${pass ? '==' : '!='} ${benchGolden.hash}`,
    `userAgent: ${navigator.userAgent}`,
    `hardwareConcurrency: ${navigator.hardwareConcurrency}`,
  ].join('\n')
}

window.__pageReady = true
