// Pure sim-role config helpers, split out of `server.ts` (docs/plan/13-sim-host-tick-loop.md):
// `WorldConfig`, `seedToHexU64` and `buildSimInstanceConfig` touch no `EngineInstance`/`instantiate`
// (`loader.ts`), unlike the rest of `server.ts` (`wrapEngineInstance`/`createSimHost`). `client.ts`
// (main thread) needs exactly these three to build the sim worker's own config for a local host,
// but must never import `loader.ts` even transitively (0015 §1, `main.no_wasm_instantiate`) --
// importing them from `server.ts` itself would pull that module's own `import { instantiate } from
// './loader.js'` along for the ride. `server.ts` re-exports all three unchanged (Seams: no renamed
// Provides), so every other consumer's import path is untouched.
import type { InstanceConfig } from './loader.js'

/**
 * 0009's shape, `buildHash` included: a caller (`createSimHost`, `createClient`'s local host) is
 * the one that fills it in, from whatever build it actually instantiates.
 */
export interface WorldConfig<Params = unknown> {
  worldId: string
  buildHash: string
  params: {
    /** u64 as decimal text (0009); `createSimHost`/`createClient` convert it to `HexU64` form
     * once (0024 §5). */
    seed: string
    worldgen: Params
    maxEntities?: number
    maxModifiedTiles?: number
    maxActionGrowth?: number
  }
  joinKey?: string
  maxPlayers?: number
  keepTickingWhenEmpty?: boolean
  view?: { maxTilesPerAxis?: number; maxChunks?: number }
  cacheChunks?: number
  arenaBytes?: number
  actionRate?: { perSecond?: number; burst?: number }
  bandwidth?: {
    softCapBytesPerS?: number
    chunkRefillBytesPerS?: number
    chunkBurstBytes?: number
    hardCapBytesPerS?: number
  }
}

const DECIMAL_SEED = /^[0-9]+$/
const U64_MAX = 0xffffffffffffffffn

/**
 * Decimal text (`WorldConfig.params.seed`) to the engine's `HexU64` config form: `"0x"` plus
 * lowercase hex, no padding (`abi::config::HexU64`'s `Deserialize` accepts 1 to 16 hex digits, so
 * `"0"` -> `"0x0"` round-trips through Rust exactly as `"18446744073709551615"` ->
 * `"0xffffffffffffffff"` does). Throws on a sign, non-decimal text, or a value past 2^64 - 1.
 */
export function seedToHexU64(seed: string): string {
  if (!DECIMAL_SEED.test(seed)) {
    throw new Error(`createSimHost: seed must be decimal digits, got ${JSON.stringify(seed)}`)
  }
  const n = BigInt(seed)
  if (n > U64_MAX) {
    throw new Error(`createSimHost: seed exceeds u64 (2^64 - 1): ${seed}`)
  }
  return `0x${n.toString(16)}`
}

/** `WorldConfig` -> the sim role's `InstanceConfig` (docs/plan/13-sim-host-tick-loop.md, Scope
 * "Sim-role config"). Pure: no instantiation, so the seed conversion is testable without a
 * module. */
export function buildSimInstanceConfig(cfg: WorldConfig): InstanceConfig {
  return {
    arenaBytes: cfg.arenaBytes ?? 96 * 1024 * 1024,
    game: {
      seed: seedToHexU64(cfg.params.seed),
      params: cfg.params.worldgen,
      maxEntities: cfg.params.maxEntities,
      maxModifiedTiles: cfg.params.maxModifiedTiles,
      maxActionGrowth: cfg.params.maxActionGrowth,
      cacheChunks: cfg.cacheChunks,
    },
  }
}
