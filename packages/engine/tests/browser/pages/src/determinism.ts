// `determinism.html`'s script: runs the cross-engine golden scenario (docs/decisions/0002 §3, 0020
// §5) for every fixture in `FIXTURES` below, each in the dedicated worker (`determinism-worker.ts`),
// and shows a PASS/FAIL banner per fixture plus the user agent and `crossOriginIsolated`
// (M03, Planning decisions "Determinism on a physical phone"; the
// manual device check reads this page directly). `determinism.spec.ts` reads each fixture's
// `golden/golden.json` in Node and only trusts `window.__determinism`'s freshly-computed
// checkpoints, never this page's own bundled copies of the goldens.
import wasm from 'virtual:engine/wasm'
import referenceGolden from '../../../../../../games/reference/tests/golden/full-game.json' with {
  type: 'json',
}
import referenceLogUrl from '../../../../../../games/reference/tests/golden/full-game.log?url'
import goldenHash from '../../../../fixtures/hash/golden/golden.json' with { type: 'json' }
import scenarioHash from '../../../../fixtures/hash/golden/scenario.json' with { type: 'json' }
import goldenWorldgen from '../../../../fixtures/worldgen/golden/golden.json' with { type: 'json' }
import scenarioWorldgen from '../../../../fixtures/worldgen/golden/scenario.json' with {
  type: 'json',
}
import type { HashScenario } from '../../../support/scenario.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __determinism?: {
      fixtures: Record<string, { checkpoints: string[]; pass: boolean }>
      userAgent: string
      crossOriginIsolated: boolean
    }
    /** M36b `feature-matrix`: the same worker, any module's bytes (base64) and scenario or log from
     * Node; checkpoints back, compared by `determinism.spec.ts`. */
    __determinismVariant?: {
      run(wasmB64: string, scenario: HashScenario): Promise<string[]>
      replay(
        wasmB64: string,
        params: { seed: string; worldgen: unknown },
        framesB64: string,
        ticks: number[],
      ): Promise<string[]>
    }
    __pageReady?: true
  }
}

type FromWorker = { type: 'result'; checkpoints: string[] } | { type: 'error'; message: string }
type ToWorker =
  | { type: 'run'; module: WebAssembly.Module; scenario: HashScenario }
  | {
      type: 'replay'
      module: WebAssembly.Module
      params: { seed: string; worldgen: unknown }
      frames: Uint8Array
      ticks: number[]
    }

type Entry = {
  name: string
  scenario: HashScenario
  golden: { checkpoints: string[] }
  /** `hash` loads through the real virtual module (the page's own crate); every other fixture
   * loads through `fixtureWasm` (`wiring.html`/`gc-loop.html`'s own comment explains why one page
   * can only have one real virtual module). */
  wasm: { url: string }
}

const entries: Entry[] = [
  { name: 'hash', scenario: scenarioHash as HashScenario, golden: goldenHash, wasm },
  {
    name: 'worldgen',
    scenario: scenarioWorldgen as HashScenario,
    golden: goldenWorldgen,
    wasm: await fixtureWasm('worldgen'),
  },
]

const worker = new Worker(new URL('./determinism-worker.js', import.meta.url), { type: 'module' })

function ask(message: ToWorker): Promise<FromWorker> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<FromWorker>) => resolve(ev.data)
    worker.onerror = (e) => reject(new Error(`determinism worker error: ${e.message}`))
    worker.postMessage(message)
  })
}

function runOn(module: WebAssembly.Module, scenario: HashScenario): Promise<FromWorker> {
  return ask({ type: 'run', module, scenario })
}

const fixtures: Record<string, { checkpoints: string[]; pass: boolean }> = {}
const lines: string[] = []
for (const entry of entries) {
  const res = await fetch(entry.wasm.url)
  const module = await WebAssembly.compileStreaming(res)
  const outcome = await runOn(module, entry.scenario)
  if (outcome.type === 'error') throw new Error(`${entry.name}: ${outcome.message}`)

  const checkpoints = outcome.checkpoints
  const goldenCheckpoints = entry.golden.checkpoints
  const mismatch = checkpoints.findIndex((c, i) => c !== goldenCheckpoints[i])
  const pass = mismatch === -1 && checkpoints.length === goldenCheckpoints.length
  fixtures[entry.name] = { checkpoints, pass }

  lines.push(`${entry.name}: ${pass ? 'PASS' : 'FAIL'}`)
  lines.push(
    ...checkpoints.map((c, i) => {
      const g = goldenCheckpoints[i] ?? '(missing)'
      return `  ${i}: ${c} ${c === g ? '==' : '!='} ${g}`
    }),
  )
}

// M34b: the reference game's full-game golden log, replayed from genesis in the same worker; one hash
// per checkpoint tick of `full-game.json`, compared by `determinism.spec.ts` (Node reads the file).
{
  const ref = await fixtureWasm('reference')
  const module = await WebAssembly.compileStreaming(await fetch(ref.url))
  const frames = new Uint8Array(await (await fetch(referenceLogUrl)).arrayBuffer())
  const want = referenceGolden.checkpoints.map((c) => c.hash)
  const outcome = await ask({
    type: 'replay',
    module,
    params: { seed: referenceGolden.seed, worldgen: referenceGolden.worldgen },
    frames,
    ticks: referenceGolden.checkpoints.map((c) => c.tick),
  })
  if (outcome.type === 'error') throw new Error(`reference: ${outcome.message}`)
  const pass =
    outcome.checkpoints.length === want.length && outcome.checkpoints.every((c, i) => c === want[i])
  fixtures.reference = { checkpoints: outcome.checkpoints, pass }
  lines.push(`reference (full-game.log): ${pass ? 'PASS' : 'FAIL'}`)
}

const fromB64 = (b64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const settle = (outcome: FromWorker): string[] => {
  if (outcome.type === 'error') throw new Error(outcome.message)
  return outcome.checkpoints
}
window.__determinismVariant = {
  async run(wasmB64, scenario) {
    return settle(await runOn(await WebAssembly.compile(fromB64(wasmB64)), scenario))
  },
  async replay(wasmB64, params, framesB64, ticks) {
    const module = await WebAssembly.compile(fromB64(wasmB64))
    return settle(await ask({ type: 'replay', module, params, frames: fromB64(framesB64), ticks }))
  },
}

window.__determinism = {
  fixtures,
  userAgent: navigator.userAgent,
  crossOriginIsolated: window.crossOriginIsolated,
}

const overall = Object.values(fixtures).every((f) => f.pass) ? 'PASS' : 'FAIL'
const result = document.getElementById('result')
if (result) {
  result.textContent = [
    overall,
    `crossOriginIsolated: ${window.crossOriginIsolated}`,
    `userAgent: ${navigator.userAgent}`,
    '',
    ...lines,
  ].join('\n')
}

window.__pageReady = true
