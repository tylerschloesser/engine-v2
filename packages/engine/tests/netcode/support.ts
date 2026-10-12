// Shared by every `netcode` scenario: `createNetHarness({ fixture: await loadFixture('puts'), ... })`
// against the real `fx-puts` fixture (Consumes: "M16's action fixture and M15's puts fixture,
// unchanged" -- one and the same crate, `on_player(Joined)` puts the player slot every ledger-noted
// ack depends on).
import { expect } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { seedToHexU64, serverInternals } from '../../src/server.js'
import {
  forecastCounters,
  hostLineItems,
  type LineItemsDump,
  lineItems,
} from '../../src/test/lines.js'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
import { type ParsedFrame, parseMessage } from '../../src/test/net-sections.js'
import { loadFixture } from '../support/fixtures.js'

export async function putsFixture(): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  return loadFixture('puts')
}

/** M46: the `fx-belts` fixture (`fixtures/belts`), the `belts/*` scenarios' world: lines built by
 * `Action::Request` ops, executed on the next tick. */
export async function beltsFixture(): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  return loadFixture('belts')
}

/** Every scenario prints its own seed on failure (0020 §2); this is the one this file's own
 * callers pass by default when a test does not care about a specific value. */
export const DEFAULT_SEED = 1

export function square(i: number): { x: number; y: number; tilesAcross: number } {
  // Spread clients apart: two clients at the identical position/velocity would otherwise look
  // identical to every *other* client's presence view -- irrelevant noise worth avoiding.
  return { x: i * 40, y: 0, tilesAcross: 20 }
}

function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    out += b < 16 ? `0${b.toString(16)}` : b.toString(16)
  }
  return out
}

/** M28 (`handshake`/`liveness` scenarios): real `client_hello()`
 * bytes off a throwaway `Role.Client` instance -- mirrors `src/test/headless-client.ts`'s own
 * `sendHello`, standalone (no ring/pump machinery) so a scenario testing the handshake parser
 * itself (`version-mismatch`/`bad-key`/`garbage-before-hello`/...) can build a deliberately wrong
 * one and hand it to `harness.connectRaw()` directly. `Hello`'s own wire layout carries no seed or
 * worldgen params (`session::Hello`: magic·version·build_hash · join_key · player_secret ·
 * CameraReport · resume) -- only `secret`/`joinKey`/`buildHash` ever reach the bytes this returns,
 * so the throwaway instance's own `game.seed`/`game.params` are fixed, arbitrary values. */
export function buildHelloBytes(
  wasm: WebAssembly.Module,
  opts: { secret: Uint8Array; joinKey: string; buildHash: Uint8Array },
): Uint8Array {
  const clientConfig = {
    arenaBytes: 48 * 1024 * 1024,
    game: {
      seed: seedToHexU64('1'),
      params: null,
      secret: hexEncode(opts.secret),
      joinKey: opts.joinKey,
      buildHash: hexEncode(opts.buildHash),
    },
  }
  const inst = instantiate(wasm, Role.Client, clientConfig)
  const len = inst.call0(inst.x.client_hello)
  if (len <= 0) throw new Error(`client_hello failed: status ${-len}`)
  const tx = inst.region(RegionId.Tx)
  if (!tx) throw new Error('client_hello: Tx region absent')
  return tx.u8.slice(0, len)
}

/** A fixed, arbitrary 16-byte secret for a scenario that only ever needs *a* valid one (the
 * handshake parser's own error paths, not identity). */
export function fixedSecret(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill)
}

/** A `fx-busy-field` world whose chunks `cx0..=cx1` x `cy0..=cy1` are dense (`Action::Fill`, 200
 * entities and 160 modified tiles each, ~4 KB on the wire, M31,
 * filled by client 0 while every client sits far away at `(FAR, FAR)`. */
export const DENSE_FAR = -3000
export async function denseWorld(
  seed: number,
  clients: number,
  region: { cx0: number; cx1: number; cy0: number; cy1: number } = {
    cx0: 40,
    cx1: 50,
    cy0: 40,
    cy1: 50,
  },
  maxChunks?: number,
): Promise<NetHarness> {
  const chunks = (region.cx1 - region.cx0 + 1) * (region.cy1 - region.cy0 + 1)
  const h = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed,
    clients,
    // M31b R1: hash-all off, every scenario on a dense world (`zoomout/*`, `rates/hard-ceiling`,
    // `rates/join-dense-visible-first`) asserts byte budgets, and 121 chunk hashes per frame of a
    // 55,000-entity world would also cost real time.
    hashAll: false,
    // The filler dispatches a Fill per tick or more: past the default 20/s action limit (0004).
    world: {
      params: { maxEntities: chunks * 200 + 4_000, maxActionGrowth: 65_536 },
      actionRate: { perSecond: 20_000, burst: 2_000 },
      ...(maxChunks !== undefined ? { view: { maxChunks } } : {}),
    },
  })
  for (const c of h.clients) c.setView({ x: DENSE_FAR, y: DENSE_FAR, halfW: 1, halfH: 1 })
  await h.advanceTicks(5)
  const filler = h.clients[0]
  if (!filler) throw new Error('no filler')
  let n = 0
  for (let cy = region.cy0; cy <= region.cy1; cy++) {
    for (let cx = region.cx0; cx <= region.cx1; cx++) {
      filler.dispatch({ Fill: { cx, cy } })
      if (++n % 24 === 0) await h.advanceTicks(6)
    }
  }
  await h.advanceTicks(30)
  return h
}

