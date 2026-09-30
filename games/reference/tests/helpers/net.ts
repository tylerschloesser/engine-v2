// `refHarness` and `tornStateProbe` (docs/plan/34c-reference-scripted-multiplayer.md Provides): the
// boilerplate every scripted multiplayer scenario of the reference game starts with. The netcode
// suite is one Node process on a virtual clock (`packages/engine/tests/netcode/CLAUDE.md`).
import { createNetHarness, type NetHarness, type NetHarnessOptions } from 'engine/test'
import { gameCrateBuildDir } from '../../../../packages/engine/tests/support/fixtures.js'
import { readWorldJson } from '../../../../packages/engine/tests/support/reference-golden.js'
import type { RefUiState } from './game.js'
import { headlessDriver } from './script.js'

export type RefDriver = ReturnType<typeof headlessDriver>

export type RefHarnessOptions = {
  clients: number
  /** The link conditioner's seed (and the failure messages'): the world's seed is `world.json`'s. */
  seed: number
  conditions?: NetHarnessOptions['conditions']
  world?: NetHarnessOptions['world']
  transport?: NetHarnessOptions['transport']
  hashAll?: boolean
  joinKey?: string
}

export type RefHarness = {
  h: NetHarness
  /** One per client, in join order; each has been given a fresh `Ui` (the join settled). */
  drivers: RefDriver[]
  seed: number
  dispose(): Promise<void>
}

/** The reference game (dev build, `world.json`'s world) with `clients` headless players, each
 * wrapped in M34b's `headlessDriver` over the harness's `advanceTicks`. Every client starts at the
 * spawn tile with a camera there; the harness has run 20 ticks so each holds its first `Ui`. */
export async function refHarness(opts: RefHarnessOptions): Promise<RefHarness> {
  const world = readWorldJson()
  const h = await createNetHarness({
    fixture: gameCrateBuildDir('reference'),
    seed: opts.seed,
    worldSeed: world.seed,
    clients: opts.clients,
    ...(opts.conditions ? { conditions: opts.conditions } : {}),
    ...(opts.transport ? { transport: opts.transport } : {}),
    ...(opts.hashAll !== undefined ? { hashAll: opts.hashAll } : {}),
    world: { params: { worldgen: world.worldgen }, ...opts.world },
  })
  try {
    const drivers = h.clients.map((c) => headlessDriver(c, (n) => h.advanceTicks(n)))
    await h.advanceTicks(20 + 4 * Math.ceil((opts.conditions?.latencyMs ?? 0) / 50))
    return { h, drivers, seed: opts.seed, dispose: () => h.dispose() }
  } catch (e) {
    await h.dispose()
    throw e
  }
}

/** Reads client `i`'s `Ui`. */
export const uiOf = (h: NetHarness, i: number): RefUiState => {
  const u = h.clients[i]?.ui() as RefUiState | null | undefined
  if (!u) throw new Error(`client ${i}: no Ui yet`)
  return u
}
