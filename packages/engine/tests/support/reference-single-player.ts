import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import type { loadGame } from '../../src/server-node.js'
import type { deleteWorld, exportWorld, importWorld } from '../../src/storage/archive.js'
import type { createNetHarness, NetHarness, worldServerTestHandle } from '../../src/test.js'
import { readLandmarks, readWorldJson } from './reference-golden.js'

/** What the caller supplies, so one body runs from `src/` (Vitest, Node) and from `dist/` (the Bun
 * leg, `bun-leg.mjs`): the functions themselves, plus the reference build's directory. */
export type Deps = {
  loadGame: typeof loadGame
  createNetHarness: typeof createNetHarness
  worldServerTestHandle: typeof worldServerTestHandle
  exportWorld: typeof exportWorld
  importWorld: typeof importWorld
  deleteWorld: typeof deleteWorld
  gameDir: string
}

const STONE = 0
const FURNACE = 4
const WORLD_ID = 'reference'

type Ui = {
  me: number
  inventory: number[]
  in_range: Array<{ tile: { x: number; y: number }; from: { x: number; y: number } }>
  crafting: unknown
  collecting: unknown
  roster: Array<{ id: number; online: boolean; me: boolean }>
}

async function harness(
  d: Deps,
  opts: {
    clients: number
    maxEntities?: number
    secrets?: Uint8Array[]
  },
): Promise<NetHarness> {
  const fixture = await d.loadGame(d.gameDir)
  const world = readWorldJson()
  return d.createNetHarness({
    fixture,
    seed: 3405, // the link conditioner only (zero latency); the world's own seed is `world.json`'s
    worldSeed: world.seed,
    clients: opts.clients,
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    world: {
      worldId: WORLD_ID,
      params: {
        worldgen: world.worldgen,
        ...(opts.maxEntities !== undefined ? { maxEntities: opts.maxEntities } : {}),
      },
    },
  })
}

const uiOf = (h: NetHarness, i = 0): Ui => {
  const ui = h.clients[i]?.ui() as Ui | null | undefined
  if (!ui) throw new Error('no Ui yet')
  return ui
}

/** Ticks until `done()` holds (bounded: a wait that never ends is a bug, not a slow run). */
async function until(h: NetHarness, what: string, done: () => boolean, max = 300): Promise<void> {
  for (let i = 0; i < max && !done(); i++) await h.advanceTicks(1)
  if (!done()) throw new Error(`${what}: did not happen in ${max} ticks`)
}

/** Stands the player on the stone tile and collects `n` stone, one at a time. */
async function collectStone(h: NetHarness, n: number): Promise<void> {
  const tile = readLandmarks().resources.stone
  const client = h.clients[0]
  if (!client) throw new Error('no client')
  client.setCamera({ x: tile.x, y: tile.y, tilesAcross: 20 })
  await h.advanceTicks(25)
  for (let i = 0; i < n; i++) {
    const entry = () => uiOf(h).in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)
    await until(h, 'stone tile in range', () => entry() !== undefined)
    const before = uiOf(h).inventory[STONE] ?? 0
    const from = entry()?.from
    client.dispatch({ StartCollect: { tile: { x: tile.x, y: tile.y }, from } })
    await until(h, 'stone collected', () => (uiOf(h).inventory[STONE] ?? 0) > before)
  }
}

/** Dispatches and returns the host's verdict (the client's `NotPredictable` at dispatch is skipped). */
async function verdict(h: NetHarness, action: unknown): Promise<unknown> {
  const client = h.clients[0]
  if (!client) throw new Error('no client')
  const results = new Map<number, unknown>()
  client.onActionResult((seq, r) => {
    if (r !== 'NotPredictable') results.set(seq, r)
  })
  const seq = client.dispatch(action)
  await until(h, `verdict of ${JSON.stringify(action)}`, () => results.has(seq))
  return results.get(seq)
}

async function craftFurnace(h: NetHarness): Promise<void> {
  await collectStone(h, 5)
  strictEqual(await verdict(h, { StartCraft: { recipe: 0 } }), 'Confirmed')
  await until(h, 'furnace crafted', () => (uiOf(h).inventory[FURNACE] ?? 0) === 1)
}

export async function saveToServer(d: Deps): Promise<void> {
  const secret = new Uint8Array(16).fill(0x5e)
  // Single-player: one client with its own secret, two stones collected.
  const single = await harness(d, { clients: 1, secrets: [secret] })
  let archive: Uint8Array
  let played: { me: number; inventory: number[]; hash: string; tick: number }
  try {
    await single.advanceTicks(20)
    await collectStone(single, 2)
    await single.settle()
    played = { ...uiOf(single), hash: '', tick: 0 }
    const sim = d.worldServerTestHandle(single.server)
    played.hash = sim.hash()
    played.tick = sim.counters.ticksRun
    strictEqual(played.inventory[STONE], 2)
    await single.server.stop() // the clean boundary: snapshot if dirty, flush
    archive = await d.exportWorld(single.storage, WORLD_ID)
  } finally {
    await single.dispose()
  }

  // A hosted server with nobody in it: its storage takes the exported world in place of its own
  // (the old server is dropped without a stop, so nothing overwrites the import).
  const hosted = await harness(d, { clients: 0 })
  try {
    await d.deleteWorld(hosted.storage, WORLD_ID)
    await d.importWorld(hosted.storage, archive)
    await hosted.restartServer({ crash: true })
    const sim = d.worldServerTestHandle(hosted.server)
    deepStrictEqual(
      { hash: sim.hash(), tick: sim.counters.ticksRun },
      { hash: played.hash, tick: played.tick },
    )

    // The same secret reclaims the same player: same id, same inventory, still one player.
    const client = hosted.addClient(secret)
    await hosted.advanceTicks(20)
    const ui = client.ui() as Ui
    strictEqual(ui.me, played.me)
    deepStrictEqual(ui.inventory, played.inventory)
    strictEqual(ui.roster.filter((p) => p.online).length, 1)
    strictEqual(ui.roster.length, 1)
    await hosted.settle()
    hosted.assertConverged()

    // A different secret is a new player, not the owner of that inventory.
    const stranger = hosted.addClient(new Uint8Array(16).fill(0x99))
    await hosted.advanceTicks(20)
    const other = stranger.ui() as Ui
    ok(other.me !== played.me)
    strictEqual(other.inventory[STONE], 0)
  } finally {
    await hosted.dispose()
  }
}

export async function stateBudgetFull(d: Deps): Promise<void> {
  const place = { PlaceFurnace: { origin: { x: -4, y: 1 } } }

  // `maxEntities: 0`: a furnace is one entity (`Game::growth`), and there is no headroom for it.
  const full = await harness(d, { clients: 1, maxEntities: 0 })
  try {
    await full.advanceTicks(20)
    await craftFurnace(full)
    deepStrictEqual(await verdict(full, place), { Rejected: { Engine: 'StateBudgetFull' } })
    await full.settle()
    strictEqual(uiOf(full).inventory[FURNACE], 1) // the item stays
  } finally {
    await full.dispose()
  }

  // The same play with the default budget places the furnace: the refusal above is the budget's.
  const roomy = await harness(d, { clients: 1 })
  try {
    await roomy.advanceTicks(20)
    await craftFurnace(roomy)
    strictEqual(await verdict(roomy, place), 'Confirmed')
    await until(roomy, 'furnace spent', () => (uiOf(roomy).inventory[FURNACE] ?? 1) === 0)
  } finally {
    await roomy.dispose()
  }
}
