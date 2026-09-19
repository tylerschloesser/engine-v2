// The Bun leg of the cross-runtime golden (docs/decisions/0020 §5): the same loader (`dist/`), the
// same driver and the same golden as `determinism.test.ts`, under JavaScriptCore. Run by the
// `script` adapter of `pnpm test wasm`, which reads the one JSON line printed last:
// `{ tests: [{ name, ok, message? }], ... }`. By hand: `bun packages/engine/tests/wasm/bun-leg.mjs`.
import { Role } from '../../dist/abi.js'
import { instantiate } from '../../dist/loader.js'
import { loadGame } from '../../dist/server-node.js'
import { diffCheckpoints, runHashScenario } from '../support/scenario.ts'

const NAME = 'determinism: bun matches golden'
const fixture = new URL('../../fixtures/hash/', import.meta.url)
const json = async (path) => JSON.parse(await Bun.file(new URL(path, fixture)).text())

let result
try {
  if (typeof Bun === 'undefined') throw new Error('not running under Bun')
  const scenario = await json('golden/scenario.json')
  const golden = await json('golden/golden.json')
  const { wasm } = await loadGame(new URL('target/engine/dev', fixture).pathname)
  const inst = instantiate(wasm, Role.Sim, scenario.config, { onLog() {} })
  const checkpoints = runHashScenario(inst, scenario)
  const message =
    diffCheckpoints(checkpoints, golden.checkpoints) ??
    (inst.memGrows() === 0 ? null : `memory grew ${inst.memGrows()} pages after init`)
  result = { tests: [{ name: NAME, ok: message === null, message }], checkpoints }
} catch (e) {
  result = { tests: [{ name: NAME, ok: false, message: String(e?.stack ?? e) }] }
}
// Permanent negative control for the `script` adapter: under `pnpm test --self-check-fail` the
// runner must report this leg as a failure.
if (process.env.RUNNER_SELF_CHECK === 'fail') {
  const message = 'runner self-check: deliberate failure'
  result.tests.push({ name: 'runner_negative_control', ok: false, message })
}
result.runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`
console.log(JSON.stringify(result))
process.exit(result.tests.every((t) => t.ok) ? 0 : 1)