/** The most downlink bytes any 20 consecutive ticks (1 s) carried to client `i`, counting only
 * windows that start after host tick `fromTick` (the initial burst is a separate 0010 row). */
export function worstSecondAfter(h: NetHarness, i: number, fromTick: number): number {
  const perTick = new Map(h.counters(i).perTick.map((r) => [r.tick, r.bytesDown]))
  let worst = 0
  for (let t = fromTick + 1; t + 20 <= h.hostTick(); t++) {
    let sum = 0
    for (let k = 0; k < 20; k++) sum += perTick.get(t + k) ?? 0
    worst = Math.max(worst, sum)
  }
  return worst
}

/** M47b: a `fx-belts` bench regime (`fixtures/belts/src/bench.rs` `BenchRegime`, JSON form). */
export type BeltsRegime =
  | 'Mixed'
  | 'InserterLike'
  | 'MixedEmpty'
  | 'MixedFeeders'
  | { SaturatedView: { jam_pct: number; period: number; speed?: number } }

/** M47b: `createNetHarness`'s `world` for the `fx-belts` bench world built at genesis (seed 7, as
 * M40/M41), `scale` 64 for the arbiter's small worlds, 1 for the saturated viewport. */
export function beltsBenchWorld(
  regime: BeltsRegime,
  scale: number,
  caps: { maxLines: number; maxItems: number },
  paced = false,
) {
  const params = { worldgen: { bench: { seed: 7, scale, regime } }, ...caps }
  // M48b: `paced` keeps the default caps (0010: 48 KB/s chunk bucket, 16 KB/s soft cap).
  if (paced) return { params }
  return {
    params,
    // The bench spawners are entities that write on every insert (thousands of chunk deltas a
    // second at full scale): with the default caps those deltas alone degrade the connection and
    // collapse chunks into snapshots. The scenarios measure sections 12 and 13, so the chunk
    // pacing is lifted out of reach (`tick-belts-large node`'s choice) and every tick's frame goes.
    bandwidth: {
      softCapBytesPerS: LIFTED,
      chunkRefillBytesPerS: LIFTED,
      chunkBurstBytes: LIFTED,
      hardCapBytesPerS: LIFTED,
    },
  }
}

const LIFTED = 1_000_000_000

/** The full-scale bench caps (`bench_host.rs`). */
export const BENCH_CAPS = { maxLines: 32_768, maxItems: 393_216 }

const TICK_HZ = 20
/** 0078 A4's world: `saturated_view_world(7, .., 144)`. */
export const SATURATED_LINES = 2_974
/** The highest line id of the full-scale bench worlds (`Mixed` has 3,810 lines). */
const MAX_ID = 3_810
/** 20 s of virtual time after the join settles. */
export const BYTES_WINDOW_TICKS = 20 * TICK_HZ

/** M47b's `belts/saturated_view_*` run (moved here from `belts-bytes.test.ts` by M48b): the window's
 * numbers. `regime` and `view` default to the saturated viewport; `lines` is how many lines the view
 * holds once joined; `paced` keeps the default chunk pacing (`beltsBenchWorld`). */
