// The Bun leg of the cross-runtime golden (docs/decisions/0020 §5): the same loader (`dist/`), the
// same driver and the same golden as `determinism.test.ts`, under JavaScriptCore. Run by the
// `script` adapter of `pnpm test wasm`, which reads the one JSON line printed last:
// `{ tests: [{ name, ok, message? }], ... }`. By hand: `bun packages/engine/tests/wasm/bun-leg.mjs`.
import { RegionId, Role } from '../../dist/abi.js'
import { instantiate } from '../../dist/loader.js'
import { loadGame } from '../../dist/server-node.js'
import { diffCheckpoints, roleOf, runHashScenario } from '../support/scenario.ts'

const NAME = 'determinism: bun matches golden'
const WORLDGEN_NAME = 'determinism: worldgen bun matches golden'
const GROWTH_NAME = 'loader: views survive memory growth (bun)'
const PUTS_NAME = 'wasm_idle_100_matches_native (bun)'

/**
 * The Bun half of decision B (fix round 3, docs/plan/06b-workers-and-spawn.md, Deviations): the
 * loader's detach check is feature-detected at module load (`ArrayBuffer.prototype.detached`, with
 * the `byteLength === 0` fallback), and a runtime where the detection picked the wrong branch would
 * never rebuild its views after `memory.grow` -- silently, since every read would then come from a
 * detached view. `loader.test.ts`'s `loader: views survive memory growth` proves it under Node;
 * this is the same proof under JavaScriptCore. Returns a message, or `null` when it held.
 */
function checkMemoryGrowth(wasm, config) {
  const inst = instantiate(
    wasm,
    Role.Sim,
    { ...config, game: { ...config.game, growAtTick: 2 } },
    { onLog() {} },
  )
  let rebuilds = 0
  inst.onViewsRebuilt(() => rebuilds++)
  const rx = inst.region(RegionId.Rx)
  if (!rx) return 'fx-hash declares an Rx region'
  const beforeRx = rx.u8
  const beforeBytes = inst.memoryBytes()

  inst.call0(inst.x.sim_tick)
  if (inst.memGrows() !== 0 || rebuilds !== 0) return 'memory grew before the tick that grows it'
  inst.call0(inst.x.sim_tick)

  if (inst.memGrows() === 0) return 'memory did not grow at growAtTick'
  if (rebuilds !== 1) return `views were rebuilt ${rebuilds} times, expected 1`
  if (beforeRx.byteLength !== 0) return 'the pre-growth view was not detached'
  if (inst.memoryBytes() <= beforeBytes) return 'memoryBytes() did not increase'
  if (inst.region(RegionId.Rx) !== rx) return 'the region holder was replaced, not rebuilt'
  if (rx.u8.byteLength !== rx.len) return 'the rebuilt region view has the wrong length'
  if (inst.mem.u8.byteLength !== inst.memoryBytes()) return 'the rebuilt memory view is stale'
  return null
}
const fixture = new URL('../../fixtures/hash/', import.meta.url)
const json = async (path, base = fixture) => JSON.parse(await Bun.file(new URL(path, base)).text())

/** The worldgen fixture's own golden, driven through `runHashScenario`'s `gen` branch. */
async function runWorldgenLeg() {
  const worldgenFixture = new URL('../../fixtures/worldgen/', import.meta.url)
  const scenario = await json('golden/scenario.json', worldgenFixture)
  const golden = await json('golden/golden.json', worldgenFixture)
  const { wasm } = await loadGame(new URL('target/engine/dev', worldgenFixture).pathname)
  const inst = instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} })
  const checkpoints = runHashScenario(inst, scenario)
  const message = diffCheckpoints(checkpoints, golden.checkpoints)
  return { name: WORLDGEN_NAME, ok: message === null, message }
}

/** `fx-puts`'s own idle-100 golden (docs/plan/13-sim-host-tick-loop.md step 3), driven through
 * `runHashScenario`'s `sim` branch with `genesis: true`. */
async function runPutsLeg() {
  const putsFixture = new URL('../../fixtures/puts/', import.meta.url)
  const scenario = await json('golden/scenario.json', putsFixture)
  const golden = await json('golden/golden.json', putsFixture)
  const { wasm } = await loadGame(new URL('target/engine/dev', putsFixture).pathname)
  const inst = instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} })
  const checkpoints = runHashScenario(inst, scenario)
  const message = diffCheckpoints(checkpoints, golden.checkpoints)
  return { name: PUTS_NAME, ok: message === null, message }
}

let result
try {
  if (typeof Bun === 'undefined') throw new Error('not running under Bun')
  const scenario = await json('golden/scenario.json')
  const golden = await json('golden/golden.json')
  const { wasm } = await loadGame(new URL('target/engine/dev', fixture).pathname)
  const inst = instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} })
  const checkpoints = runHashScenario(inst, scenario)
  const message =
    diffCheckpoints(checkpoints, golden.checkpoints) ??
    (inst.memGrows() === 0 ? null : `memory grew ${inst.memGrows()} pages after init`)
  const growth = checkMemoryGrowth(wasm, scenario.config)
  const worldgen = await runWorldgenLeg()
  const puts = await runPutsLeg()
  result = {
    tests: [
      { name: NAME, ok: message === null, message },
      { name: GROWTH_NAME, ok: growth === null, message: growth },
      worldgen,
      puts,
    ],
    checkpoints,
  }
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
