// `release-golden @slow` (docs/plan/36-slow-tier-and-benchmarks.md; docs/decisions/0017 §9): every
// golden log and scenario, replayed on the plain `release` module of its crate (no `wasm-opt`, no
// `+simd128`: M36b's), against the checked-in hashes the dev module also meets. Node here; the same
// replay under Bun is `release-golden-bun.mjs`, spawned once the four release builds exist.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, test } from 'vitest'
import { buildGame } from '../../src/build-game.js'
import { instantiate } from '../../src/loader.js'
import { loadGame } from '../../src/server-node.js'
import { replayLog } from '../../src/test/replay.js'
import { fixtureDir } from '../support/fixtures.js'
import { type GoldenDirs, runGoldens } from '../support/release-golden.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const BUN_LEG = fileURLToPath(new URL('./release-golden-bun.mjs', import.meta.url))

let dirs: GoldenDirs

// Four cold `release` builds (fat LTO): bounded explicitly, like every cargo-building hook here.
beforeAll(async () => {
  const build = async (crate: string): Promise<string> =>
    (await buildGame({ crate, profile: 'release' })).dir
  dirs = {
    hash: await build(fixtureDir('hash')),
    worldgen: await build(fixtureDir('worldgen')),
    persist: await build(fixtureDir('persist')),
    reference: await build(join(REPO, 'games/reference/sim')),
  }
}, 900_000)

function failures(results: { name: string; ok: boolean; message: string | null }[]): string[] {
  return results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.message}`)
}

test('release-golden @slow', async () => {
  expect(dirs.reference).toContain('release')
  expect(dirs.reference).not.toContain('+')
  const node = await runGoldens({ instantiate, loadGame, replayLog }, dirs)
  expect(node.length).toBe(4)
  expect(failures(node)).toEqual([])

  const bun = spawnSync('bun', [BUN_LEG, JSON.stringify(dirs)], {
    encoding: 'utf8',
    timeout: 300_000,
  })
  expect(bun.error, 'spawning bun (pnpm setup:tools installs it)').toBeUndefined()
  const line = bun.stdout.trim().split('\n').at(-1) ?? ''
  const parsed = JSON.parse(line) as { results: typeof node }
  expect(parsed.results.length).toBe(4)
  expect(failures(parsed.results)).toEqual([])
}, 600_000)
