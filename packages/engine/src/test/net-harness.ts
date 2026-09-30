// `createNetHarness` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Seams; docs/decisions/
// 0020-testing-strategy.md §7): one Node process, the real server-side machinery over the real
// `.wasm`, K `HeadlessClient`s, joined by in-memory `Connection` pairs behind a seeded `conditionLink`
// on a `VirtualClock`.
//
// `server: WorldServer` (M27 gate round 2): built through the real, public `createWorldServer(cfg,
// host)` entrypoint -- the brief's own Goal, "runs that real server". Gate round 1 found that
// `assertConverged`/`hostRegionHash` need a *live, connected* `SimHost` (`region_hash(conn)`,
// `host/mod.rs`, reads the live connection table -- subscriptions, `slot.player` -- which
// `Persistence.open`'s own replay never reconstructs, M22b Deviations), and `WorldServer`'s fixed
// 0024 §5 shape (`{ ready, accept, stop }`) has no seam for one. Gate round 2's fix:
// `worldServerTestHandle(server): SimHost` (`server.ts`, the same module-private-`WeakMap`-keyed-
// by-the-public-object pattern `client.ts`'s `clientTestHandle` already uses) reaches the real
// `SimHost` `createWorldServer` builds internally, without widening `WorldServer`'s own type --
// `SimHost` itself gained one small additive method, `regionHash(conn)` (wrapping `Host::
// region_hash` the same way `hash()` already wraps `Host::state_hash`), since nothing on `SimHost`
// previously exposed a per-connection hash at all. Ticking still goes through `SimHost.stepTick(n)`
// (`worldServerTestHandle(server).stepTick(1)`, the manual driver `stepTick`/`onFire` both call),
// interleaved tick-by-tick with `VirtualClock.advanceBy(tickMs)` so a conditioner's own `send`-time
// draws see the correct virtual "now" (`conditioner.ts`'s own Deviations).
import { Role } from '../abi.js'
import { hexDecode } from '../host/sessions.js'
import { instantiate } from '../loader.js'
import {
  type ConditionedLink,
  type ConditionerConditions,
  conditionLink,
} from '../net/conditioner.js'
import { memoryConnectionPair } from '../net/memory-connection.js'
import { wsConnection } from '../net/ws-connection.js'
import {
  buildSimInstanceConfig,
  type Connection,
  createWorldServer,
  type MsgClass,
  serverInternals,
  type WorldConfig,
  type WorldServer,
  worldServerTestHandle,
} from '../server.js'
import { loadGame, type WsSocketLike, wsSocketConnection } from '../server-node.js'
import { type MemoryStorage, memoryStorage } from '../storage/memory.js'
import type { Storage } from '../storage/types.js'
import { createHeadlessClient, type HeadlessClient } from './headless-client.js'
import { addFrame, emptyTotals, parseFrame, worstWindowBytes } from './net-sections.js'
import { trapSim } from './trap.js'
import { createVirtualClock, type VirtualClock } from './virtual-clock.js'

/**
 * docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Scope: "`createNetHarness({ transport:
 * 'ws' })` puts `conditionLink` around real sockets on `127.0.0.1:0`"): a synchronous `Connection`
 * proxy over a `Connection` that only exists once `promise` settles (Deviations: not one of this
 * milestone's pinned Seam names -- `makeClient`/`reconnectEntry`/`connectRaw` below all build their
 * two raw ends, then `conditionLink` them, *synchronously*, the same shape the `memory` transport's
 * own `memoryConnectionPair()` already gives them; a real `ws` server's own `'connection'` event
 * only fires once the underlying accept actually completes, asynchronously, so this is what lets
 * the `ws` transport keep that exact same synchronous shape). `send()`/`close()` before `promise`
 * settles queue (a copy: 0009's "valid only during the call"); `onMessage`/`onClose` set on this
 * proxy by `conditionLink` are re-dispatched from the real connection once it exists.
 */
function deferredConnection(promise: Promise<Connection>): Connection {
  let real: Connection | null = null
  let closed = false
  let pendingCloseCode: number | null = null
  const pendingSends: { cls: MsgClass; bytes: Uint8Array }[] = []
  const proxy: Connection = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send(cls, bytes, len?: number) {
      if (closed) return
      const copy = (len === undefined ? bytes : bytes.subarray(0, len)).slice()
      if (real) real.send(cls, copy)
      else pendingSends.push({ cls, bytes: copy })
    },
    close(code) {
      if (closed) return
      closed = true
      if (real) real.close(code)
      else pendingCloseCode = code
    },
  }
  promise.then((r) => {
    if (pendingCloseCode !== null) {
      r.close(pendingCloseCode)
      return
    }
    real = r
    real.onMessage = (bytes) => proxy.onMessage?.(bytes)
    real.onClose = (code) => proxy.onClose?.(code)
    for (const m of pendingSends) real.send(m.cls, m.bytes)
    pendingSends.length = 0
  })
  return proxy
}

/** docs/plan/30c-ci-reds-after-m30.md (red B): one loopback socket's message accounting. Both ends
 * of every `ws` link live in this process, so the harness can know exactly how many whole messages
 * each direction has sent but not yet delivered (a `WebSocket` keeps message boundaries). */
interface WsPairStats {
  key: string
  c2hSent: number
  c2hRecv: number
  h2cSent: number
  h2cRecv: number
  /** Which end called `close()`, and which end is down (called it, or saw the other end's close
   * arrive). A close frame is in flight until the other end is down; messages sent toward an end
   * that is down never arrive and stop counting. */
  hostCalledClose: boolean
  clientCalledClose: boolean
  hostDown: boolean
  clientDown: boolean
  /** Sequence numbers (`WsOrder`) of each direction's sends not yet arrived, oldest first, and of
   * each end's own `close()` call. */
  c2hSeqs: number[]
  h2cSeqs: number[]
  hostCloseSeq: number | undefined
  clientCloseSeq: number | undefined
}

