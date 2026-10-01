// The reference game's `bench` build (docs/plan/36-slow-tier-and-benchmarks.md): the standard large
// save of docs/decisions/0020 §9 behind cargo feature `bench`, never shipped. `buildBench()` is the
// only way a test gets it (`buildGame({ features: ['bench'] })`, dir `target/engine/<profile>+bench`,
// its own build hash); `benchWorldConfig(buildHash, scale)` is the world to start on it: the bench
// marker rides in `worldgen` (`{ bench: scale }`, `scale` 1 = the full save, 64 = 1/64), and
// `RefGame::genesis` fills the world (`games/reference/sim/src/bench.rs`). Never combine with
// `test-hooks` (M34b): a release golden or bench build never carries it.
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

export function buildBench(profile: 'dev' | 'release' = 'release'): Promise<BuildGameResult> {
  return buildGame({ crate: REFERENCE_SIM, profile, features: ['bench'] })
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
