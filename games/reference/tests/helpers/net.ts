// `refHarness` and `tornStateProbe` (M34c Provides): the
// boilerplate every scripted multiplayer scenario of the reference game starts with. The netcode
// suite is one Node process on a virtual clock (`packages/engine/tests/netcode/CLAUDE.md`).
import {
  createNetHarness,
  type DrawRecord,
  type HeadlessClient,
  type NetHarness,
  type NetHarnessOptions,
  worldServerTestHandle,
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
  /** Identity secrets in join order (a returning player is a client with its old secret). */
  secrets?: Uint8Array[]
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
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
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
 * of the newest DrawList) covers the wait. One client step runs `frame()` (which draws) and then
 * applies the downlink (which produces the `Ui`), so `draws()` trails `ui()` by one step: the item
 * read at step k is checked against the sprites drawn at step k + 1. A frame is torn when
 * - once a placement is tracked: last step's item count was 0 and no furnace sprite is drawn now (the
 *   item vanished: "neither");
 * - the item count is not the count at the first tracked placement less the confirmed ones (spent
 *   before the host said so, not spent once it did, or not back after a refusal);
 * - every tracked placement has a verdict, one step after the last verdict step a ghost is still
 *   drawn (the ghost and the spent item both shown: "both");
 * - a tracked placement was confirmed and the replica hash did not change on the ack step (the host
 *   would have split the ack from the entity put: the probe's one-step allowance must not hide that).
 * `also(ui, draws)` adds a game-specific per-frame check for a scenario.
 */
export function tornStateProbe(
  client: HeadlessClient,
  also?: (ui: RefUiState, draws: DrawRecord[]) => void,
): TornProbe {
  type Tracked = { seq: number; verdictFrame: number | null; ok: boolean }
  let baseline = 0
  const tracked: Tracked[] = []
  const verdicts = new Map<number, unknown>()
  let frames = 0
  let ghostFrames = 0
  let lastItem: number | null = null
  let lastHash = client.replicaHash()
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
      if (tracked.length === 0) baseline = item()
      tracked.push({ seq, verdictFrame: null, ok: false })
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
      if (tracked.length > 0 && lastItem === 0 && sprites.length === 0) {
        fail('the item was gone on the last step and no furnace is drawn now')
      }
      const hash = client.replicaHash()
      for (const t of tracked) {
        if (t.ok && t.verdictFrame === frames - 1 && hash === lastHash) {
          fail(`seq ${t.seq} was confirmed on this step but the replica did not change`)
        }
      }
      lastHash = hash
      lastItem = now
      // The item count is the baseline less one per confirmed placement whose verdict has arrived: a
      // verdict and its `Ui` land in the same step, so it never moves before the host has spoken and
      // never lags after (a refused placement leaves it where it was).
      const confirmed = tracked.filter((t) => t.verdictFrame !== null && t.ok).length
      if (tracked.length > 0 && now !== baseline - confirmed) {
        fail(`the item count should be ${baseline - confirmed} (${confirmed} confirmed)`)
      }
      const pending = tracked.filter((t) => t.verdictFrame === null)
      if (pending.length > 0 && ghost) ghostFrames++
      const lastVerdict = Math.max(
        ...tracked.map((t) => t.verdictFrame ?? Number.POSITIVE_INFINITY),
      )
      if (tracked.length > 0 && frames > lastVerdict + 1 && ghost) {
        fail('every tracked placement has a verdict but a ghost is still drawn')
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

/** A write-ahead log frame's `count` field (0005 Formats: `len varint`, `tick_delta varint`, `count
 * varint`, then the records). */
function frameRecordCount(frame: Uint8Array): number {
  let pos = 0
  for (let i = 0; i < 2; i++) {
    while (frame[pos++]! & 0x80) {}
  }
  let value = 0
  let shift = 0
  for (;;) {
    const b = frame[pos++]
    if (b === undefined) throw new Error('frameRecordCount: truncated')
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return value >>> 0
    shift += 7
  }
}

/** Counts the records the host appends to its log from now on (every `Connected`, `Disconnected`,
 * `Joined` and action is one): `logRecords().n`. */
export function logRecords(h: NetHarness): { readonly n: number } {
  const host = worldServerTestHandle(h.server)
  const original = host.logSink
  const out = {
    n: 0,
  }
  host.logSink = (bytes) => {
    out.n += frameRecordCount(bytes)
    original?.(bytes)
  }
  return out
}

/** `StartCollect` on `tile` the way the UI sends it: from the `in_range` entry's own `from`. */
export function startCollect(r: RefHarness, i: number, tile: { x: number; y: number }): number {
  const entry = uiOf(r.h, i).in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)
  if (!entry) throw new Error(`client ${i}: tile ${tile.x},${tile.y} is not in range`)
  return r.h.clients[i]!.dispatch({ StartCollect: { tile, from: entry.from } })
}
