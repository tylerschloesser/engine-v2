// The golden hashes of every recorded log and scenario, replayed against whichever build the caller
// names (docs/plan/36-slow-tier-and-benchmarks.md, `release-golden @slow`; docs/decisions/0017 §9: a
// replay of the golden hashes on the release module). Runtime-light like `reference-golden.ts`:
// Node (Vitest) and Bun (`release-golden-bun.mjs`) load it as it is, so the loader entry points come
// in through `api` rather than from `src/` or `dist/`, and each runtime keeps one module graph.
//
// Four goldens, each against checked-in hashes only (nothing is regenerated here):
//   - `fx-hash` scenario (`fixtures/hash/golden/`): sim-role tick checkpoints, zero grows.
//   - `fx-worldgen` scenario (`fixtures/worldgen/golden/`): gen-role chunk hashes.
//   - `fx-persist` recorded log (`fixtures/persist/tests/golden/persist_fixture_log.hex`), five checkpoints.
//   - the reference game's `full-game.log` (M34b), 71 checkpoints.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Role } from '../../src/abi.ts'
import type { EngineInstance, InstanceConfig } from '../../src/loader.ts'
import {
  type Checkpoint,
  divergenceMessage,
  firstDivergence,
  readFullGame,
} from './reference-golden.ts'
import {
  diffCheckpoints,
  type Golden,
  type HashScenario,
  roleOf,
  runHashScenario,
} from './scenario.ts'

export type GoldenApi = {
  instantiate: (
    wasm: WebAssembly.Module,
    role: Role,
    config: InstanceConfig,
    hooks?: { onLog?: () => void },
  ) => EngineInstance
  loadGame: (dir: string) => Promise<{ wasm: WebAssembly.Module }>
  replayLog: (opts: {
    wasm: WebAssembly.Module
    params: { seed: string; worldgen: unknown }
    frames: Uint8Array
    checkpoints: number[]
  }) => Promise<Checkpoint[]>
}

/** One build directory (`buildGame`'s `dir`) per golden crate. */
export type GoldenDirs = { hash: string; worldgen: string; persist: string; reference: string }

export type GoldenResult = { name: string; ok: boolean; message: string | null }

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url))
const PERSIST_GOLDEN = `${FIXTURES}persist/tests/golden/`

/** `fx-persist`'s world: `replay-world.test.ts`'s own `CFG.params`. */
export const PERSIST_PARAMS = { seed: '42', worldgen: null }

/** `assert_golden_bytes!`'s hex format: every whitespace byte stripped. */
export function readPersistLog(name = 'persist_fixture_log'): Uint8Array {
  const hex = readFileSync(`${PERSIST_GOLDEN}${name}.hex`, 'utf8').replace(/\s+/g, '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** `record()`'s own checkpoints, read from the checked-in golden files. */
export function persistCheckpoints(): Checkpoint[] {
  const read = (name: string): string =>
    readFileSync(`${PERSIST_GOLDEN}${name}.hash`, 'utf8').trim()
  return [0, 1, 2, 3, 4].map((i) => ({
    tick: Number(BigInt(`0x${read(`persist_fixture_checkpoint_${i}_tick`)}`)),
    hash: read(`persist_fixture_checkpoint_${i}_hash`),
  }))
}

function readFixtureGolden<T>(name: string, file: string): T {
  return JSON.parse(readFileSync(`${FIXTURES}${name}/golden/${file}`, 'utf8')) as T
}

async function scenarioResult(
  api: GoldenApi,
  name: string,
  fixture: 'hash' | 'worldgen',
  dir: string,
): Promise<GoldenResult> {
  const scenario = readFixtureGolden<HashScenario>(fixture, 'scenario.json')
  const golden = readFixtureGolden<Golden>(fixture, 'golden.json')
  const { wasm } = await api.loadGame(dir)
  const inst = api.instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} })
  const checkpoints = runHashScenario(inst, scenario)
  const message =
    diffCheckpoints(checkpoints, golden.checkpoints) ??
    (fixture === 'worldgen' || inst.memGrows() === 0
      ? null
      : `${name}: memory grew ${inst.memGrows()} times after init`)
  return { name, ok: message === null, message }
}

/** Replays every golden against the builds in `dirs`; one result per golden, none thrown. */
export async function runGoldens(api: GoldenApi, dirs: GoldenDirs): Promise<GoldenResult[]> {
  const results: GoldenResult[] = []
  const attempt = async (name: string, run: () => Promise<GoldenResult>): Promise<void> => {
    try {
      results.push(await run())
    } catch (e) {
      results.push({ name, ok: false, message: String((e as Error)?.stack ?? e) })
    }
  }
  await attempt('fx-hash scenario', () =>
    scenarioResult(api, 'fx-hash scenario', 'hash', dirs.hash),
  )
  await attempt('fx-worldgen scenario', () =>
    scenarioResult(api, 'fx-worldgen scenario', 'worldgen', dirs.worldgen),
  )
  await attempt('fx-persist log', async () => {
    const { wasm } = await api.loadGame(dirs.persist)
    const want = persistCheckpoints()
    const got = await api.replayLog({
      wasm,
      params: PERSIST_PARAMS,
      frames: readPersistLog(),
      checkpoints: want.map((c) => c.tick),
    })
    const message = divergenceMessage(firstDivergence(got, want))
    return { name: 'fx-persist log', ok: message === null, message }
  })
  await attempt('reference full-game log', async () => {
    const { meta, frames } = readFullGame()
    const { wasm } = await api.loadGame(dirs.reference)
    const got = await api.replayLog({
      wasm,
      params: { seed: meta.seed, worldgen: meta.worldgen },
      frames,
      checkpoints: meta.checkpoints.map((c) => c.tick),
    })
    const message = divergenceMessage(firstDivergence(got, meta.checkpoints))
    return { name: 'reference full-game log', ok: message === null, message }
  })
  return results
}
