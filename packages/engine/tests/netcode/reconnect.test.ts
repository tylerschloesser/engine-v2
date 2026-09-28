// `reconnect` (docs/plan/28b-reconnect-and-lifecycle.md steps 3-5, Tests added): pending-action
// resend and `Lost` (step 3), grace and its interaction with the logged connection events (step
// 4), the resume-hint round trip and its own bandwidth cost (step 5). Steps 1-2's own coverage
// (`epoch-and-resync.test.ts`) is Non-scope here.
import { expect, test } from 'vitest'
import type { ActionOutcome } from '../../src/client.js'
import { SessionState } from '../../src/clock-block.js'
import { worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { expectWithinBudget } from '../support/budgets.js'
import { putsFixture, square } from './support.js'

/** Wire `SectionId` (`crates/engine/src/wire/mod.rs`'s own single home) -- a private local mirror,
 * the same "duplicated here rather than shared/exported" precedent `frameRecordCount` above
 * documents for this file. */
const SECTION = {
  Global: 2,
  OwnPlayer: 3,
  ChunkEnterPristine: 4,
  ChunkSnapshots: 5,
  Presence: 8,
  ChunkKeeps: 11,
} as const

/** A downlink message's own leading byte for `MsgType::Welcome` (`wire/mod.rs`), and the low byte
 * every `Hello`/`Reject` frozen prefix opens with (`session::MAGIC`, 0024 §8: "the first wire
 * byte is `>= 0x80`") -- the same two constants `net-harness.ts`'s own `reconnectCost` uses to spot
 * a handshake inside the raw trace. */
const MSG_TYPE_WELCOME = 0x03
const HELLO_FIRST_BYTE_FLOOR = 0x80

function readVarint(bytes: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0
  let shift = 0
  let i = pos
  for (;;) {
    const byte = bytes[i]
    if (byte === undefined) throw new Error('reconnect: truncated varint in frame bytes')
    i++
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result >>> 0, i]
    shift += 7
  }
}

/** Every `SectionId` a wire `Frame` carries (0011: `[type u8][flags u8][tick u32][ack_seq u32]`,
 * 10 bytes, then `[section_id u8][len varint][bytes]*`). */
function frameSectionIds(bytes: Uint8Array): Set<number> {
  const ids = new Set<number>()
  let off = 10
  while (off < bytes.length) {
    const id = bytes[off] as number
    off += 1
    const [len, next] = readVarint(bytes, off)
    ids.add(id)
    off = next + len
  }
  return ids
}

/** A `Frame`'s own section body for `id`, or `null` if absent (`frameSectionIds`'s own loop,
 * generalised to hand back the bytes instead of just the id). */
function sectionBody(bytes: Uint8Array, id: number): Uint8Array | null {
  let off = 10
  while (off < bytes.length) {
    const sid = bytes[off] as number
    off += 1
    const [len, next] = readVarint(bytes, off)
    if (sid === id) return bytes.subarray(next, next + len)
    off = next + len
  }
  return null
}

/** `wire/presence.rs`'s own `Presence` section body (id 8): a flat list of `who varint · tag u8`
 * entries (tag `0` = `Sample`, continuing with `age_ticks varint` + a `Codec` payload this helper
 * never needs to skip past -- `reconnect/presence-vanishes-at-once`'s own two-player scenario means
 * `witness`'s Presence section never names anyone but `departing`, so reading the first entry's
 * `who`/`tag` pair is reading the whole section). `false` when the section is absent, empty, or
 * names a different player, or is a `Sample` (still present), not a `Gone`. */
function presenceGoneFor(frame: Uint8Array, who: number): boolean {
  const body = sectionBody(frame, SECTION.Presence)
  if (!body || body.length === 0) return false
  const [entryWho, next] = readVarint(body, 0)
  if (entryWho !== who) return false
  return body[next] === 1
}

/** `harness.trace()`'s own encoding (`net-harness.ts`'s `encodeTrace`): `[t u32][link u32][dir
 * u8][len u32][bytes]` per entry, back to `{link, dir, bytes}` triples. */