function wsInFlight(p: WsPairStats): number {
  let n = 0
  if (!p.hostDown) n += p.c2hSent - p.c2hRecv + (p.clientCalledClose ? 1 : 0)
  if (!p.clientDown) n += p.h2cSent - p.h2cRecv + (p.hostCalledClose ? 1 : 0)
  return n
}

/** docs/plan/30c-ci-reds-after-m30.md (red B, spike C): the order `ws` arrivals are handed on in.
 * Real arrival order across *different* sockets is whatever the OS poll returns, so arrivals are
 * held and released by `wsDelivered` in the order they were sent (one harness-wide sequence;
 * each direction of one socket is FIFO, so an arrival's sequence is the front of its direction's
 * queue). Sends are released by the `VirtualClock` in one deterministic order, which makes the
 * release order, and so `trace()`, a function of `(seed, scenario)` alone. */
interface WsOrder {
  seq: number
  held: { seq: number; run: () => void }[]
}

/** A raw `ws` end that counts into `stats` and holds each arrival in `order.held`: `send` counts as
 * sent in its own direction, each arrival as received in the other. Sits under `conditionLink`, so
 * it sees real socket traffic only, never the conditioner's virtual-time holds. */
function countedEnd(
  raw: Connection,
  stats: WsPairStats,
  side: 'host' | 'client',
  order: WsOrder,
): Connection {
  const withLen = raw as Connection & {
    send: (cls: MsgClass, bytes: Uint8Array, len?: number) => void
  }
  const end: Connection = {
    datagrams: raw.datagrams,
    onMessage: null,
    onClose: null,
    send(cls, bytes, len?: number) {
      if (side === 'client') {
        stats.c2hSent++
        stats.c2hSeqs.push(++order.seq)
      } else {
        stats.h2cSent++
        stats.h2cSeqs.push(++order.seq)
      }
      withLen.send(cls, bytes, len)
    },
    close(code) {
      if (side === 'client') {
        stats.clientCalledClose = !stats.clientDown
        stats.clientDown = true
        stats.clientCloseSeq = ++order.seq
      } else {
        stats.hostCalledClose = !stats.hostDown
        stats.hostDown = true
        stats.hostCloseSeq = ++order.seq
      }
      raw.close(code)
    },
  }
  raw.onMessage = (bytes) => {
    const seq = (side === 'client' ? stats.h2cSeqs.shift() : stats.c2hSeqs.shift()) ?? ++order.seq
    if (side === 'client') stats.h2cRecv++
    else stats.c2hRecv++
    const copy = bytes.slice()
    order.held.push({ seq, run: () => end.onMessage?.(copy) })
  }
  raw.onClose = (code) => {
    // The other end's own `close()` call fixes this arrival's place; a close nobody here called
    // (a socket torn down underneath) takes the next sequence as it arrives.
    const seq = (side === 'client' ? stats.hostCloseSeq : stats.clientCloseSeq) ?? ++order.seq
    if (side === 'client') stats.clientDown = true
    else stats.hostDown = true
    order.held.push({ seq, run: () => end.onClose?.(code) })
  }
  return end
}

/** Real time `advanceTicks` waits for every open `ws` link to deliver what it has sent before it
 * throws, naming the links still holding messages. Loopback delivery takes about a millisecond;
 * this only bounds a socket that never delivers, well inside Vitest's 5 s default. */
const WS_DELIVERY_DEADLINE_MS = 2_000

/** docs/plan/28-sessions-and-reconnect.md Seams: a deterministic per-(seed, index) 128-bit secret
 * -- `createNetHarness`'s own default when `opts.secrets` names none for a given client, so a
 * scenario that never cares about identity still gets a real, reproducible one (0020 §7: "the seed
 * ... alone reproduces a run"). A trivial splitmix64-style mix, not `crypto.getRandomValues`
 * (banned outside `src/client/secret.ts`, `no-ambient-random.test.ts`'s own allowlist) -- this is
 * determinism, not identity security, the same standing `conditionLink`'s own seeded jitter has. */
function deterministicSecret(seed: number, index: number): Uint8Array {
  let state = (BigInt(seed) ^ (BigInt(index) * 0x9e3779b97f4a7c15n)) & 0xffff_ffff_ffff_ffffn
  const out = new Uint8Array(16)
  for (let i = 0; i < out.length; i++) {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffff_ffff_ffff_ffffn
    let z = state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffff_ffff_ffff_ffffn
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffff_ffff_ffff_ffffn
    z = z ^ (z >> 31n)
    out[i] = Number(z & 0xffn)
  }
  return out
}

export interface NetHarnessCounters {
  bytesDown: number
  bytesUp: number
  messagesDown: number
  messagesUp: number
  perTick: { tick: number; bytesDown: number; bytesUp: number }[]
  /** docs/plan/28b-reconnect-and-lifecycle.md step 5 (Seams: "`NetCounters.reconnectBytesUp/Down`
   * (bytes between a `Hello` and the first frame after its `Welcome`)"): this link's own *most
   * recent* handshake round trip -- the reconnect that just happened, or (if this link never
   * dropped) its original join. `reconnectBytesUp` is that `Hello`'s own byte length;
   * `reconnectBytesDown` is `Welcome`'s plus the very next downlink message's (`reconnect/cost`'s
   * own budget assertion). Both `0` before this link has ever sent a `Hello` (`counters(i)` called
   * before the very first `settle()`). */
  reconnectBytesUp: number
  reconnectBytesDown: number
  /** docs/plan/31-rates-and-integrity.md step 1: what the downlink `Frame` messages carried, parsed
   * from the trace (`net-sections.ts`), so a function of `(seed, scenario)` alone. `sections` is
   * whole-section wire bytes (id + length varint + body) by `SectionId` name; `header` the fixed
   * 10-byte frame headers; a `Welcome` or other non-frame message counts in `bytesDown` only.
   * `chunkEnters`/`chunkLeaves` count coordinates in `ChunkEnterPristine`/`ChunkLeaves` (a chunk
   * entered as a `ChunkSnapshots` entry is bytes in `sections`, not a coordinate here). */
  header: number
  sections: Record<string, number>
  frames: number
  heartbeats: number
  chunkEnters: number
  chunkLeaves: number
  /** Most downlink bytes any 1 s span of virtual time carried (`net.hardCeilingBytesPerS`'s input). */
  worstSecondBytesDown: number
}