export async function measure(
  regime: BeltsRegime,
  seed: number,
  view = { x: 128, y: 72, halfW: 128, halfH: 72 },
  lines = SATURATED_LINES,
  paced = false,
) {
  const world = beltsBenchWorld(
    regime,
    1,
    // The bench caps (`bench_host.rs`): the recommended line cap (its tile index holds 8 tiles a
    // line: this world has 73,728 lane tiles) and an item cap that never binds.
    BENCH_CAPS,
    paced,
  )
  const h = await createNetHarness({
    fixture: await beltsFixture(),
    seed,
    clients: 1,
    clientFrameMs: 12.5,
    world: { ...world, debugHashMode: 'production' },
  })
  try {
    const client = h.clients[0]
    if (!client) throw new Error('one client')
    h.link(0).set({ latencyMs: 40, jitterMs: 20 })
    // The whole 256 x 144 viewport (0010's clamp is 256 tiles a side).
    client.setView(view)
    // The join: every line put with its list (about 1.9 MB of lists at the put budget's 16 KB a
    // frame); it has settled once `lines` lists arrived and none for a second (and, paced, no enter
    // is queued).
    let joinTicks = 0
    let quiet = 0
    let last = -1
    while (quiet < TICK_HZ) {
      await h.advanceTicks(1)
      const n = forecastCounters(client).forecastsApplied
      quiet = n >= lines && n === last ? quiet + 1 : 0
      // Paced (M48b): the chunk bucket drains the view's enters over many seconds and lists can go
      // quiet for a second between them (a held line is put again with its list when its anchor
      // chunk enters by snapshot), so the join has also settled only once no enter is queued.
      if (paced && quiet === TICK_HZ && h.counters(0).queuedEnters !== 0) quiet = 0
      last = n
      if (++joinTicks > 1_200) {
        throw new Error(`the join never settled: ${JSON.stringify(forecastCounters(client))}`)
      }
    }
    const c0 = h.counters(0)
    const f0 = forecastCounters(client)
    await h.advanceTicks(BYTES_WINDOW_TICKS)
    const c1 = h.counters(0)
    const f1 = forecastCounters(client)
    const section = (c: typeof c0, name: string) => c.sections[name] ?? 0
    const structs = section(c1, 'LineStructs') - section(c0, 'LineStructs')
    const forecasts = section(c1, 'Forecasts') - section(c0, 'Forecasts')
    // The visible runs at the end (a run: consecutive items of one kind `SPACING` apart).
    let runs = 0
    let items = 0
    let held = 0
    const inst = serverInternals(h.server).rawInstance
    if (!inst) throw new Error('no live sim instance')
    for (let id = 1; id <= MAX_ID; id++) {
      const d = lineItems(client, id)
      if (!d) continue
      held++
      const it = d.lines[0]?.items ?? []
      items += it.length / 2
      for (let k = 0; k < it.length; k += 2) {
        if (k === 0 || it[k] !== it[k - 2] || (it[k + 1] as number) - (it[k - 1] as number) !== 64)
          runs++
      }
    }
    const corrections = f1.corrections - f0.corrections
    return {
      joinTicks,
      held,
      items,
      runs,
      transportDownBytesPerSec: Math.round((structs + forecasts) / (BYTES_WINDOW_TICKS / TICK_HZ)),
      structsBytes: structs,
      forecastsBytes: forecasts,
      frames: c1.frames - c0.frames,
      states: f1.stateMessagesApplied - f0.stateMessagesApplied,
      lists: f1.forecastsApplied - f0.forecastsApplied,
      lateLists: corrections - (f1.stateMessagesApplied - f0.stateMessagesApplied),
      arrivals: f1.arrivalsApplied - f0.arrivalsApplied,
      forecastSeenLate: f1.forecastSeenLate - f0.forecastSeenLate,
      correctionsPerRunPerSec: corrections / runs / (BYTES_WINDOW_TICKS / TICK_HZ),
      /** 0078 §5's `transport.correctionsPerSec`: States and lists for held lines, per second. */
      correctionsPerSec: corrections / (BYTES_WINDOW_TICKS / TICK_HZ),
      unknown: f1.listsUnknown,
      degradeLevel: c1.degradeLevel,
      /** M48b: chunk deltas collapsed into snapshots, and bundles sent, in the window. */
      collapses: c1.collapses - c0.collapses,
      bundles: c1.bundles - c0.bundles,
    }
  } finally {
    await h.dispose()
  }
}

// M47b's arbiter (`belts-forecast.test.ts`), shared since M48b (`belts-edits`, `belts-degrade`).

export function hostItems(h: NetHarness): LineItemsDump {
  const inst = serverInternals(h.server).rawInstance
  if (!inst) throw new Error('no live sim instance')
  return hostLineItems(inst)
}

/** What one arbiter run saw. */
export interface Seen {
  /** Ticks the client's forecast tick equalled the host's (every one compared). */
  ticks: number
  /** Ticks the client was not at the host's tick (no frame yet: the join). */
  lagging: number
  /** Ticks no frame came for, which the arbiter stepped the client through itself. */
  caughtUp: number
  /** `(line, tick)` pairs compared, and the items in them. */
  compared: number
  items: number
  /** `(line, tick)` pairs skipped: the client holds the line's items as `unknown`. */
  unknown: number
  maxHeld: number
  /** Lines held, and lines on the host, at the last tick. */
  held: number
  lines: number
  /** Full view: compared ticks before every line was held (the join's puts spill over frames),
   * and whether every line has been held since. */
  partial: number
  whole: boolean
}