function decodeTrace(bytes: Uint8Array): { link: number; dir: 0 | 1; bytes: Uint8Array }[] {
  const out: { link: number; dir: 0 | 1; bytes: Uint8Array }[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 0
  while (off < bytes.length) {
    const link = view.getUint32(off + 4, true)
    const dir = bytes[off + 8] as 0 | 1
    const len = view.getUint32(off + 9, true)
    const start = off + 13
    out.push({ link, dir, bytes: bytes.subarray(start, start + len) })
    off = start + len
  }
  return out
}

/** The first downlink message after `linkIdx`'s own *most recent* `Welcome` -- "the first frame
 * after resume" (Tests added). Mirrors `net-harness.ts`'s own `reconnectCost` scan: every fresh
 * `Hello` resets the search, so scanning the *whole* trace (never returning early) is what makes
 * this the *last* episode's own frame, not the first-ever one. */
function firstFrameAfterWelcome(traceBytes: Uint8Array, linkIdx: number): Uint8Array {
  let sawWelcome = false
  let done = false
  let found: Uint8Array | null = null
  for (const e of decodeTrace(traceBytes)) {
    if (e.link !== linkIdx) continue
    const first = e.bytes[0] ?? 0
    if (e.dir === 1 && first >= HELLO_FIRST_BYTE_FLOOR) {
      sawWelcome = false
      done = false
      continue
    }
    if (done || e.dir !== 0) continue
    if (!sawWelcome) {
      sawWelcome = first === MSG_TYPE_WELCOME
      continue
    }
    found = e.bytes
    done = true
  }
  if (!found)
    throw new Error(`firstFrameAfterWelcome: no Hello/Welcome/frame found for link ${linkIdx}`)
  return found
}

/** A write-ahead log frame's own `count` field (0005 Formats), the same reader `handshake.
 * test.ts`'s own `frameRecordCount` uses -- duplicated here rather than shared/exported, matching
 * that file's own precedent of a small private reader per test file. */
function frameRecordCount(frame: Uint8Array): number {
  let pos = 0
  for (let i = 0; i < 2; i++) {
    // skip `len varint`, then `tick_delta varint`
    for (;;) {
      const b = frame[pos]
      pos++
      if (b === undefined || (b & 0x80) === 0) break
    }
  }
  let value = 0
  let shift = 0
  for (;;) {
    const b = frame[pos]
    if (b === undefined) throw new Error('frameRecordCount: truncated')
    pos++
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return value >>> 0
    shift += 7
  }
}

test('reconnect/pending-resent-once', async () => {
  const seed = 3001
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const results: [number, ActionOutcome][] = []
    client.onActionResult((seq, result) => results.push([seq, result]))

    // Dispatched but never flushed to the wire (0 ticks advanced): the connection dies before the
    // action is even sent, let alone admitted -- the host has never seen it.
    const seq = client.dispatch({ Paint: { pos: { x: 3, y: 3 }, base: 1, resource: 0 } })
    harness.link(0).disconnect()
    harness.link(0).reconnect()

    await harness.settle()
    harness.assertConverged()

    // Resent on the reconnect's own `Welcome` (`unacked_after`) and applied exactly once: a
    // `Confirmed` (or a game rejection) shows up, never `Lost` (which would mean the host claims
    // to have already processed it before it was ever sent).
    const own = results.filter(([s]) => s === seq)
    expect(own.length).toBeGreaterThan(0)
    expect(own.some(([, r]) => r === 'Lost')).toBe(false)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/lost-ack-reports-lost', async () => {
  const seed = 3002
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const results: [number, ActionOutcome][] = []
    client.onActionResult((seq, result) => results.push([seq, result]))

    const seq = client.dispatch({ Paint: { pos: { x: 4, y: 4 }, base: 1, resource: 0 } })
    // Exactly 2: the action is flushed to the wire on tick 1's own `stepFrame` and admitted
    // (`on_uplink`) on tick 2's own delivery release -- *not yet applied* (that needs tick 3's own
    // `sim_tick()`). Disconnecting here, before a 3rd `advanceTicks` call, guarantees the drop
    // happens before the ack could ever have been built, let alone delivered: `pending_records` is
    // sim state, not connection state, so grace-period ticking still applies it once reconnected,
    // but with no live `ConnSlot` left to carry a `Confirmed` ack through at the time it does.
    await harness.advanceTicks(2)
    harness.link(0).disconnect()
    harness.link(0).reconnect()

    await harness.settle()
    harness.assertConverged()

    const own = results.filter(([s]) => s === seq)
    expect(own.some(([, r]) => r === 'Lost')).toBe(true)
    // Applied exactly once: no `Confirmed`/`Rejected` from a duplicate re-admit riding the resend
    // (the host's own dedup floor, `store.last_seq`, drops it) -- `Lost` is the only verdict this
    // seq ever gets.
    expect(own.every(([, r]) => r === 'Lost')).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/bye-skips-grace', async () => {
  const seed = 3003
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const simHost = worldServerTestHandle(harness.server)
    let records = 0
    const originalLogSink = simHost.logSink
    simHost.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      originalLogSink?.(bytes)
    }

    // `HeadlessClient.leave()`: sends `Bye{Leave}` then closes -- 0013 "an explicit `Bye` skips
    // the grace" (`host/lifecycle.ts`'s `playerLeft`, not `connectionDropped`).
    client.leave()
    // Nowhere near the 10 s grace: `Disconnected` must already be logged well inside this window
    // if `Bye` really skipped the grace timer rather than merely starting a shorter one.
    await harness.advanceTicks(5)

    expect(records).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/within-grace-logs-nothing', async () => {
  const seed = 3004
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const simHost = worldServerTestHandle(harness.server)
    let records = 0
    const originalLogSink = simHost.logSink
    simHost.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      originalLogSink?.(bytes)
    }

    // An ungraceful close, immediately reconnected (well inside the 10 s grace): the log must
    // gain no record at all from this whole episode -- neither `Disconnected` (the grace timer is
    // cancelled by the reconnect before it can fire) nor `Connected` (`suppressConnected`, `host/
    // handshake.ts`'s own `buildAttachInput` field, set from `lifecycle.isWithinGrace`).
    harness.link(0).disconnect()
    harness.link(0).reconnect()
    await harness.settle()
    harness.assertConverged()

    expect(records).toBe(0)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/presence-vanishes-at-once', async () => {
  const seed = 3007
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 2 })
  try {
    const departing = harness.clients[0]
    const witness = harness.clients[1]
    if (!departing || !witness) throw new Error('need 2 clients')
    // The same camera for both, not `square()`'s own per-index spread: a departing presence
    // sample's relay chunk is derived from its own camera centre (`PutsClient::frame`), so an
    // identical centre guarantees `witness`'s connection is subscribed to it and therefore already
    // holds a `presence_relayed` entry for `departing` before the drop -- `host/mod.rs`'s own
    // `Gone` loop (steps 4-6) only ever fires for a player a connection has *already* been relayed
    // a sample for.
    departing.setCamera(square(0))
    witness.setCamera(square(0))
    await harness.settle()
    harness.assertConverged()

    const departingId = departing.status().ownPlayerId

    // Only this episode's own frames: everything already in the trace is join traffic.
    const beforeLen = harness.trace().length

    // An ungraceful close (no `Bye`): `host/mod.rs`'s own `Host::disconnect` removes the presence
    // sample immediately, synchronously with this call (`server.ts`'s `connection.onClose` calls
    // `sim.simDetach` straight away, before any tick) -- 0013 "A disconnected player's state:
    // Presence vanishes from other clients at once", distinct from the logged `Disconnected`
    // record, which waits out the 10 s/200-tick grace (`reconnect/after-grace-logs-disconnected`).
    // A handful of ticks, nowhere near that grace, is ample for the very next `build_frame` for
    // `witness`'s own connection to relay the `Gone`.
    harness.link(0).disconnect()
    await harness.advanceTicks(5)

    const episode = decodeTrace(harness.trace().subarray(beforeLen))
    const gone = episode.some(
      (e) => e.link === 1 && e.dir === 0 && presenceGoneFor(e.bytes, departingId),
    )
    expect(gone).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/panic-recovery-resync', async () => {
  const seed = 3006
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()
    harness.assertConverged()

    // `harness.panicServer()` (from M24's own Deviations, this milestone's to build): `trapSim` +
    // `await simHost.recover()` -- the open connection stays open (Traps: "Connections stay open
    // across recovery"), sees a second `Welcome` at the new epoch, and converges again.
    await harness.panicServer()
    await harness.settle()

    expect(worldServerTestHandle(harness.server).epoch).toBeGreaterThan(0)
    expect(client.status().sessionState).toBe(SessionState.Online)
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('reconnect/after-grace-logs-disconnected', async () => {
  const seed = 3005
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.settle()

    const simHost = worldServerTestHandle(harness.server)
    let records = 0
    const originalLogSink = simHost.logSink
    simHost.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      originalLogSink?.(bytes)
    }

    harness.link(0).disconnect()
    // Still inside the 10 s grace (200 ticks @ 50 ms): nothing logged yet.
    await harness.advanceTicks(150)
    expect(records).toBe(0)

    // Past the grace: `Disconnected` is queued by the timer and applied at the next tick.
    await harness.advanceTicks(100)
    expect(records).toBeGreaterThan(0)
  } finally {
    await harness.dispose()
  }
})

