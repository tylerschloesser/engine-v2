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
import { instantiate } from '../loader.js'
import {
  type ConditionedLink,
  type ConditionerConditions,
  conditionLink,
} from '../net/conditioner.js'
import { memoryConnectionPair } from '../net/memory-connection.js'
import {
  buildSimInstanceConfig,
  type Connection,
  createWorldServer,
  type MsgClass,
  type WorldConfig,
  type WorldServer,
  worldServerTestHandle,
} from '../server.js'
import { loadGame } from '../server-node.js'
import { memoryStorage } from '../storage/memory.js'
import type { Storage } from '../storage/types.js'
import { createHeadlessClient, type HeadlessClient } from './headless-client.js'
import { createVirtualClock, type VirtualClock } from './virtual-clock.js'

export interface NetHarnessCounters {
  bytesDown: number
  bytesUp: number
  messagesDown: number
  messagesUp: number
  perTick: { tick: number; bytesDown: number; bytesUp: number }[]
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
  transport?: 'memory'
  conditions?: Partial<ConditionerConditions>
}

export interface NetHarness {
  clock: VirtualClock
  server: WorldServer
  storage: Storage
  clients: HeadlessClient[]
  link(i: number): ConditionedLink
  addClient(): HeadlessClient
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
  }
  const gameWorldgen = worldCfg.params.worldgen

  const clock = createVirtualClock()
  const storage = memoryStorage()

  // A throwaway instance, read once and discarded, only to learn the real tick rate before ticking
  // (Deviations: `SimHost` itself exposes no `tickHz()` -- only the pacing arithmetic already
  // derived from it -- so `advanceTicks`'s own `clock.advanceBy` needs its own reading to stay in
  // lockstep with `stepTick`'s own ticks).
  const tickHzProbe = instantiate(wasm, Role.Sim, buildSimInstanceConfig(worldCfg))
  const tickMs = Math.round(1000 / (tickHzProbe.call0(tickHzProbe.x.tick_hz) || 20))

  const server = createWorldServer(worldCfg, {
    wasm,
    storage,
    clock: { now: () => clock.now() },
    timer: { every: () => () => {} }, // ticking is `simHost.stepTick`, driven from `advanceTicks`
  })
  await server.ready
  // The live `SimHost` `createWorldServer` owns (module doc comment above): `regionHash`/
  // `stepTick`/`counters` all read live, connected state no reopened reader can reach.
  const simHost = worldServerTestHandle(server)

  const trace: TraceEntry[] = []
  const nextLink = { i: 0 }

  type Entry = { client: HeadlessClient; connId: number; link: ConditionedLink; linkIdx: number }
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

  if (opts.transport !== undefined && opts.transport !== 'memory') {
    throw new Error(`createNetHarness: unsupported transport '${opts.transport}' (M29, Non-scope)`)
  }

  function makeClient(): HeadlessClient {
    const linkIdx = nextLink.i++
    const [rawHost, rawClient] = memoryConnectionPair()
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
    // `WorldServer.accept` returns `void` (0024 §5's fixed shape, unchanged by gate round 2) --
    // `connId` is assumed equal to join order (`linkIdx`), true as long as a scenario never
    // disconnects a client before checking it (M27's own scenarios never do). `connId + 1`: M15's
    // own implicit-accept convention (`PlayerId = conn + 1`), the pre-handshake source
    // `game_instance.rs`'s own `default_my_player_id` doc comment names; M28's real handshake
    // replaces this once it lands.
    const connId = linkIdx
    const client = createHeadlessClient({
      wasm,
      game: { seed: worldCfg.params.seed, worldgen: gameWorldgen },
      connection: clientSide,
      myPlayerId: connId + 1,
    })
    entries.push({ client, connId, link, linkIdx })
    return client
  }

  const clients: HeadlessClient[] = []
  for (let i = 0; i < opts.clients; i++) clients.push(makeClient())

  async function advanceTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      simHost.stepTick(1)
      await clock.advanceBy(tickMs)
      for (const e of entries) e.client.stepFrame(tickMs)
    }
  }

  async function advanceTo(t: number): Promise<void> {
    await clock.advanceTo(t)
  }

  async function settle(): Promise<void> {
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
    return { bytesDown, bytesUp, messagesDown, messagesUp, perTick }
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
    server,
    storage,
    clients,
    link(i) {
      const e = entries[i]
      if (!e) throw new Error(`link: no client ${i}`)
      return e.link
    },
    addClient() {
      const client = makeClient()
      clients.push(client)
      return client
    },
    advanceTo,
    advanceTicks,
    settle,
    assertConverged,
    counters,
    trace: encodeTrace,
    async dispose() {
      await server.stop()
    },
  }
}

function writeU32(u8: Uint8Array, off: number, v: number): void {
  u8[off] = v & 0xff
  u8[off + 1] = (v >>> 8) & 0xff
  u8[off + 2] = (v >>> 16) & 0xff
  u8[off + 3] = (v >>> 24) & 0xff
}