/** A downlink message's own leading byte for `MsgType::Welcome` (`wire/mod.rs`) -- a private local
 * mirror, the same convention `worker/client-net.ts`'s own `MSG_TYPE_WELCOME` already uses (step 2
 * Deviations), since `Connection`'s wire bytes carry no exported "what kind of message is this"
 * accessor for a test-only trace to call. */
const MSG_TYPE_WELCOME = 0x03

/** `NetHarnessCounters.reconnectBytesUp/Down`'s own implementation: scans `trace` (chronological,
 * every message this whole harness has ever carried) for `linkIdx`'s own *last* `Hello` -- a
 * `Hello`/`Reject`'s frozen prefix opens with `session::MAGIC`'s low byte (`0x80`, 0024 §8:
 * "the first wire byte is `>= 0x80`"), which no ordinary post-handshake `MsgType` (`0x01..=0x05`)
 * can ever collide with -- then sums that `Hello`'s own bytes plus every downlink message up to and
 * including the first one *after* a `Welcome` (`MSG_TYPE_WELCOME`). A downlink message that is not
 * a `Welcome` (a `Reject`) closes the window immediately: there is no frame to wait for.
 */
function reconnectCost(trace: TraceEntry[], linkIdx: number): { up: number; down: number } {
  let up = 0
  let down = 0
  let sawWelcome = false
  let done = false
  for (const entry of trace) {
    if (entry.link !== linkIdx) continue
    const first = entry.bytes[0] ?? 0
    if (entry.dir === 1 && first >= 0x80) {
      // A fresh `Hello`: (re)start the window -- the *last* one in the trace wins.
      up = entry.bytes.length
      down = 0
      sawWelcome = false
      done = false
      continue
    }
    if (done || up === 0 || entry.dir !== 0) continue
    down += entry.bytes.length
    if (!sawWelcome) {
      sawWelcome = first === MSG_TYPE_WELCOME
      if (!sawWelcome) done = true // a `Reject`, or anything else: nothing to wait for
    } else {
      done = true // this is "the first frame after Welcome"
    }
  }
  return { up, down }
}

export interface NetHarnessOptions {
  /** A resolved `{ wasm, buildHash }` (`tests/support/fixtures.ts`'s own `loadFixture(name)`) or a
   * raw `buildGame()` output directory path, loaded here through `engine/server/node`'s `loadGame`
   * (`harness-accepts-build-dir`) -- `src/test/**` may import `server-node.js`: a plain function
   * call across modules, not a `node:` import of its own (exit criterion 3's own grep scans import
   * *specifiers*, not call graphs). */
  fixture: { wasm: WebAssembly.Module; buildHash: string } | string
  /** Seeds both `WorldConfig.params.seed` (decimal text) and every client link's own conditioner
   * (`seed + i * 2`, `conditionLink`'s own two-streams-per-link convention) -- one number drives
   * every source of randomness this harness touches, so `(seed, scenario)` alone reproduces a run
   * (0020 §7). */
  seed: number
  clients: number
  world?: Partial<Omit<WorldConfig, 'params'>> & {
    params?: Partial<Omit<WorldConfig['params'], 'seed'>>
  }
  /** docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Scope): `'ws'` puts `conditionLink`
   * around real loopback sockets (`wsConnection`/`wsSocketConnection`, `127.0.0.1:0`) instead of
   * `memoryConnectionPair()` -- everything else about the harness (ticking, `settle()`,
   * `assertConverged()`, `trace()`) is unchanged; only the bytes' own transport differs. Requires
   * the `ws` package (a devDependency of this repo, dynamically imported only when this transport
   * is actually requested -- `engine/test` itself declares no runtime dependency on it). */
  transport?: 'memory' | 'ws'
  conditions?: Partial<ConditionerConditions>
  /** docs/plan/30-interpolation.md step 4: how often every client steps a frame inside one host
   * tick, in virtual ms. Default (omitted): once per tick, exactly as before. A smaller value
   * (`12.5` = four frames per 50 ms tick) lets a client observe arrival times finer than a tick,
   * which the interpolation delay's jitter measurement needs; it must divide the tick. */
  clientFrameMs?: number
  /** docs/plan/28-sessions-and-reconnect.md Seams: `createNetHarness({ secrets?, joinKey? })` --
   * explicit per-client identity secrets, in join order. A client past the end of this array (or
   * every client, if omitted) gets `deterministicSecret(seed, index)`. */
  secrets?: Uint8Array[]
}

/** docs/plan/28b-reconnect-and-lifecycle.md step 3: `ConditionedLink` plus one harness-only
 * addition. */
export interface HarnessLink extends ConditionedLink {
  /** Builds a *fresh* `conditionLink` pair, `server.accept()`s its host-side end, and points this
   * same client's own `createLink`-driven redial (`HeadlessClient`'s `dial`) at the new
   * client-side end -- unlike `disconnect()` alone (whose own conditioner is left permanently
   * severed), this is what lets the *same* `HeadlessClient` (its own pending queue, secret, and
   * every other bit of client-side state intact) actually reconnect. Call once, synchronously,
   * right after `disconnect()` and before the next `advanceTicks`/`advanceTo`: `createLink`'s own
   * backoff schedule (`net/link.ts`) starts its first redial attempt at a 0 ms delay, so the very
   * next clock advance already dials the fresh connection this call installs. */
  reconnect(): void
}

