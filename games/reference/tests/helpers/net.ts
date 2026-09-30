// `refHarness` and `tornStateProbe` (docs/plan/34c-reference-scripted-multiplayer.md Provides): the
// boilerplate every scripted multiplayer scenario of the reference game starts with. The netcode
// suite is one Node process on a virtual clock (`packages/engine/tests/netcode/CLAUDE.md`).
import {
  createNetHarness,
  type DrawRecord,
  type HeadlessClient,
  type NetHarness,
  type NetHarnessOptions,
} from 'engine/test'
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
  /** Each client's camera from its first frame (clients past the end keep the default, which holds
   * the 4 x 4 chunks around the origin): so a scenario's subscribed set is exactly ring 1 of this view. */
  cameras?: Array<{ x: number; y: number; tilesAcross: number }>
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
    opts.cameras?.forEach((cam, i) => {
      h.clients[i]?.setCamera(cam)
    })
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

const ITEM_FURNACE = 4
/** `Draw::flags` bit the engine sets on a predicted (ghost) record (`drawlist.rs::PREDICTED`). */
export const PREDICTED = 1 << 2

export type TornProbe = {
  /** Tells the probe this client dispatched a `PlaceFurnace` as `seq`; reads the furnace count now. */
  trackPlace(seq: number): void
  /** The per-frame check: call once after every tick (`advance` does). Throws on a torn state. */
  check(): void
  /** Frames checked so far. */
  readonly frames: number
  /** Frames in which a tracked placement was pending and its ghost was on screen. */
  readonly ghostFrames: number
  /** The verdict of each tracked seq, once it arrived. */
  readonly verdicts: Map<number, unknown>
}

/**
 * The per-frame torn-state check for one client's furnace placements (ADR 0012: "ghost XOR refunded
 * item ... no torn state on any frame"). In this game `Ui.inventory` reads the authoritative replica,
 * not the overlay, so the item is spent at the host's ack and the ghost (a `PREDICTED` furnace sprite
 * of the newest DrawList) covers the wait; a frame is torn when
 * - once a placement is tracked: the item count is 0 and no furnace sprite is drawn at all (the item
 *   vanished: "neither");
 * - a tracked placement has no verdict yet and the item count moved (spent before the host said so);
 * - a tracked placement was confirmed and, one frame later, the item is not spent or a ghost remains
 *   (the ghost and the spent item both shown: "both");
 * - a tracked placement was refused and, one frame later, the item is not back at its old count or a
 *   ghost remains. (A ghost may outlive its verdict by the one frame `extract` lags the `Ui`.)
 * `also(ui, draws)` adds a game-specific per-frame check for a scenario.
 */
export function tornStateProbe(
  client: HeadlessClient,
  also?: (ui: RefUiState, draws: DrawRecord[]) => void,
): TornProbe {
  type Tracked = { seq: number; before: number; verdictFrame: number | null; ok: boolean }
  const tracked: Tracked[] = []
  const verdicts = new Map<number, unknown>()
  let frames = 0
  let ghostFrames = 0
  client.onActionResult((seq, result) => {
    if (result === 'NotPredictable') return
    verdicts.set(seq, result)
    const t = tracked.find((x) => x.seq === seq)
    if (t) {
      t.verdictFrame = frames
      t.ok = result === 'Confirmed'
    }
  })
  const item = (): number => {
    const u = client.ui() as RefUiState | null
    if (!u) throw new Error('tornStateProbe: no Ui yet')
    return u.inventory[ITEM_FURNACE] ?? 0
  }
  return {
    trackPlace(seq) {
      tracked.push({ seq, before: item(), verdictFrame: null, ok: false })
    },
    check() {
      frames++
      const ui = client.ui() as RefUiState
      const draws = client.draws()
      const sprites = draws.filter((d) => d.kind === 0)
      const ghost = sprites.some((d) => (d.flags & PREDICTED) !== 0)
      const now = item()
      const fail = (why: string): never => {
        throw new Error(
          `torn state at client frame ${frames}: ${why} (item ${now}, sprites ${JSON.stringify(
            sprites.map((d) => d.flags),
          )}, tracked ${JSON.stringify(tracked)})`,
        )
      }
      if (tracked.length > 0 && now === 0 && sprites.length === 0) {
        fail('the item is gone and no furnace is drawn')
      }
      for (const t of tracked) {
        if (t.verdictFrame === null) {
          if (now !== t.before) fail(`seq ${t.seq} has no verdict yet but the item count moved`)
          if (ghost) ghostFrames++
        } else if (frames > t.verdictFrame + 1) {
          if (ghost) fail(`seq ${t.seq} has a verdict but a ghost is still drawn`)
          if (t.ok && now !== t.before - 1) fail(`seq ${t.seq} confirmed but the item is not spent`)
          if (!t.ok && now !== t.before) fail(`seq ${t.seq} refused but the item is not back`)
        }
      }
      also?.(ui, draws)
    },
    get frames() {
      return frames
    },
    get ghostFrames() {
      return ghostFrames
    },
    verdicts,
  }
}

/** Advances `n` ticks one at a time (one client frame per tick in the harness), running every probe
 * after each: a torn state is caught on the frame it shows, not at the end. */
export async function advanceProbed(h: NetHarness, probes: TornProbe[], n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await h.advanceTicks(1)
    for (const p of probes) p.check()
  }
}
