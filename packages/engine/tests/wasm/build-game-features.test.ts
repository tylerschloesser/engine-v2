// `buildGame({ features })` (M34b step 5): the reference
// game built with and without its `test-hooks` feature lands in two directories with two build
// hashes, and the hooks never reach a shipped build: the production (release) `.wasm` of the
// `reference` build step has no poison path, and no config of the game asks for the feature.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, test } from 'vitest'
import { type BuildGameResult, buildGame, type GameJson } from '../../src/build-game.js'
import { gameCrateBuildDir } from '../support/fixtures.js'

const GAME = fileURLToPath(new URL('../../../../games/reference/', import.meta.url))
const POISON = 'test-hooks: poison StartCraft'
const read = (path: string) => readFileSync(path)
const json = (dir: string) => JSON.parse(readFileSync(join(dir, 'game.json'), 'utf8')) as GameJson

// A real cargo build of the hooks variant: cold on CI, and it shares the target-dir lock with
// `reference-test-hooks.test.ts`'s own build in a parallel file, so it runs here with that file's
// bound and both tests read its result (M34b's CI red: 5 s default, then the second test's ENOENT).
let hooks: BuildGameResult
beforeAll(async () => {
  hooks = await buildGame({ crate: join(GAME, 'sim'), features: ['test-hooks'] })
}, 240_000)

test('build-game-features', () => {
  const plain = gameCrateBuildDir('reference')

  expect(hooks.dir).not.toBe(plain)
  expect(hooks.dir.endsWith('dev+test-hooks')).toBe(true)
  expect(hooks.buildHash).not.toBe(json(plain).buildHash)
  expect(json(hooks.dir).features).toEqual(['test-hooks'])
  expect(json(plain).features).toBeUndefined()
  // The hooks build carries the poison path, the normal build does not.
  expect(read(hooks.wasmPath).includes(POISON)).toBe(true)
  expect(read(join(plain, 'game.wasm')).includes(POISON)).toBe(false)
})

test('build-game-features: the shipped reference build has no test-hooks', () => {
  // `vite build` (the `reference` build step, release profile): neither the plugin call nor the
  // manifest nor the package scripts name the feature, and the built `.wasm` has no poison path.
  for (const file of ['vite.config.ts', 'package.json', 'sim/Cargo.toml']) {
    const text = readFileSync(join(GAME, file), 'utf8')
    const hits = text
      .split('\n')
      .filter((l) => l.includes('test-hooks') && !l.trimStart().startsWith('#'))
    expect(hits.filter((l) => /features|default/.test(l) && file !== 'sim/Cargo.toml')).toEqual([])
  }
  const cargo = readFileSync(join(GAME, 'sim/Cargo.toml'), 'utf8')
  expect(cargo).not.toMatch(/^default\s*=/m)
  const release = join(GAME, 'sim/target/engine/release')
  expect(json(release).features).toBeUndefined()
  expect(read(join(release, 'game.wasm')).includes(POISON)).toBe(false)
  expect(json(release).buildHash).not.toBe(json(hooks.dir).buildHash)
}, 60_000)
