// `buildGame({ wasmOpt })` (docs/decisions/0017 §5; M35: `wasm-opt`
// runs when asked and found on `PATH`, hashing happens afterwards, and `game.json` says so
// (`wasmOpt`). Requested but missing: one named warning, `wasm-opt-missing`, and the build goes on.
// `fx-persist` on the release profile is the module: no other test builds that directory.
//
// When no `wasm-opt` is on `PATH` the executing test prints `wasm-opt-missing` and passes, like
// `deno-adapter @slow`; `REQUIRE_WASM_OPT=1` makes it fail instead (CI sets it once it installs
// binaryen). The missing-tool test needs no tool and always runs.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { type BuildGameResult, buildGame, type GameJson } from '../../src/build-game.js'
import { fixtureDir } from '../support/fixtures.js'

const CRATE = fixtureDir('persist')
const OUT_DIR = join(CRATE, 'target', 'engine', 'release')

const hasWasmOpt = (dir: string): boolean => {
  try {
    accessSync(join(dir, 'wasm-opt'), constants.X_OK)
    return true
  } catch {
    return false
  }
}
const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
const onPath = pathDirs.some(hasWasmOpt)

const json = (): GameJson => JSON.parse(readFileSync(join(OUT_DIR, 'game.json'), 'utf8'))
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

afterAll(async () => {
  await rm(OUT_DIR, { recursive: true, force: true })
})

test('build: wasm-opt requested but missing warns and proceeds @slow', async () => {
  // Every PATH directory that holds a `wasm-opt` is dropped; cargo still finds its own.
  const env = { ...process.env, PATH: pathDirs.filter((d) => !hasWasmOpt(d)).join(delimiter) }
  const result = await buildGame({ crate: CRATE, profile: 'release', wasmOpt: true, env })
  expect(result.wasmOpt).toBe(false)
  expect(result.warnings.map((w) => w.code)).toEqual(['wasm-opt-missing'])
  expect(json().wasmOpt, 'game.json says it did not run').toBe(false)
  expect(json().buildHash, 'unoptimised bytes are what is hashed').toBe(
    sha256(readFileSync(result.wasmPath)),
  )
}, 600_000)

test('build: wasm-opt changes hash and sets game.json @slow', async () => {
  if (!onPath) {
    console.warn(
      'wasm-opt-missing: no wasm-opt on PATH; the executing half of this test did not run',
    )
    expect(process.env.REQUIRE_WASM_OPT, 'REQUIRE_WASM_OPT=1 but no wasm-opt on PATH').not.toBe('1')
    return
  }
  const plain: BuildGameResult = await buildGame({ crate: CRATE, profile: 'release' })
  expect(plain.wasmOpt).toBe(false)
  expect(json().wasmOpt, 'not requested: false').toBe(false)
  const plainBytes = readFileSync(plain.wasmPath)

  const opt = await buildGame({ crate: CRATE, profile: 'release', wasmOpt: true })
  expect(opt.warnings).toEqual([])
  expect(opt.wasmOpt).toBe(true)
  const optBytes = readFileSync(opt.wasmPath)
  expect(optBytes.length, 'wasm-opt made the module smaller').toBeLessThan(plainBytes.length)
  expect(opt.buildHash, 'the hash is of the optimised bytes').toBe(sha256(optBytes))
  expect(opt.buildHash).not.toBe(plain.buildHash)
  expect(json()).toEqual({
    buildHash: opt.buildHash,
    abiVersion: plain.abiVersion,
    profile: 'release',
    wasmOpt: true,
  })

  // Still the module the loader accepts: the same imports, and a valid, instantiable binary.
  const imports = (b: Uint8Array) =>
    WebAssembly.Module.imports(new WebAssembly.Module(new Uint8Array(b))).map(
      (i) => `${i.module}.${i.name}`,
    )
  expect(imports(optBytes)).toEqual(imports(plainBytes))
  expect(execFileSync('wasm-opt', ['--version']).toString()).toMatch(/^wasm-opt version \d+/)
}, 600_000)
