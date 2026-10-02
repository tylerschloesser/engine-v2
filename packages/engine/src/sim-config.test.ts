import { expect, test } from 'vitest'
import { buildSimInstanceConfig, type WorldConfig } from './sim-config.js'

const base: WorldConfig = { worldId: 'w', params: { seed: '1', worldgen: null } } as WorldConfig

// 0009 WorldConfig defaults: `arenaBytes` is 96 MiB when unset, and a configured value wins.
test('sim-config: the default sim arena is 96 MiB', () => {
  expect(buildSimInstanceConfig(base).arenaBytes).toBe(96 * 1024 * 1024)
  expect(buildSimInstanceConfig({ ...base, arenaBytes: 1 << 20 }).arenaBytes).toBe(1 << 20)
})
