// The Bun leg of the cross-runtime golden (docs/decisions/0020 §5): the same loader (`dist/`), the
// same driver and the same golden as `determinism.test.ts`, under JavaScriptCore. Run by the
// `script` adapter of `pnpm test wasm`, which reads the one JSON line printed last:
// `{ tests: [{ name, ok, message? }], ... }`. By hand: `bun packages/engine/tests/wasm/bun-leg.mjs`.
import { RegionId, Role } from '../../dist/abi.js'
import { instantiate } from '../../dist/loader.js'
import { loadGame } from '../../dist/server-node.js'
import { buildSimInstanceConfig } from '../../dist/sim-config.js'
import { memoryStorage } from '../../dist/storage/memory.js'
import { worldKeys } from '../../dist/storage/types.js'
import { replayWorld } from '../../dist/test.js'
import { diffCheckpoints, roleOf, runHashScenario } from '../support/scenario.ts'

const NAME = 'determinism: bun matches golden'
const WORLDGEN_NAME = 'determinism: worldgen bun matches golden'
const GROWTH_NAME = 'loader: views survive memory growth (bun)'
const PUTS_NAME = 'wasm_idle_100_matches_native (bun)'
const REPLAY_NAME = 'replay_world_checkpoints_bun'

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

const persistFixture = new URL('../../fixtures/persist/', import.meta.url)
const persistGoldenDir = new URL('tests/golden/', persistFixture)
const PERSIST_CFG = {
  worldId: 'w1',
  buildHash: 'ab'.repeat(32),
  params: { seed: '42', worldgen: null },
}
const CHECKPOINT_NAMES = [0, 1, 2, 3, 4]

async function readHexGoldenText(name) {
  const text = await Bun.file(new URL(`${name}.hex`, persistGoldenDir)).text()
  return text.replace(/\s+/g, '')
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

async function readHashGolden(name) {
  const text = await Bun.file(new URL(`${name}.hash`, persistGoldenDir)).text()
  return text.trim()
}

/** `replayWorld` against M22's own checked-in fixture log (`fixtures/persist/tests/golden/
 * persist_fixture_log.hex`), wrapped in a synthetic single-segment `MemoryStorage` -- the mirror of
 * `tests/wasm/replay-world.test.ts`'s own `replay_world_checkpoints_node`, run here under
 * JavaScriptCore (0020 §5 "WASM under Node and Bun"). */
async function runReplayLeg() {
  const { wasm } = await loadGame(new URL('target/engine/dev', persistFixture).pathname)
  const inst = instantiate(wasm, Role.Sim, buildSimInstanceConfig(PERSIST_CFG), { onLog() {} })
  const headerLen = inst.call2(inst.x.sim_segment_header, 0, 0xffff_ffff)
  const region = inst.region(RegionId.Persist)
  const header = region.u8.slice(0, headerLen)
  const frames = hexToBytes(await readHexGoldenText('persist_fixture_log'))
  const fullLog = new Uint8Array(header.length + frames.length)
  fullLog.set(header, 0)
  fullLog.set(frames, header.length)

  const storage = memoryStorage()
  const keys = worldKeys(PERSIST_CFG.worldId)
  const dummyIdentity = {
    buildHash: PERSIST_CFG.buildHash,
    engineVersion: '0.0.0',
    gameVersion: '0.0.0',
    schemaVersion: 0,
    tickRateHz: 20,
    worldgen: { version: 0, fingerprint: '0' },
  }
  const manifest = {
    v: 1,
    worldId: PERSIST_CFG.worldId,
    epoch: 0,
    params: PERSIST_CFG.params,
    created: dummyIdentity,
    segments: [
      { index: 0, identity: dummyIdentity, base: 'genesis', sealed: false, tailReexecuted: false },
    ],
  }
  storage.write(keys.manifest, new TextEncoder().encode(JSON.stringify(manifest)))
  storage.write(keys.log(0), fullLog)

  const want = []
  for (const i of CHECKPOINT_NAMES) {
    want.push({
      tick: Number(BigInt(`0x${await readHashGolden(`persist_fixture_checkpoint_${i}_tick`)}`)),
      hash: await readHashGolden(`persist_fixture_checkpoint_${i}_hash`),
    })
  }
  const got = await replayWorld({
    wasm,
    storage,
    worldId: PERSIST_CFG.worldId,
    checkpoints: want.map((c) => c.tick),
  })
  const message =
    JSON.stringify(got) === JSON.stringify(want)
      ? null
      : `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`
  return { name: REPLAY_NAME, ok: message === null, message }
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
  const replay = await runReplayLeg()
  result = {
    tests: [
      { name: NAME, ok: message === null, message },
      { name: GROWTH_NAME, ok: growth === null, message: growth },
      worldgen,
      puts,
      replay,
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
