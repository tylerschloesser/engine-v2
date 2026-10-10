// The reference game's `bench` build (M36: the standard large
// save of docs/decisions/0020 §9 behind cargo feature `bench`, never shipped. `buildBench()` is the
// only way a test gets it (`buildGame({ features: ['bench'] })`, dir `target/engine/<profile>+bench`,
// its own build hash); `benchWorldConfig(buildHash, scale)` is the world to start on it: the bench
// marker rides in `worldgen` (`{ bench: scale }`, `scale` 1 = the full save, 64 = 1/64), and
// `RefGame::genesis` fills the world (`games/reference/sim/src/bench.rs`). Never combine with
// `test-hooks` (M34b): a release golden or bench build never carries it.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BuildGameResult, buildGame } from '../../src/build-game.js'
import type { WorldConfig } from '../../src/sim-config.js'

export const REFERENCE_SIM = fileURLToPath(
  new URL('../../../../games/reference/sim', import.meta.url),
)

/** `0007 §8`'s state budgets at 1/`scale`: what `WorldParams` must carry for the save to fit. */
export function benchBudgets(scale: number): { maxEntities: number; maxModifiedTiles: number } {
  return {
    maxEntities: Math.floor(262_144 / scale),
    maxModifiedTiles: Math.floor(1_048_576 / scale),
  }
}

/**
 * M36b's measurement knob: `variant` builds the release `bench` module as `feature-matrix` does
 * (`wasm-opt`, or `+simd128` in its own cargo target directory), into a private `outDir` that never
 * touches `target/engine/release+bench`. Plain by default; `tick-large-save node` reads
 * `BENCH_VARIANT` to time a variant.
 */
export function buildBench(
  profile: 'dev' | 'release' = 'release',
  variant: 'plain' | 'wasm-opt' | 'simd128' = 'plain',
): Promise<BuildGameResult> {
  if (variant === 'plain') return buildGame({ crate: REFERENCE_SIM, profile, features: ['bench'] })
  return buildGame({
    crate: REFERENCE_SIM,
    profile,
    features: ['bench'],
    outDir: join(tmpdir(), 'engine-feature-matrix', `bench-${variant}`),
    ...(variant === 'wasm-opt' ? { wasmOpt: true } : {}),
    ...(variant === 'simd128'
      ? {
          env: {
            ...process.env,
            RUSTFLAGS: '-C target-feature=+simd128',
            CARGO_TARGET_DIR: join(REFERENCE_SIM, '../../../target/feature-matrix-simd'),
          },
        }
      : {}),
  })
}

export function benchWorldConfig(
  buildHash: string,
  scale: number,
  opts: { seed?: string; arenaBytes?: number } = {},
): WorldConfig {
  return {
    worldId: `bench-${scale}`,
    buildHash,
    // Seed as `world.json`'s (the reference game's one world).
    params: {
      seed: opts.seed ?? '6840143426475589698',
      worldgen: { bench: scale },
      ...benchBudgets(scale),
    },
    ...(opts.arenaBytes === undefined ? {} : { arenaBytes: opts.arenaBytes }),
  }
}

export const BENCH_BUILD_DIR = (profile: 'dev' | 'release'): string =>
  join(REFERENCE_SIM, 'target', 'engine', `${profile}+bench`)
