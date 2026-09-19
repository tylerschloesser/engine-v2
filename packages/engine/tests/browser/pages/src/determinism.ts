// `determinism.html`'s script: runs the cross-engine golden scenario (docs/decisions/0002 §3, 0020
// §5) in a dedicated worker (`determinism-worker.ts`) and shows a PASS/FAIL banner next to each
// checkpoint, the user agent and `crossOriginIsolated` (docs/plan/03-browser-harness.md, Planning
// decisions "Determinism on a physical phone"; the manual device check reads this page directly).
// `determinism.spec.ts` reads `golden/golden.json` in Node and only trusts `window.__determinism`'s
// freshly-computed `checkpoints`, never this page's own bundled copy of the golden.
import wasm from 'virtual:engine/wasm'
import golden from '../../../../fixtures/hash/golden/golden.json' with { type: 'json' }
import scenario from '../../../../fixtures/hash/golden/scenario.json' with { type: 'json' }
import type { HashScenario } from '../../../support/scenario.ts'

declare global {
  interface Window {
    __determinism?: {
      checkpoints: string[]
      userAgent: string
      crossOriginIsolated: boolean
    }
    __pageReady?: true
  }
}

type FromWorker = { type: 'result'; checkpoints: string[] } | { type: 'error'; message: string }

const res = await fetch(wasm.url)
const module = await WebAssembly.compileStreaming(res)

const worker = new Worker(new URL('./determinism-worker.js', import.meta.url), { type: 'module' })
const outcome = await new Promise<FromWorker>((resolve, reject) => {
  worker.onmessage = (ev: MessageEvent<FromWorker>) => resolve(ev.data)
  worker.onerror = (e) => reject(new Error(`determinism worker error: ${e.message}`))
  worker.postMessage({ type: 'run', module, scenario: scenario as HashScenario })
})
if (outcome.type === 'error') throw new Error(outcome.message)

const checkpoints = outcome.checkpoints
window.__determinism = {
  checkpoints,
  userAgent: navigator.userAgent,
  crossOriginIsolated: window.crossOriginIsolated,
}

const goldenCheckpoints: string[] = golden.checkpoints
const mismatch = checkpoints.findIndex((c, i) => c !== goldenCheckpoints[i])
const pass = mismatch === -1 && checkpoints.length === goldenCheckpoints.length
const lines = [
  pass ? 'PASS' : 'FAIL',
  `crossOriginIsolated: ${window.crossOriginIsolated}`,
  `userAgent: ${navigator.userAgent}`,
  '',
  ...checkpoints.map((c, i) => {
    const g = goldenCheckpoints[i] ?? '(missing)'
    return `${i}: ${c} ${c === g ? '==' : '!='} ${g}`
  }),
]
const result = document.getElementById('result')
if (result) result.textContent = lines.join('\n')

window.__pageReady = true