/** `fx-puts`'s own `tick()` autonomously paints one tile of a fixed 8-tile walk within `[-1, 1]`
 * on both axes, once per simulated second, regardless of any player action (`support.ts`'s own
 * `square()` doc comment does not warn of this -- found live, this file's own Deviations: a
 * `square(0)`-centred reconnect scenario kept seeing a real, correct `ChunkSnapshots` entry for
 * the walk's own chunk, not a `keep`, because that chunk genuinely changes version every second).
 * A camera far from the origin sees none of it -- true "wilderness" for these tests' own purposes
 * (0013 Reconnect, PRE-PLAN.md §7 "Bandwidth per client, burst": "reconnect ... in wilderness"). */
function wilderness(): { x: number; y: number; tilesAcross: number } {
  return { x: 100_000, y: 100_000, tilesAcross: 20 }
}

test('reconnect/resume-keeps-unchanged-chunks', async () => {
  const seed = 3008
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(wilderness())
    await harness.settle()
    harness.assertConverged()

    // Nothing about the world or this client's own camera changes across the drop: every chunk
    // the resume hint names should come back a `keep` (0013 Reconnect: "version equal -> keep").
    harness.link(0).disconnect()
    harness.link(0).reconnect()
    await harness.settle()
    harness.assertConverged()

    const frame = firstFrameAfterWelcome(harness.trace(), 0)
    const ids = frameSectionIds(frame)
    // "the first frame after the resume still carries Global+OwnPlayer sections although every
    // chunk is kept" (Tests added): `first_frame_pending` forces both regardless of what the
    // chunk-keep diff did.
    expect(ids.has(SECTION.Global)).toBe(true)
    expect(ids.has(SECTION.OwnPlayer)).toBe(true)
    // Every chunk kept: no fresh materialization needed at all.
    expect(ids.has(SECTION.ChunkKeeps)).toBe(true)
    expect(ids.has(SECTION.ChunkEnterPristine)).toBe(false)
    expect(ids.has(SECTION.ChunkSnapshots)).toBe(false)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/changed-while-away', async () => {
  const seed = 3009
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 2 })
  try {
    const client = harness.clients[0]
    const painter = harness.clients[1]
    if (!client || !painter) throw new Error('need 2 clients')
    client.setCamera(wilderness())
    painter.setCamera(wilderness())
    await harness.settle()
    harness.assertConverged()

    // `harness.link(0).disconnect()` alone (no matching `.reconnect()` yet) still arms
    // `createLink`'s own 0 ms backoff, which fires on the very next clock advance and wastes one
    // dial against the now-dead pipe (a silent no-op send, `net/link.ts`'s own `DEAD_MS`/
    // `BACKOFF_SCHEDULE_MS`) -- but unlike calling `.reconnect()` only *after* ticks have already
    // passed (which leaves `createLink` stuck believing itself connected forever, found live: an
    // earlier draft of this test did exactly that, and `assertConverged`'s own host-side hash came
    // back all-zero, an *empty* subscription, not a mismatched one), waiting out the *own*
    // `DEAD_MS` (3 s) lets `createLink` notice on its own and re-arm a real backoff timer, so a
    // `.reconnect()` call after that still lands cleanly on the very next attempt.
    harness.link(0).disconnect()

    // While client 0 is away, `painter` (still connected throughout) changes a chunk client 0
    // holds (0013 Reconnect: "different ... -> snapshot") -- `DEAD_MS` (60 ticks @ 50 ms) is
    // ample time for the action to admit and apply well before client 0 ever redials.
    // `base: 2` (not `fx-puts`'s own `FlatWorldgen` pristine value, `Tile::new(1, 0, 0)`): a
    // paint that happens to write back the exact pristine tile leaves the chunk's own overlay
    // empty (`has_overlay` false), so it would re-enter as `ChunkEnterPristine` rather than
    // `ChunkSnapshots` -- a real distinction (0011: pristine carries no version at all, so a
    // client that enters it that way always records version 0, `Replica::apply_enter_pristine`),
    // not a bug this milestone owns; picking a genuinely different tile value avoids it.
    painter.dispatch({ Paint: { pos: { x: 100_000, y: 100_000 }, base: 2, resource: 0 } })
    await harness.advanceTicks(65)

    harness.link(0).reconnect()
    await harness.settle()
    harness.assertConverged()

    // The changed chunk must come back as a real snapshot, not a `keep` -- `assertConverged`
    // above already proves correctness, this proves *how*.
    const frame = firstFrameAfterWelcome(harness.trace(), 0)
    const ids = frameSectionIds(frame)
    expect(ids.has(SECTION.ChunkSnapshots)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test('reconnect/cost', async () => {
  const seed = 3010
  // A wilderness reconnect (PRE-PLAN.md §7 "Bandwidth per client, burst": "reconnect ≈ 1
  // KB each way"; 0013 Reconnect: "Cost: one RTT plus <= ~1 KB up and typically ~1 KB down") --
  // far from `fx-puts`'s own once-a-second origin paint (`wilderness()`'s own doc comment), so
  // every kept chunk needs zero bytes beyond its own 3-byte coordinate entry.
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(wilderness())
    await harness.settle()
    harness.assertConverged()

    harness.link(0).disconnect()
    harness.link(0).reconnect()
    await harness.settle()
    harness.assertConverged()

    const { reconnectBytesUp, reconnectBytesDown } = harness.counters(0)
    expectWithinBudget('counters.reconnect.wildernessBytesUp', reconnectBytesUp)
    expectWithinBudget('counters.reconnect.wildernessBytesDown', reconnectBytesDown)
  } finally {
    await harness.dispose()
  }
})