export interface NetHarness {
  clock: VirtualClock
  server: WorldServer
  storage: Storage
  clients: HeadlessClient[]
  link(i: number): HarnessLink
  /** docs/plan/28-sessions-and-reconnect.md steps 3-5: `secret` (real, not `deterministicSecret`
   * derived) lets a scenario add a client that returns as, or supersedes, a *specific* earlier
   * identity -- omitted, this is exactly the pre-M28 behaviour. */
  addClient(secret?: Uint8Array): HeadlessClient
  /** docs/plan/28-sessions-and-reconnect.md Seams: a raw `Connection` end, joined to the real
   * server through the same `conditionLink`/`server.accept` path every `HeadlessClient` uses, but
   * with no `HeadlessClient` (and so no automatic `Hello`) attached -- a scenario writes its own
   * hand-rolled bytes to it directly (`connection.send(...)`) and reads the server's replies off
   * `connection.onMessage`, to test the handshake parser/`Reject`/timeout paths byte for byte. */
  connectRaw(): Connection
  /** docs/plan/28b-reconnect-and-lifecycle.md Seams: `restartServer(opts?: { crash?: boolean })` --
   * `opts.crash` false/omitted: `server.stop()` (a clean shutdown: snapshot-if-dirty, flush) then a
   * fresh `createWorldServer` over the *same* storage. `opts.crash: true`: skips `stop()` entirely
   * (0005 "Tab close, worker or renderer crash, WASM panic": no clean boundary at all) and builds
   * the fresh server over `storage.crashClone()` instead -- an independent copy, so nothing this
   * call does can affect a reference to the pre-crash storage a scenario kept. Either way the new
   * server's own epoch is the stored one plus one: `createWorldServer` itself bumps the epoch once
   * whenever `Persistence.open` finds an *existing* world (0013: "`epoch` increments at every host
   * start"; `server.ts`'s own doc comment on that call site), before its first `accept()`/`Welcome`
   * can ever read the stale value -- nothing extra to do here. Every open connection from the *old*
   * server is left exactly as `stop()`/a crash leaves it (this milestone's own scope: reconnecting
   * them onto the new server is `link(i).reconnect()`'s job, step 3/4). Existing `clients`/`link(i)`
   * entries are untouched; `addClient()` after this call accepts into the new server. */
  restartServer(opts?: { crash?: boolean }): Promise<void>
  /** docs/plan/28b-reconnect-and-lifecycle.md step 3 (from M24's own Deviations): forces a
   * deterministic trap on the *live* sim instance (`engine/test`'s `trapSim`, the M24 test trap
   * hook) and awaits `simHost.recover()` -- the trap alone only kills the instance; `recover()` is
   * what actually re-derives a fresh one from storage, bumps the epoch (`SimHost.onRecovered`,
   * wired in `createWorldServer`) and resyncs every open connection. Requires a world created with
   * persistence (every `createNetHarness` world is); throws if `serverInternals(server).
   * rawInstance` is unavailable (no `recoveryDeps`, never expected here). */
  panicServer(): Promise<void>
  /** The host's own tick count so far (`SimHost` `ticksRun`), the ground truth a clock test
   * compares a client's estimate against. */
  hostTick(): number
  advanceTo(t: number): Promise<void>
  advanceTicks(n: number): Promise<void>
  settle(): Promise<void>
  /**
   * `replicaHash() === hostRegionHash(conn)` per client (Seams), for every client. M27 gate round
   * 1: this used to need an `only` escape hatch, because `ClientInstance::init` hardcoded
   * `own_player = PlayerId(1)` for every client regardless of its real connection -- fixed by
   * threading each connection's real `PlayerId` through the client config
   * (`HeadlessClientOptions.myPlayerId`, `game_instance.rs`'s own `my_player_id` field, `connId +
   * 1` under M15's implicit accept), so this is now the brief's own plain no-argument check for
   * every scenario.
   */
  assertConverged(): void
  counters(i: number): NetHarnessCounters
  trace(): Uint8Array
  dispose(): Promise<void>
}

type TraceEntry = { t: number; link: number; dir: 0 | 1; tick: number; bytes: Uint8Array }

const DEFAULT_CONDITIONS: ConditionerConditions = { latencyMs: 0, jitterMs: 0 }
/** Generous relative to any conditioner latency/jitter/stall this milestone's own scenarios use:
 * enough extra ticks with no new client sends for every pending delivery to release and every
 * dispatched action's host verdict to arrive (the ledger's own "settle() must also mean pending
 * queues drained" note) -- not a rigorous quiescence poll (Deviations: this milestone's own scope
 * cut), but sufficient for `join-converges`/`late-join`'s "after quiescence" checks (0020 §7). */
const SETTLE_EXTRA_TICKS = 60

async function resolveFixture(
  fixture: NetHarnessOptions['fixture'],
): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  if (typeof fixture !== 'string') return fixture
  return loadGame(fixture)
}

