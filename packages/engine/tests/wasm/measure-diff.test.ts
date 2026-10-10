// `measure-diff` compiles out (M36b, `.claude/rules/hot-paths.md`):
// the engine's cargo feature adds the byte-mask counters of `host/measure_diff.rs`, and a build
// without the feature carries none of that code. Read from the `release-names` profile (names kept,
// like `ts-rs zero bytes`): the feature build is the positive control that the symbol is findable at
// all, the plain build must not have it. The feature build also differs from the plain one, so a
// `measure-diff` module can never be mistaken for the shipped one (a different `buildHash`).
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { buildGame } from '../../src/build-game.js'
import { REFERENCE_SIM } from '../support/bench-build.js'

const SYMBOL = Buffer.from('measure_diff')

test('measure-diff compiles out of a normal build @slow', async () => {
  const plain = await buildGame({ crate: REFERENCE_SIM, profile: 'release-names' })
  const counted = await buildGame({
    crate: REFERENCE_SIM,
    profile: 'release-names',
    features: ['measure-diff'],
  })
  const withFeature = readFileSync(counted.wasmPath)
  const without = readFileSync(plain.wasmPath)
  expect(withFeature.includes(SYMBOL), 'control: the feature build names the counter code').toBe(
    true,
  )
  expect(without.includes(SYMBOL), 'the normal build has no counter code').toBe(false)
  expect(counted.buildHash).not.toBe(plain.buildHash)
}, 240_000)