/**
 * Runs `ticks` ticks; after each, every line the client holds (and knows the items of) must hold
 * exactly the host's items, kind and position, front to back. Throws naming the world, tick and
 * line on the first difference. The client may lag the host only before the first compared tick
 * (the join); a lagging tick after it fails. `fullView`: the whole world is in view, so once every
 * host line is held (the join's puts spill over a few frames) every compared tick must hold all.
 * `before(i)` runs before tick `i` is advanced (a scenario's dispatches; M48b).
 */
export async function arbitrate(
  h: NetHarness,
  index: number,
  label: string,
  ticks: number,
  fullView = false,
  before?: (i: number) => void,
): Promise<Seen> {
  const client = h.clients[index]
  if (!client) throw new Error(`no client ${index}`)
  const seen: Seen = {
    ticks: 0,
    lagging: 0,
    caughtUp: 0,
    compared: 0,
    items: 0,
    unknown: 0,
    maxHeld: 0,
    held: 0,
    lines: 0,
    partial: 0,
    whole: false,
  }
  for (let i = 0; i < ticks; i++) {
    before?.(i)
    const frames = h.counters(index).frames
    await h.advanceTicks(1)
    const hd = hostItems(h)
    let held = 0
    let lagging = false
    let caught = false
    // M49: a line holder gets a frame every tick, so a tick without one is a held frame (degrade)
    // or a lost one (`link(i).dropNext`, a header-only or hashes-only frame): the client's last frame
    // is older than this tick. Read once a tick (`status()` crosses the ABI).
    const noFrame = h.counters(index).frames === frames || client.status().tick < hd.tick
    for (const hl of hd.lines) {
      let cd = lineItems(client, hl.id)
      if (cd === null) continue
      held++
      if (cd.tick !== hd.tick && cd.tick >= 0 && !caught && noFrame) {
        // No frame for this tick: nothing changed for the client. It steps this tick when its
        // next frame comes, by the same call (`on_frame` catches up first); the arbiter takes
        // that step now to compare this tick (the native arbiter's rule).
        client.forecastCatchUp(hd.tick)
        caught = true
        seen.caughtUp++
        cd = lineItems(client, hl.id)
        if (cd === null) throw new Error(`${label}: line ${hl.id} dropped by a catch-up`)
      }
      if (cd.tick !== hd.tick) {
        if (seen.ticks > 0) {
          throw new Error(
            `${label}: tick ${hd.tick}: line ${hl.id}: the client is at tick ${cd.tick} after the join`,
          )
        }
        lagging = true
        break
      }
      const l = cd.lines[0]
      if (!l) throw new Error(`${label}: line ${hl.id}: empty dump`)
      if (l.unknown) {
        seen.unknown++
        continue
      }
      const want = hl.items
      if (l.items.length !== want.length || l.items.some((v, k) => v !== want[k])) {
        expect(
          pairs(l.items),
          `${label}: tick ${hd.tick}: line ${l.id}: client vs host (items as [item, pos])`,
        ).toEqual(pairs(want))
      }
      seen.compared++
      seen.items += want.length / 2
    }
    if (lagging || held === 0) {
      if (seen.ticks > 0) throw new Error(`${label}: tick ${hd.tick}: no line held after the join`)
      seen.lagging++
      continue
    }
    if (fullView) {
      if (held === hd.lines.length) seen.whole = true
      else if (seen.whole) {
        // Once the join has put every line, a line in view is never dropped (a budget `Gone`
        // would leave it uncompared while it is gone).
        throw new Error(`${label}: tick ${hd.tick}: ${held} of ${hd.lines.length} lines held`)
      } else seen.partial++
    }
    seen.ticks++
    seen.maxHeld = Math.max(seen.maxHeld, held)
    seen.held = held
    seen.lines = hd.lines.length
  }
  return seen
}

export function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < flat.length; k += 2) out.push([flat[k] as number, flat[k + 1] as number])
  return out
}

/** M48b: how many `Welcome`s link `link` received, and every downlink frame (bundles split) after
 * the last, from `harness.trace()` (`[t u32][link u32][dir u8][len u32][bytes]` an entry, dir 0
 * down; a `Welcome` opens with `0x03`, as in `net-harness.ts`'s `reconnectCost`). */
export function framesAfterWelcome(
  trace: Uint8Array,
  link: number,
): { welcomes: number; frames: ParsedFrame[] } {
  const view = new DataView(trace.buffer, trace.byteOffset, trace.byteLength)
  let out: ParsedFrame[] = []
  let welcomes = 0
  let off = 0
  while (off < trace.length) {
    const l = view.getUint32(off + 4, true)
    const dir = trace[off + 8]
    const len = view.getUint32(off + 9, true)
    const bytes = trace.subarray(off + 13, off + 13 + len)
    off += 13 + len
    if (l !== link || dir !== 0) continue
    if (bytes[0] === 0x03) {
      welcomes++
      out = []
    } else out.push(...parseMessage(bytes))
  }
  return { welcomes, frames: out }
}