export async function createNetHarness(opts: NetHarnessOptions): Promise<NetHarness> {
  const { wasm, buildHash } = await resolveFixture(opts.fixture)
  const worldCfg: WorldConfig = {
    worldId: opts.world?.worldId ?? 'net-harness',
    buildHash: opts.world?.buildHash ?? buildHash,
    params: {
      seed: String(opts.seed),
      worldgen: opts.world?.params?.worldgen ?? null,
      ...(opts.world?.params?.maxEntities !== undefined
        ? { maxEntities: opts.world.params.maxEntities }
        : {}),
      ...(opts.world?.params?.maxModifiedTiles !== undefined
        ? { maxModifiedTiles: opts.world.params.maxModifiedTiles }
        : {}),
      ...(opts.world?.params?.maxActionGrowth !== undefined
        ? { maxActionGrowth: opts.world.params.maxActionGrowth }
        : {}),
    },
    ...(opts.world?.joinKey !== undefined ? { joinKey: opts.world.joinKey } : {}),
    ...(opts.world?.maxPlayers !== undefined ? { maxPlayers: opts.world.maxPlayers } : {}),
    ...(opts.world?.cacheChunks !== undefined ? { cacheChunks: opts.world.cacheChunks } : {}),
    ...(opts.world?.arenaBytes !== undefined ? { arenaBytes: opts.world.arenaBytes } : {}),
    // docs/plan/28b-reconnect-and-lifecycle.md step 4: real bug found here -- never forwarded
    // before this milestone (0013 "World lifecycle": "unless `keepTickingWhenEmpty` is set"),
    // silently dropped by every scenario that passed it (none did, before `lifecycle.test.ts`).
    ...(opts.world?.keepTickingWhenEmpty !== undefined
      ? { keepTickingWhenEmpty: opts.world.keepTickingWhenEmpty }
      : {}),
  }
  const gameWorldgen = worldCfg.params.worldgen

  const clock = createVirtualClock()
  // docs/plan/28b-reconnect-and-lifecycle.md step 2: `let`, not `const` -- `restartServer` (Seams)
  // replaces both with a fresh pair on the same (or a `crashClone`d) storage. Every closure below
  // that reads `storage`/`server`/`simHost` (a `function` declaration, not a value captured at
  // definition time) sees the post-restart value on its very next call, including `makeClient`'s
  // own `server.accept(hostSide)` for a client added after a restart.
  let storage = memoryStorage()

  // A throwaway instance, read once and discarded, only to learn the real tick rate before ticking
  // (Deviations: `SimHost` itself exposes no `tickHz()` -- only the pacing arithmetic already
  // derived from it -- so `advanceTicks`'s own `clock.advanceBy` needs its own reading to stay in
  // lockstep with `stepTick`'s own ticks).
  const tickHzProbe = instantiate(wasm, Role.Sim, buildSimInstanceConfig(worldCfg))
  const tickMs = Math.round(1000 / (tickHzProbe.call0(tickHzProbe.x.tick_hz) || 20))

  const framesPerTick = Math.max(1, Math.round(tickMs / (opts.clientFrameMs ?? tickMs)))
  const frameMs = tickMs / framesPerTick

  function buildServer(onStorage: MemoryStorage): WorldServer {
    return createWorldServer(worldCfg, {
      wasm,
      storage: onStorage,
      clock: { now: () => clock.now() },
      timer: { every: () => () => {} }, // ticking is `simHost.stepTick`, driven from `advanceTicks`
      // docs/plan/28b-reconnect-and-lifecycle.md step 4: the real `VirtualClock` (also a real
      // `Scheduler`) -- grace/idle timers (`host/lifecycle.ts`) must fire deterministically as
      // `advanceTicks`/`advanceTo` advance virtual time, unlike `timer.every` above (stubbed: this
      // harness paces ticks manually).
      scheduler: clock,
    })
  }

  let server = buildServer(storage)
  await server.ready
  // The live `SimHost` `createWorldServer` owns (module doc comment above): `regionHash`/
  // `stepTick`/`counters` all read live, connected state no reopened reader can reach.
  let simHost = worldServerTestHandle(server)

  const trace: TraceEntry[] = []
  const nextLink = { i: 0 }

  type Entry = {
    client: HeadlessClient
    connId: number
    link: ConditionedLink
    linkIdx: number
    /** docs/plan/28b-reconnect-and-lifecycle.md step 3: reassigned by `reconnect()` -- the
     * `dial` closure below always reads this current value, never the one captured at
     * `makeClient` time. */
    setClientSide: (c: Connection) => void
    /** Distinct conditioner-seed offset per `reconnect()` call, so a second (or third) fresh pair
     * for the same client never draws the identical seeded sequence as the first. */
    reconnectCount: number
  }
  const entries: Entry[] = []

  function traced(conn: Connection, linkIdx: number, dir: 0 | 1): Connection {
    const wrapper: Connection = {
      datagrams: conn.datagrams,
      onMessage: null,
      onClose: null,
      send(cls, bytes, len?: number) {
        // `conn` here is always a `conditionLink`-produced end, whose own `makeSend` already
        // forwards a 3rd `len` verbatim to the underlying pair (`conditioner.ts`); the public
        // `Connection` type only ever declares the fixed 2-arg 0009 shape (Orchestrator ruling 2's
        // own optional-property cast pattern, `server.ts`'s `withLen`).
        const withLen = conn as Connection & {
          send: (cls: MsgClass, bytes: Uint8Array, len?: number) => void
        }
        withLen.send(cls, bytes, len)
      },
      close(code) {
        conn.close(code)
      },
    }
    conn.onMessage = (bytes) => {
      trace.push({
        t: clock.now(),
        link: linkIdx,
        dir,
        tick: simHost.counters.ticksRun,
        bytes: bytes.slice(),
      })
      wrapper.onMessage?.(bytes)
    }
    conn.onClose = (code) => {
      wrapper.onClose?.(code)
    }
    return wrapper
  }

  if (opts.transport !== undefined && opts.transport !== 'memory' && opts.transport !== 'ws') {
    throw new Error(`createNetHarness: unsupported transport '${opts.transport}' (M29, Non-scope)`)
  }

  // docs/plan/29-net-worker-and-reference-server.md steps 1-2: the `ws` transport's own real
  // loopback server, built once, lazily -- a `WebSocketServer` on `127.0.0.1:0` (an OS-assigned
  // port, so parallel test workers never collide), `perMessageDeflate` off (0009: "no
  // `permessage-deflate`", the same requirement `attachWebSocketServer` enforces for production).
  // Each new socket is correlated back to the `makeClient`/`reconnectEntry` call that is waiting for
  // it by a `?k=<linkIdx>:<reconnectCount>` query parameter on the dial URL -- the one piece of
  // information a real accept cannot otherwise recover (unlike `memoryConnectionPair()`, a real
  // `'connection'` event carries no caller-supplied correlation of its own).
  let wsPort = 0
  const wsPairs: WsPairStats[] = []
  const wsOrder: WsOrder = { seq: 0, held: [] }
  const pendingHostAccepts = new Map<string, (c: Connection) => void>()
  let wsServerClose: (() => Promise<void>) | null = null
  if (opts.transport === 'ws') {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    })
    const address = wss.address()
    if (typeof address === 'string' || address === null) {
      throw new Error('createNetHarness: ws transport: unexpected server address')
    }
    wsPort = address.port
    wss.on('connection', (socket, req) => {
      const key = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('k') ?? ''
      const resolve = pendingHostAccepts.get(key)
      pendingHostAccepts.delete(key)
      const conn = wsSocketConnection(socket as unknown as WsSocketLike)
      if (resolve) resolve(conn)
      else conn.close(0) // no scenario waiting on this key: stale/unexpected, refuse cleanly
    })
    wsServerClose = () =>
      new Promise<void>((resolve) => {
        // `WebSocketServer.close()`'s own callback fires only once the underlying `net.Server` has
        // closed, which Node's HTTP server machinery does not do while any socket it ever accepted
        // is still open -- a scenario here never explicitly closes its own sockets (that is
        // `HeadlessClient`/`SimHost`'s job over the *conditioned* connection, not this raw one), so
        // every client of this harness is still connected at `dispose()` time. `terminate()` (not
        // the graceful `close()`) on each tracked client first, same as a scenario abandoning its
        // sockets outright: nothing here needs a clean close handshake, only for the process to be
        // able to exit.
        for (const client of wss.clients) client.terminate()
        wss.close(() => resolve())
      })
  }

  /** The two raw ends `conditionLink` wraps, before any conditioning -- `memoryConnectionPair()`
   * (both ends exist synchronously) for the default transport, or a real dial against the harness's
   * own loopback `WebSocketServer` for `'ws'` (Deviations: the host side is a `deferredConnection`,
   * since a real accept is asynchronous; the client side, `wsConnection`, is synchronous by
   * construction -- see that module's own doc comment). */
  function rawPair(linkIdx: number, reconnectCount: number): [Connection, Connection] {
    if (opts.transport !== 'ws') return memoryConnectionPair()
    const key = `${linkIdx}:${reconnectCount}`
    const hostPromise = new Promise<Connection>((resolve) => pendingHostAccepts.set(key, resolve))
    const clientRaw = wsConnection(`ws://127.0.0.1:${wsPort}/?k=${key}`)
    const stats: WsPairStats = {
      key,
      c2hSent: 0,
      c2hRecv: 0,
      h2cSent: 0,
      h2cRecv: 0,
      hostCalledClose: false,
      clientCalledClose: false,
      hostDown: false,
      clientDown: false,
      c2hSeqs: [],
      h2cSeqs: [],
      hostCloseSeq: undefined,
      clientCloseSeq: undefined,
    }
    wsPairs.push(stats)
    return [
      countedEnd(deferredConnection(hostPromise), stats, 'host', wsOrder),
      countedEnd(clientRaw, stats, 'client', wsOrder),
    ]
  }

  /** docs/plan/30c-ci-reds-after-m30.md (red B): returns once every open `ws` link has delivered
   * every message it has sent, polling one real event-loop turn (`setTimeout(1)`) at a time, and
   * has handed every arrival on in send order (`WsOrder`: arrivals are held until then). What
   * the fixed 20 ms per-tick sleep before it only hoped for: that sleep cost every tick 20 ms or
   * more of real time whether or not anything was in flight (80-odd ticks, ~1.9 s of a 5 s test
   * budget, locally), and still guessed short when a socket was slower than 20 ms. */
  async function wsDelivered(): Promise<void> {
    const start = performance.now()
    for (;;) {
      let inFlight = 0
      for (const p of wsPairs) inFlight += wsInFlight(p)
      if (inFlight === 0) {
        if (wsOrder.held.length === 0) return
        // Everything sent so far has arrived: hand it on in send order (`WsOrder`). A handler may
        // send again, synchronously (a host reply), so go round until nothing is held or moving.
        const batch = wsOrder.held.splice(0).sort((a, b) => a.seq - b.seq)
        for (const h of batch) h.run()
        continue
      }
      const waited = performance.now() - start
      if (waited > WS_DELIVERY_DEADLINE_MS) {
        const stuck = wsPairs
          .filter((p) => wsInFlight(p) > 0)
          .map(
            (p) =>
              `link ${p.key}: c2h ${p.c2hRecv}/${p.c2hSent}, h2c ${p.h2cRecv}/${p.h2cSent}, ` +
              `closed by host ${p.hostCalledClose}/client ${p.clientCalledClose}, ` +
              `down host ${p.hostDown}/client ${p.clientDown}`,
          )
        throw new Error(
          `createNetHarness(ws): ${inFlight} message(s) still undelivered after ${Math.round(waited)} ms ` +
            `real time, before host tick ${simHost.counters.ticksRun + 1} ` +
            `(received/sent per direction): ${stuck.join('; ')}`,
        )
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }

  function makeClient(secretOverride?: Uint8Array): HeadlessClient {
    const linkIdx = nextLink.i++
    const [rawHost, rawClient] = rawPair(linkIdx, 0)
    const conditions = { ...DEFAULT_CONDITIONS, ...opts.conditions }
    const link = conditionLink(
      rawHost,
      rawClient,
      { ...conditions, seed: opts.seed + linkIdx * 2 },
      clock,
    )
    const hostSide = traced(link.ends[0] as Connection, linkIdx, 1)
    let clientSide = traced(link.ends[1] as Connection, linkIdx, 0)
    server.accept(hostSide)
    // `WorldServer.accept` returns `void` (0024 §5's fixed shape, unchanged by gate round 2) --
    // `connId` is assumed equal to join order (`linkIdx`), true as long as a scenario never
    // disconnects a client before checking it (M27's own scenarios never do).
    const connId = linkIdx
    // docs/plan/28-sessions-and-reconnect.md: real secrets, not `connId + 1` -- `opts.secrets[
    // linkIdx]` when the scenario cares, else a value deterministic in `(seed, linkIdx)` (Seams:
    // "createNetHarness({ secrets?, joinKey? })"; `joinKey` itself is `opts.world.joinKey`,
    // already a harness option since M13). `secretOverride` (steps 3-5: `addClient(secret?)`)
    // takes priority over both -- a scenario that wants a *specific* returning/superseding
    // identity (not merely "some real one") passes it explicitly, e.g. the same secret an earlier,
    // now-closed client used.
    const secret =
      secretOverride ?? opts.secrets?.[linkIdx] ?? deterministicSecret(opts.seed, linkIdx)
    const client = createHeadlessClient({
      wasm,
      game: { seed: worldCfg.params.seed, worldgen: gameWorldgen },
      // docs/plan/28b-reconnect-and-lifecycle.md step 3: `createLink`'s own `dial` -- reads the
      // current `clientSide` binding, which `HarnessLink.reconnect()` (below) reassigns to a
      // fresh conditioned end before `createLink`'s own next (0 ms-delayed) backoff attempt.
      dial: () => clientSide,
      secret,
      ...(worldCfg.joinKey !== undefined ? { joinKey: worldCfg.joinKey } : {}),
      buildHash: hexDecode(worldCfg.buildHash),
      // The real `VirtualClock`, not just a `{ now }` shim: it is also a `Scheduler`
      // (`ManualClock`'s own shape), which `createLink`'s dead timer/backoff/probe need.
      clock,
      scheduler: clock,
      linkSeed: opts.seed + linkIdx * 2 + 1_000_000, // distinct offset from the conditioner's own
    })
    entries.push({
      client,
      connId,
      link,
      linkIdx,
      setClientSide: (c) => {
        clientSide = c
      },
      reconnectCount: 0,
    })
    return client
  }

  /** `HarnessLink.reconnect()`'s own implementation (module doc comment on that interface). */
  function reconnectEntry(i: number): void {
    const e = entries[i]
    if (!e) throw new Error(`reconnect: no client ${i}`)
    e.reconnectCount++
    const conditions = { ...DEFAULT_CONDITIONS, ...opts.conditions }
    const newLink = conditionLink(
      ...rawPair(e.linkIdx, e.reconnectCount),
      { ...conditions, seed: opts.seed + e.linkIdx * 2 + 3_000_000 * e.reconnectCount },
      clock,
    )
    const hostSide = traced(newLink.ends[0] as Connection, e.linkIdx, 1)
    const newClientSide = traced(newLink.ends[1] as Connection, e.linkIdx, 0)
    server.accept(hostSide)
    e.link = newLink
    e.setClientSide(newClientSide)
  }

  const clients: HeadlessClient[] = []
  for (let i = 0; i < opts.clients; i++) clients.push(makeClient())

  async function advanceTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      // docs/plan/29-net-worker-and-reference-server.md steps 1-2, docs/plan/30c-ci-reds-after-m30.md
      // (red B): a real socket's bytes are genuine OS/event-loop I/O, not a microtask a plain
      // `await` waits out. Wait until every `ws` message already sent has actually arrived, so the
      // next `stepTick` sees it -- the same "awaits physical arrival" `memoryConnectionPair` gets
      // for free. First, so a `Hello` delivered here starts its digest before the wait below.
      if (opts.transport === 'ws') await wsDelivered()
      // docs/plan/28-sessions-and-reconnect.md: a real `await` on the actual in-flight digest
      // promise (not merely hoping the virtual clock's own microtask yields are enough) --
      // `crypto.subtle.digest` resolves through a real libuv threadpool callback in Node, which a
      // plain `await` on an already-settled/trivial promise does not reliably give a turn to.
      // Cheap when nothing is in flight (`handshakesSettled` returns at once).
      await simHost.handshakesSettled()
      // docs/plan/28b-reconnect-and-lifecycle.md step 4: `SimHost.stepTick` itself is
      // unconditional (its own doc comment) -- this harness is what has to honour "the tick
      // counter frozen" while the world is genuinely idle-paused, by simply not calling it.
      // `clock.advanceBy` still runs regardless, so a grace/idle `scheduler.setTimer` (`host/
      // lifecycle.ts`) armed on this same `VirtualClock` still fires on schedule, and a `Hello`
      // arriving mid-idle (`addClient`/a reconnect) still resumes ticking on its own next call.
      if (simHost.running) simHost.stepTick(1)
      for (let f = 0; f < framesPerTick; f++) {
        await clock.advanceBy(frameMs)
        for (const e of entries) e.client.stepFrame(frameMs)
      }
    }
  }

  async function advanceTo(t: number): Promise<void> {
    await clock.advanceTo(t)
  }

  async function settle(): Promise<void> {
    // docs/plan/28-sessions-and-reconnect.md Seams: `serverInternals(server).handshakesSettled()`
    // first -- every secret hashed/allocated so far, then one real tick boundary to consume them
    // into `sim_attach` (`pumpHandshakes`'s own doc comment: a caller wants a tick *after* this
    // resolves, not instead of it), before the ordinary settle sweep.
    await serverInternals(server).handshakesSettled()
    await advanceTicks(SETTLE_EXTRA_TICKS)
  }

  function assertConverged(): void {
    const mismatches: string[] = []
    for (const e of entries) {
      const host = simHost.regionHash(e.connId)
      const replica = e.client.replicaHash()
      if (host !== replica) {
        mismatches.push(`client ${e.linkIdx} (conn ${e.connId}): host=${host} replica=${replica}`)
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `assertConverged: seed=${opts.seed} tick=${simHost.counters.ticksRun} mismatches:\n` +
          mismatches.join('\n'),
      )
    }
  }

  function counters(i: number): NetHarnessCounters {
    const e = entries[i]
    if (!e) throw new Error(`counters: no client ${i}`)
    const perTickMap = new Map<number, { tick: number; bytesDown: number; bytesUp: number }>()
    let bytesDown = 0
    let bytesUp = 0
    let messagesDown = 0
    let messagesUp = 0
    for (const entry of trace) {
      if (entry.link !== e.linkIdx) continue
      let row = perTickMap.get(entry.tick)
      if (!row) {
        row = { tick: entry.tick, bytesDown: 0, bytesUp: 0 }
        perTickMap.set(entry.tick, row)
      }
      if (entry.dir === 0) {
        bytesDown += entry.bytes.length
        messagesDown++
        row.bytesDown += entry.bytes.length
      } else {
        bytesUp += entry.bytes.length
        messagesUp++
        row.bytesUp += entry.bytes.length
      }
    }
    const perTick = Array.from(perTickMap.values()).sort((a, b) => a.tick - b.tick)
    const totals = emptyTotals()
    const downSamples: { t: number; bytes: number }[] = []
    for (const entry of trace) {
      if (entry.link !== e.linkIdx || entry.dir !== 0) continue
      downSamples.push({ t: entry.t, bytes: entry.bytes.length })
      const frame = parseFrame(entry.bytes)
      if (frame) addFrame(totals, frame)
    }
    const { up: reconnectBytesUp, down: reconnectBytesDown } = reconnectCost(trace, e.linkIdx)
    return {
      bytesDown,
      bytesUp,
      messagesDown,
      messagesUp,
      perTick,
      reconnectBytesUp,
      reconnectBytesDown,
      header: totals.header,
      sections: totals.sections,
      frames: totals.frames,
      heartbeats: totals.heartbeats,
      chunkEnters: totals.chunkEnters,
      chunkLeaves: totals.chunkLeaves,
      worstSecondBytesDown: worstWindowBytes(downSamples, 1000),
    }
  }

  function encodeTrace(): Uint8Array {
    let total = 0
    for (const e of trace) total += 13 + e.bytes.length
    const out = new Uint8Array(total)
    let off = 0
    for (const e of trace) {
      writeU32(out, off, e.t)
      writeU32(out, off + 4, e.link)
      out[off + 8] = e.dir
      writeU32(out, off + 9, e.bytes.length)
      out.set(e.bytes, off + 13)
      off += 13 + e.bytes.length
    }
    return out
  }

  return {
    clock,
    // docs/plan/28b-reconnect-and-lifecycle.md step 2: getters, not plain fields -- `restartServer`
    // (below) reassigns the closure-scoped `server`/`storage` `let` bindings, and every caller that
    // reads `harness.server`/`harness.storage` after a restart must see the new pair, not the one
    // this object literal happened to close over when it was built.
    get server() {
      return server
    },
    get storage() {
      return storage
    },
    clients,
    link(i) {
      const e = entries[i]
      if (!e) throw new Error(`link: no client ${i}`)
      return {
        ends: e.link.ends,
        set: (c) => e.link.set(c),
        stall: (ms) => e.link.stall(ms),
        disconnect: (code) => e.link.disconnect(code),
        reconnect: () => reconnectEntry(i),
      }
    },
    addClient(secret) {
      const client = makeClient(secret)
      clients.push(client)
      return client
    },
    async restartServer(opts) {
      const nextStorage = opts?.crash ? storage.crashClone() : storage
      if (!opts?.crash) await server.stop()
      storage = nextStorage
      server = buildServer(storage)
      await server.ready
      simHost = worldServerTestHandle(server)
    },
    async panicServer() {
      const inst = serverInternals(server).rawInstance
      if (!inst) {
        throw new Error('panicServer: no recoverable instance (no recoveryDeps configured)')
      }
      try {
        trapSim(inst)
      } catch {
        // `trapSim`'s own doc comment: "the call never returns normally" -- the trap itself is
        // the point, not this exception; `recover()` below is what actually derives a fresh
        // instance and resyncs every open connection.
      }
      await simHost.recover()
    },
    connectRaw() {
      const linkIdx = nextLink.i++
      const [rawHost, rawClient] = rawPair(linkIdx, 0)
      const conditions = { ...DEFAULT_CONDITIONS, ...opts.conditions }
      const link = conditionLink(
        rawHost,
        rawClient,
        { ...conditions, seed: opts.seed + linkIdx * 2 },
        clock,
      )
      const hostSide = traced(link.ends[0] as Connection, linkIdx, 1)
      const clientSide = traced(link.ends[1] as Connection, linkIdx, 0)
      server.accept(hostSide)
      return clientSide
    },
    hostTick: () => simHost.counters.ticksRun,
    advanceTo,
    advanceTicks,
    settle,
    assertConverged,
    counters,
    trace: encodeTrace,
    async dispose() {
      await server.stop()
      if (wsServerClose) await wsServerClose()
    },
  }
}

function writeU32(u8: Uint8Array, off: number, v: number): void {
  u8[off] = v & 0xff
  u8[off + 1] = (v >>> 8) & 0xff
  u8[off + 2] = (v >>> 16) & 0xff
  u8[off + 3] = (v >>> 24) & 0xff
}
