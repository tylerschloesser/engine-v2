// The two `@slow` tests of docs/plan/34b-reference-scripted-single-player.md that need the reference
// game's `test-hooks` build (`buildGame({ features: ['test-hooks'] })`; never shipped, see
// `build-game-features.test.ts`): a poison `StartCraft` (recipe 255) panics in `apply` and is skipped
// and acked `EngineFault` while play continues (0005 Panic recovery step 3); a world saved by the
// normal build is `SaveIncompatible` under the hooks build (`SCHEMA_VERSION + 1`) with every stored
// byte unchanged and `exportWorld` still working (0005 Upgrades).
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, test } from 'vitest'
import { buildGame } from '../../src/build-game.js'
import { WorldLoadError } from '../../src/host/persistence.js'
import { createWorldServer } from '../../src/server.js'
import { loadGame } from '../../src/server-node.js'
import { exportWorld } from '../../src/storage/archive.js'
import type { Storage } from '../../src/storage/types.js'
import {
  createNetHarness,
  createVirtualClock,
  type NetHarness,
  worldServerTestHandle,
} from '../../src/test.js'
import { gameCrateBuildDir } from '../support/fixtures.js'
import { readWorldJson } from '../support/reference-golden.js'

const CRATE = fileURLToPath(new URL('../../../../games/reference/sim', import.meta.url))
const WORLD_ID = 'reference'
const STONE = 0

type Ui = { inventory: number[] }

let hooks: Awaited<ReturnType<typeof loadGame>>
beforeAll(async () => {
  const built = await buildGame({ crate: CRATE, features: ['test-hooks'] })
  hooks = await loadGame(built.dir)
}, 240_000)

async function harness(fixture: Awaited<ReturnType<typeof loadGame>>): Promise<NetHarness> {
  const world = readWorldJson()
  return createNetHarness({
    fixture,
    seed: 3405,
    worldSeed: world.seed,
    clients: 1,
    world: { worldId: WORLD_ID, params: { worldgen: world.worldgen } },
  })
}

const uiOf = (h: NetHarness): Ui => {
  const ui = h.clients[0]?.ui() as Ui | null | undefined
  if (!ui) throw new Error('no Ui yet')
  return ui
}

async function snapshotStorage(storage: Storage): Promise<Map<string, Uint8Array | null>> {
  const out = new Map<string, Uint8Array | null>()
  for (const key of await storage.list('')) out.set(key, await storage.read(key))
  return out
}

test('reference_panic_in_apply_skips_and_recovers @slow', async () => {
  const h = await harness(hooks)
  try {
    const client = h.clients[0]
    if (!client) throw new Error('no client')
    await h.advanceTicks(20)
    const results = new Map<number, unknown>()
    client.onActionResult((seq, r) => {
      if (r !== 'NotPredictable') results.set(seq, r)
    })
    const sim = worldServerTestHandle(h.server)
    const poison = client.dispatch({ StartCraft: { recipe: 255 } })
    // The panic traps the sim inside a tick; the host (a worker, in production) then recovers.
    let trapped = false
    for (let i = 0; i < 40 && !trapped; i++) {
      try {
        await h.advanceTicks(1)
      } catch {
        trapped = true
      }
    }
    expect(trapped).toBe(true)
    expect(await sim.recover()).toBe('skipped')
    await h.advanceTicks(10)
    expect(results.get(poison)).toEqual({ Rejected: { Engine: 'EngineFault' } })

    // Play continues: a stone is collected after the recovery.
    const before = uiOf(h).inventory[STONE] ?? 0
    const tile = (await import('../support/reference-golden.js')).readLandmarks().resources.stone
    client.setCamera({ x: tile.x, y: tile.y, tilesAcross: 20 })
    await h.advanceTicks(25)
    const ui = client.ui() as unknown as {
      in_range: Array<{ tile: { x: number; y: number }; from: unknown }>
    }
    const entry = ui.in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)
    expect(entry).toBeDefined()
    client.dispatch({ StartCollect: { tile: { x: tile.x, y: tile.y }, from: entry?.from } })
    for (let i = 0; i < 300 && (uiOf(h).inventory[STONE] ?? 0) <= before; i++) {
      await h.advanceTicks(1)
    }
    expect(uiOf(h).inventory[STONE]).toBeGreaterThan(before)
  } finally {
    await h.dispose()
  }
}, 120_000)

test('reference_save_incompatible_leaves_files @slow', async () => {
  // A world saved by the normal build: one stone in the pocket.
  const normal = await loadGame(gameCrateBuildDir('reference'))
  const h = await harness(normal)
  let storage: Storage
  try {
    await h.advanceTicks(20)
    const client = h.clients[0]
    const tile = (await import('../support/reference-golden.js')).readLandmarks().resources.stone
    if (!client) throw new Error('no client')
    client.setCamera({ x: tile.x, y: tile.y, tilesAcross: 20 })
    await h.advanceTicks(25)
    const ui = client.ui() as unknown as { in_range: Array<{ tile: { x: number }; from: unknown }> }
    client.dispatch({ StartCollect: { tile, from: ui.in_range[0]?.from } })
    for (let i = 0; i < 300 && (uiOf(h).inventory[STONE] ?? 0) < 1; i++) await h.advanceTicks(1)
    expect(uiOf(h).inventory[STONE]).toBe(1)
    await h.server.stop()
    storage = h.storage
    const before = await snapshotStorage(storage)
    const archiveBefore = await exportWorld(storage, WORLD_ID)

    // The hooks build reports one schema version higher: the save cannot be loaded.
    const world = readWorldJson()
    const clock = createVirtualClock()
    const server = createWorldServer(
      {
        worldId: WORLD_ID,
        buildHash: hooks.buildHash,
        params: { seed: world.seed, worldgen: world.worldgen as never },
        debugHashMode: 'all',
      },
      {
        wasm: hooks.wasm,
        storage,
        clock: { now: () => clock.now() },
        timer: { every: () => () => {} },
        scheduler: clock,
      },
    )
    const error = await server.ready.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(WorldLoadError)
    expect((error as WorldLoadError).kind).toBe('incompatible')
    expect((error as WorldLoadError).reason).toBe('MigrateDeclined')

    // Every stored byte is unchanged, and the world can still be exported (byte for byte).
    const after = await snapshotStorage(storage)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [key, bytes] of after) expect(bytes).toEqual(before.get(key))
    expect(await exportWorld(storage, WORLD_ID)).toEqual(archiveBefore)
  } finally {
    await h.dispose()
  }
}, 120_000)
