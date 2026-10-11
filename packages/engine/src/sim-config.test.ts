import { expect, test } from 'vitest'
import { buildSimInstanceConfig, type WorldConfig } from './sim-config.js'

const base: WorldConfig = { worldId: 'w', params: { seed: '1', worldgen: null } } as WorldConfig

// 0009 WorldConfig defaults: `arenaBytes` is 96 MiB when unset, and a configured value wins.
test('sim-config: the default sim arena is 96 MiB', () => {
  expect(buildSimInstanceConfig(base).arenaBytes).toBe(96 * 1024 * 1024)
  expect(buildSimInstanceConfig({ ...base, arenaBytes: 1 << 20 }).arenaBytes).toBe(1 << 20)
})

// 0076 §8 (M42): the transport caps reach `host::SimConfig` as `maxLines`/`maxItems`; unset, they
// stay `undefined` (dropped by `JSON.stringify`) so the Rust defaults apply.
test('sim-config: maxLines and maxItems pass through', () => {
  const game = (cfg: WorldConfig) => buildSimInstanceConfig(cfg).game as Record<string, unknown>
  expect(game(base).maxLines).toBeUndefined()
  expect(game(base).maxItems).toBeUndefined()
  const set = { ...base, params: { ...base.params, maxLines: 64, maxItems: 512 } }
  expect(game(set).maxLines).toBe(64)
  expect(game(set).maxItems).toBe(512)
})
