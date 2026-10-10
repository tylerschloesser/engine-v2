// The build variants of `feature-matrix @slow` (M36b, M02's
// hand-over, 0002 Consequences): the reference game and every golden fixture on `release` (a) plain,
// (b) `wasmOpt: true`, (c) `RUSTFLAGS=-C target-feature=+simd128`, each through `buildGame` with its
// own `outDir`, so a variant never overwrites the `target/engine/release` directory the plain-module
// tests (`release-golden`, the reference server helper) read. Shared by the wasm test and the
// determinism spec; each process builds a variant once (cargo is a no-op the second time).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BuildGameResult, buildGame } from '../../src/build-game.js'
import { fixtureDir } from './fixtures.js'

export type VariantName = 'plain' | 'wasm-opt' | 'simd128'
export const VARIANTS: readonly VariantName[] = ['plain', 'wasm-opt', 'simd128']
export type CrateKey = 'hash' | 'worldgen' | 'persist' | 'reference'
export const CRATE_KEYS: readonly CrateKey[] = ['hash', 'worldgen', 'persist', 'reference']

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

export const CRATES: Record<CrateKey, string> = {
  hash: fixtureDir('hash'),
  worldgen: fixtureDir('worldgen'),
  persist: fixtureDir('persist'),
  reference: join(REPO, 'games/reference/sim'),
}

/** Its own cargo target directory: a changed `RUSTFLAGS` would otherwise rebuild the plain
 * variant's artifacts every time the two alternate. */
export const SIMD_TARGET_DIR = join(REPO, 'target', 'feature-matrix-simd')
export const SIMD_RUSTFLAGS = '-C target-feature=+simd128'

export type Built = {
  variant: VariantName
  key: CrateKey
  /** `game.wasm` and `game.json`, a private directory. */
  dir: string
  /** The bytes, read back and checked against `buildHash`. */
  bytes: Uint8Array<ArrayBuffer>
  result: BuildGameResult
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const variantDir = (variant: VariantName, key: CrateKey): string =>
  join(tmpdir(), 'engine-feature-matrix', variant, key)

const memo = new Map<string, Promise<Built>>()

async function build(variant: VariantName, key: CrateKey): Promise<Built> {
  const outDir = variantDir(variant, key)
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await buildGame({
      crate: CRATES[key],
      profile: 'release',
      outDir,
      ...(variant === 'wasm-opt' ? { wasmOpt: true } : {}),
      ...(variant === 'simd128'
        ? {
            env: {
              ...process.env,
              RUSTFLAGS: SIMD_RUSTFLAGS,
              CARGO_TARGET_DIR: SIMD_TARGET_DIR,
            },
          }
        : {}),
    })
    // Another process (the browser suite) may be writing the same variant directory with the same
    // bytes; only a read that is not the build's own is retried.
    const bytes = readFileSync(result.wasmPath)
    if (sha256(bytes) === result.buildHash) return { variant, key, dir: outDir, bytes, result }
  }
  throw new Error(`${variant} build of ${key} kept changing under us`)
}

/** One variant of one crate, built at most once per process. */
export function buildVariant(variant: VariantName, key: CrateKey): Promise<Built> {
  const id = `${variant}/${key}`
  let p = memo.get(id)
  if (!p) {
    p = build(variant, key)
    memo.set(id, p)
  }
  return p
}
