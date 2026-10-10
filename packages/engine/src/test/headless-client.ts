// `HeadlessClient` (M27, Seams; Planning
// decisions "One thread, stepped actors"): M15b's client-worker shell (`src/worker/client.ts`'s
// `body()`) made callable without `Atomics.wait` -- a real `Role.Client` instance, driven directly
// by `pump()`/`stepFrame(dt)` calls in this same thread rather than a spawned `Worker` woken across
// a `SharedArrayBuffer`. Reuses the shipped decode path exactly: `worker/client-net.ts`'s
// `createNetPump` runs unmodified over a real `uplink`/`downlink` ring pair and clock block, with
// its outbound side handed to a `createBytePump` (`../net/pump.js`) wired to this client's own
// `Connection` -- the same "M06 rings between a client instance and a Connection" relationship a
// real `net` worker will have from M29. Dispatch and the UI/action-result drain skip `actionRing`/
// `uiRing` entirely: those rings exist only to cross a *page's* main-thread/worker boundary, which
// does not exist here (`dispatch()` writes straight into `Rx` and calls `on_action` synchronously;
// `pump()` drains `client_poll_ui()` directly) -- `uplink`/`downlink` remain because they cross a
// real boundary this milestone's own goal is to exercise: the wire to a `Connection`.
//
// Terrain: "headless clients under Node (M27) have no gen workers; their client instance generates
// synchronously on miss" (M08b, Consumes). A second, `Role.Gen`
// instance of the same module is instantiated alongside the client one; `pumpGenGen()` below
// replaces `worker/client-gen.ts`'s ring-mediated dance with a direct call: `gen_take` -> read the
// request straight out of `Result` (no ring slot to copy through) -> `gen_chunk` on the gen
// instance -> copy `GenOut` into the client's own `GenIn` region -> `gen_deliver`, synchronously,
// looped until `gen_take` says there is no more work. `TerrainFeed`'s own `gen_workers` config
// field defaults to 1 (`game_instance.rs`), so worker ordinal 0 is always the right one to drive.
import { RegionId, Role, Status } from '../abi.js'
import { CameraBlockView, readCameraBlockInto, writeCameraBlock } from '../camera/block.js'
import { CameraState } from '../camera/state.js'
import { type CameraViewport, halfExtentTiles } from '../camera/transform.js'
import type { ActionOutcome } from '../client.js'
import type { Clock, Scheduler } from '../clock.js'
import { CLOCK_FIELD, ClockBlockView, readClockBlockInto, SessionState } from '../clock-block.js'
import { ByeReason, buildBye } from '../host/handshake.js'
import type { EngineInstance } from '../loader.js'
import { EngineTrap, instantiate } from '../loader.js'
import { createLink, type DownReason } from '../net/link.js'
import { createBytePump } from '../net/pump.js'
import { readU32LE, writeU32LE } from '../sab/bytes.js'
import { ControlBlock, WORKER_CLIENT } from '../sab/control.js'
import { createSabSet, DRAWLIST_HEADER_BYTES } from '../sab/layout.js'
import { RingConsumer } from '../sab/ring.js'
import { type Connection, MsgClass } from '../server.js'
import { seedToHexU64 } from '../sim-config.js'
import { createNetPump } from '../worker/client-net.js'
import { GEN_RECORD_HEADER_BYTES, readI32LE, writeGenHeader } from '../worker/gen-record.js'
import { createShell } from '../worker/shell.js'
import { injectTrap } from '../worker/test-trap.js'
import type { DrawRecord } from './client.js'
import { type DesyncDump, type DesyncLog, readDesyncLog, takeDesyncDumps } from './desync.js'
import {
  decodeCounters,
  type InterpCounters,
  PRESENCE_SAMPLE_BYTES,
  type PresenceSampleRow,
  rowFrom,
  visibleCount,
} from './presence-samples.js'

function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    out += b < 16 ? `0${b.toString(16)}` : b.toString(16)
  }
  return out
}

/** 0015 §5's own default per-role arenas (`src/client.ts`'s `DEFAULT_ARENA_BYTES`, not exported):
 * a headless client is its own topology, not a `createClient()` spawn, so it picks the same
 * numbers directly rather than importing a private constant. */
const MIB = 1024 * 1024
const CLIENT_ARENA_BYTES = 48 * MIB
const GEN_ARENA_BYTES = 4 * MIB

/** A synthetic, square CSS-pixel viewport (`camera/transform.ts`'s own `CameraViewport`): a
 * headless client has no canvas, so `setCamera`'s own `tilesAcross`-only convenience derives a
 * symmetric `halfExtentTiles{X,Y}` (`tilesAcross / 2` on both axes, `camera/transform.ts`'s own
 * formula for a square viewport) instead of leaving it at `CameraState`'s own `0` default -- which
 * would subscribe no chunks at all (0010's subscription target is driven by `half_w`/`half_h`,
 * `crates/engine/src/client/camera.rs`'s `to_report()`). Any equal positive pair works: only the
 * *ratio* to `tilesAcross` matters (`pxPerTile`'s own formula divides them out). */
const SQUARE_VIEWPORT: CameraViewport = { widthPx: 1024, heightPx: 1024 }

/** `setView`'s own primitive shape: 1:1 with the wire's `CameraReport` (`crates/engine/src/wire/
 * uplink.rs`), for a test that needs exact control over what a `client_poll_uplink` batch actually
 * contains (`counters-exact`'s literal byte pinning) -- `setCamera`'s `{x,y,tilesAcross}` cannot
 * reach `half_w`/`half_h` independently of `tilesAcross`, nor an explicit velocity. */
export interface ViewReport {
  x: number
  y: number
  halfW: number
  halfH: number
  velX?: number
  velY?: number
}

export interface HeadlessClientStatus {
  live: boolean
  tick: number
  predictedTick: number
  ackSeq: number
  /** M28: this connection's own `PlayerId`, learned from
   * `Welcome` (`0`, "none", before it arrives). */
  ownPlayerId: number
  /** M28: `ClientCore::revealed()`'s own value, mirrored in
   * the clock block's `revealed` word -- true once every chunk of the visible rectangle is both
   * held by the replica and locally generated. */
  revealed: boolean
  /** M28 step 4: how many times `createLink`'s own `onUp` has
   * fired for this client -- `1` for a connection that has never gone down and redialed. A
   * scenario proving a link *stayed* up (`liveness/heartbeat-idle-world`) watches this stay `1`
   * over a long idle stretch; one that forces a redial watches it increment. */
  linkUpCount: number
  /** M34c step 8: why the link last went down (`createLink`'s `onDown`: reason, and the close code when
   * there was one), `null` until it has; cleared when the link comes back up. `'superseded'` is
   * terminal: no redial follows, so `linkUpCount` stays put. (`sessionState` is not told: the clock
   * block never reads the `Bye`.) */
  linkDown: { reason: DownReason; code?: number } | null
  /** M28b step 2: the clock block's own raw `session_state`
   * (`SessionState`, `clock-block.ts`) -- `live` above collapses everything to a boolean, so a
   * resync scenario reads this instead to see `Resyncing` (`4`) on the way through, distinct from
   * `Online` (`1`) before and after. */
  sessionState: number
}

export interface HeadlessClient {
  /** Writes the action record straight into the client instance's own `Rx` region and calls
   * `on_action` synchronously (no ring: this thread *is* the client, Deviations above). Throws
   * `Error("engine: dispatch before ready")` before the session is live, and `Error("engine: action
   * queue full")` at the same 0012 pending-queue backstop (`OUTBOX_CAPACITY`, 32) `src/client.ts`'s
   * own `dispatch()` enforces -- matching seq numbering. */
  dispatch(action: unknown): number
  /** The full `CameraReport`-shaped primitive (Deviations above): takes effect on the next
   * `stepFrame`/`pump()` call, not immediately. */
  setView(report: ViewReport): void
  /** The friendly convenience: `x`/`y`/`tilesAcross` only, `halfExtentTiles{X,Y}` derived from a
   * synthetic square viewport (Deviations above) so a real subscription still forms. Takes effect
   * on the next `stepFrame` call. */
  setCamera(opts: { x: number; y: number; tilesAcross: number }): void
  /** M31 Provides: scripted motion on the virtual clock. Every
   * `stepFrame(dtMs)` moves the camera centre `tilesPerS * dtMs / 1000` tiles toward `(x, y)` (never
   * past it) and reports that speed as the view's velocity; on arrival the velocity is zero. The
   * view extent is whatever `setCamera`/`setView` last set. A later `setCamera`/`setView` cancels
   * the pan. */
  panTo(x: number, y: number, tilesPerS: number): void
  /** The last kind-1 `Ui` record's decoded JSON (`src/CLAUDE.md`'s own `uiRing` framing, read here
   * directly off `client_poll_ui()` rather than through a ring), or `null` before the first one. */
  ui(): unknown
  /** M34c: the `Draw` records of the last `frame()` (`drawlist_len` and `RegionId.DrawList`), decoded
   * as `drawListRecords` does for a real client; empty before the first frame or for a game with no
   * draw list. Test-only: allocates one object per record. */
  draws(): DrawRecord[]
  /** `client_region_hash()`, 16-digit lowercase hex. */
  replicaHash(): string
  /** `client_chunk_hash(cx, cy)`: FNV hash (16 hex digits) of a resident chunk's effective slab
   * (pristine terrain plus replicated changes), or `null` when the chunk is not resident, which
   * for a chunk in view means its pristine terrain has not been generated (M33f. */
  chunkHash(cx: number, cy: number): string | null
  /** This client's desync reports (M31b: `client_desync`. */
  desyncs(): DesyncLog
  /** Hash-all dumps completed since the last call (`client_desync_dump`): empty unless the host's
   * `Welcome` carried `HASH_ALL` and a chunk hash mismatched and its resync snapshot has landed. */
  takeDesyncDumps(): DesyncDump[]
  /** Fault injection (`client_corrupt_chunk`): flips one replicated byte of a held chunk. Throws
   * when the chunk is not held. */
  corruptChunk(cx: number, cy: number): void
  /** Delivered in the order `client_poll_ui()` produced them, coalesced across every `pump()`/
   * `stepFrame()` call since the last drain. Returns an unsubscribe function. */
  onActionResult<Reject = unknown>(
    cb: (seq: number, result: ActionOutcome<Reject>) => void,
  ): () => void
  status(): HeadlessClientStatus
  /** Drains the downlink ring into `on_frame`, generates synchronously on any gen miss, drains
   * `client_poll_ui()`, then flushes the uplink ring (`client_poll_uplink`'s own output) to the
   * attached `Connection` -- everything `stepFrame` does except writing the camera block and
   * calling `frame()` itself. Useful right after construction/join, before any camera has been set.
   * M28: before the session has attached (`Welcome` applied),
   * this instead looks for `Welcome` on the downlink and applies it (`client_on_welcome`) -- the
   * normal `on_frame`/`client_poll_uplink` pump only starts once that succeeds. */
  pump(): void
  /** `pump()` plus a real client frame: writes the pending camera state into the camera block,
   * calls `frame(t_ms)` (so `ClientSide::frame`/`TerrainFeed::on_frame` produce presence and gen
   * requests, once M18/M19 land), then `pump()`. */
  stepFrame(dtMs: number): void
  /** M28 Scope: "Client `Bye{Leave}` on `client.leave()` /
   * `HeadlessClient.leave()`" -- sends `Bye{Leave}` over the attached `Connection` then closes
   * it (0009: an ordinary, self-initiated close, not one of 0013's host-driven `CloseCode`s).
   * Idempotent: closing an already-closed `Connection` is every real `Connection`'s own no-op
   * (`memory-connection.ts`'s own `if (end.closed) return`). */
  leave(): void
  /** M30: every visible remote player as the last `stepFrame`
   * interpolated it (`client_presence_sample_at`), ascending `PlayerId`. */
  samplePresences(): PresenceSampleRow[]
  /** `interpRenderedFrames`, `interpExtrapolatedFrames`, `interpDelayMs` (same export). */
  interpCounters(): InterpCounters
  /** `client_rebase()`: what the client worker calls on `FLAG_REBASE` (0018 section 8). */
  rebase(): void
  /** M37 step 1: kills this client's instance the way a WASM trap does
   * (`worker/test-trap.ts`). The next `pump()`/`stepFrame()`/`dispatch()` replaces it. */
  injectTrap(): void
  /** How many times the instance has been replaced after a trap. */
  trapCount(): number
}

/** A `Scheduler` that never fires anything (`HeadlessClientOptions.scheduler`'s own default):
 * `createLink`'s dead timer/backoff/probe simply never trigger for a caller that does not supply
 * a real one -- every existing single-dial scenario (no reconnect, no liveness assertions) is
 * unaffected either way. */
function noopScheduler(): Scheduler {
  return {
    setTimer: () => -1,
    clearTimer: () => {},
    requestFrame: () => -1,
    cancelFrame: () => {},
  }
}

export interface HeadlessClientOptions {
  wasm: WebAssembly.Module
  /** Omitted for a remote-style client (the default of a real page, ADR 0042): the client and its
   * generator take the world from `Welcome`. Given, they are configured at construction, as before. */
  game?: { seed: string; worldgen: unknown }
  /** M28 step 4: dials this client's own `Connection` --
   * `createLink`'s own `dial` (Seams). Called once immediately (the first join) and again on
   * every redial `createLink` itself decides to make (dead timer, probe, `HeadlessClient` never
   * drives this directly). `createNetHarness` hands back the one fixed conditioned end it already
   * built (no fresh dial per attempt yet -- Deviations: a real per-attempt redial is M29's own
   * transport concern, not this milestone's). */
  dial: () => Connection
  /** M28: this device's own identity secret (16 bytes,
   * `loadOrMintSecret`'s own shape) -- `client_hello`'s own source, via `TerrainConfig`'s `secret`
   * config field (hex). Replaces M27's pre-handshake `myPlayerId` stopgap: the client's own
   * `PlayerId` now comes from `Welcome` (`status().ownPlayerId`), not a config value. */
  secret: Uint8Array
  /** `""` for single-player and open servers (0013); `createNetHarness` mirrors `WorldConfig.
   * joinKey`. */
  joinKey?: string
  /** The world's own build hash (32 bytes, full SHA-256) -- `WorldConfig.buildHash`, hex-decoded. */
  buildHash: Uint8Array
  /** M28: a virtual clock for the Hello -> Welcome round trip
   * fed to `LeadEstimator.seed_rtt_ms` (M26, if ticked), *and* `createLink`'s own dead-timer/
   * backoff/probe clock (step 4) -- `createNetHarness` passes its own `VirtualClock` (a `Clock`
   * and a `Scheduler` both). Omitted (`rttMs` always `0`, liveness management inert) for a caller
   * that does not care, e.g. a `connectRaw()`-driven scenario that never applies `Welcome`
   * through this type at all. */
  clock?: Clock
  /** M28 step 4: `createLink`'s own `scheduler` -- defaults to
   * one that never fires (`noopScheduler`, above) when `clock` is given but this is not, so a
   * caller that only wants the `Hello`/`Welcome` RTT reading is unaffected. */
  scheduler?: Scheduler
  /** M28 step 4: seeds `createLink`'s own backoff jitter --
   * distinct from any network-conditioning seed (`createNetHarness`'s own `seed`), since this is
   * unrelated randomness. Defaults to `1` (every existing caller that never reconnects never
   * observes it). */
  linkSeed?: number
}

function requireRegion(inst: EngineInstance, id: RegionId, what: string) {
  const r = inst.region(id)
  if (!r)
    throw new Error(`HeadlessClient: ${what} region required but engine_init did not reserve it`)
  return r
}

export function createHeadlessClient(opts: HeadlessClientOptions): HeadlessClient {
  const hexSeed = opts.game ? seedToHexU64(opts.game.seed) : undefined
  const clientConfig = {
    arenaBytes: CLIENT_ARENA_BYTES,
    game: {
      ...(opts.game ? { seed: hexSeed, params: opts.game.worldgen } : {}),
      secret: hexEncode(opts.secret),
      joinKey: opts.joinKey ?? '',
      buildHash: hexEncode(opts.buildHash),
    },
  }

  let inst = instantiate(opts.wasm, Role.Client, clientConfig)
  // The generator role is immutable after `engine_init`: built now when the world is known, else
  // on the `Welcome` that configures the client (`ensureGen`, ADR 0042: the late spawn of a page).
  let genInst: EngineInstance | null = null
  let genOutRegion: ReturnType<EngineInstance['region']> = null
  function buildGen(game: unknown): void {
    genInst = instantiate(opts.wasm, Role.Gen, { arenaBytes: GEN_ARENA_BYTES, game })
    genOutRegion = genInst.region(RegionId.GenOut)
  }
  if (opts.game) buildGen({ seed: hexSeed, params: opts.game.worldgen })

  // `let`: a trap replaces the instance (`recoverFromTrap`), and every region view with it.
  let rx = requireRegion(inst, RegionId.Rx, 'Rx')
  let uiRegion = inst.region(RegionId.Ui)
  let resultRegion = requireRegion(inst, RegionId.Result, 'Result')
  let downlinkRegion = requireRegion(inst, RegionId.Downlink, 'Downlink')
  let txRegion = requireRegion(inst, RegionId.Tx, 'Tx')
  let genInRegion = inst.region(RegionId.GenIn)
  let cameraRegion = requireRegion(inst, RegionId.Camera, 'Camera')

  // Only the two rings a real boundary crosses here (Deviations above): no `actionRing`/`uiRing`,
  // no `genRequest`/`genResult`, no `inputRing`/`uploadRing`/`drawList` -- `createSabSet` builds
  // all of them, but this file only ever touches `uplink`/`downlink`/`clockBlock`/`control`
  // (`Shell`'s own requirement for `createNetPump`'s wake target).
  const sabs = createSabSet('net', 0)
  const shell = createShell(new ControlBlock(sabs.control), WORKER_CLIENT)
  const ticksPerSecond = inst.call0(inst.x.tick_hz)
  function buildNetPump(): ReturnType<typeof createNetPump> {
    return createNetPump(
      inst,
      shell,
      sabs.uplink,
      sabs.downlink,
      downlinkRegion,
      txRegion,
      sabs.clockBlock,
      resultRegion,
      ticksPerSecond,
    )
  }
  let netPump = buildNetPump()
  const bytePump = createBytePump({ uplink: sabs.uplink, downlink: sabs.downlink })

  // M28: a second `RingConsumer` over the same `downlink` SAB,
  // used only before `Welcome` lands -- safe (`sab/ring.ts`'s own module doc comment: head/tail
  // live in the ring's own control block, not per-instance state), since only one of this consumer
  // and `netPump`'s own internal one is ever popped from at a time (this one stops being used the
  // instant `attached` flips true, `pumpPreWelcome`'s own doc comment). `downlinkRegion` is also
  // `on_frame`'s own destination (`Instance::client_on_welcome`'s doc comment: "same region
  // `on_frame` reads"), so popping `Welcome` into it before any `Frame` traffic exists is safe.
  const preWelcomeConsumer = new RingConsumer(sabs.downlink)
  let attached = false
  let ownPlayerId = 0
  let helloSentAtMs = 0
  let currentConn: Connection | null = null
  let linkUpCount = 0
  let linkDown: { reason: DownReason; code?: number } | null = null

  /** Builds `Hello` (`client_hello`) and sends it directly over the current connection, bypassing
   * the uplink ring entirely (0009: `Hello` precedes any `UplinkBatch`, and `client_poll_uplink`
   * has nothing to flush yet regardless). One-off per dial, not a per-frame path (`.claude/rules/
   * hot-paths.md`'s exemption for "one-time setup"). */
  function sendHello(): void {
    const len = inst.call0(inst.x.client_hello)
    if (len <= 0) {
      throw new Error(`HeadlessClient: client_hello failed: status ${-len}`)
    }
    helloSentAtMs = opts.clock?.now() ?? 0
    currentConn?.send(MsgClass.ReliableOrdered, txRegion.u8.slice(0, len))
  }

  /** Pops at most one message off the downlink ring and applies it as `Welcome`
   * (`client_on_welcome`); does nothing once `attached`. `Status.Decode` (a non-`Welcome` message,
   * or a malformed one) is swallowed here -- the same "leaves state untouched" contract `on_frame`
   * has, and there is nothing else this pump could usefully do with it before a session exists. */
  let framedThisStep = false
  function pumpPreWelcome(): void {
    if (attached) return
    for (;;) {
      const len = preWelcomeConsumer.popInto(downlinkRegion.u8, 0)
      if (len < 0) return
      const rttMs = Math.max(0, (opts.clock?.now() ?? 0) - helloSentAtMs)
      const status = inst.call2(inst.x.client_on_welcome, len, rttMs)
      if (status === Status.Ok) {
        attached = true
        if (readU32LE(resultRegion.u8, 16) === 1) {
          // This `Welcome` configured the client: build the generator from the world it took.
          const len = inst.call0(inst.x.client_world_config)
          if (len <= 0) throw new Error(`HeadlessClient: client_world_config failed: ${len}`)
          buildGen(JSON.parse(decoder.decode(txRegion.u8.subarray(0, len))))
          // The frame of this very step ran before the world was known and did nothing: run it
          // again now, before `pump` polls the uplink, so the first presence sample and gen
          // requests go out as they did for a client configured at init (ADR 0042 §3).
          if (framedThisStep) inst.call1(inst.x.frame, 0)
        }
        ownPlayerId = readU32LE(resultRegion.u8, 0)
        const seqSeed = readU32LE(resultRegion.u8, 4)
        netPump.seedFromWelcome(seqSeed)
        return
      }
      if (status === Status.WorldMismatch) {
        throw new Error('HeadlessClient: Welcome for a different world than this client joined')
      }
    }
  }

  // M28 step 4: `createLink` owns dialing (the first join and
  // every later redial its own dead timer/probe/backoff decide on) -- this client never calls
  // `opts.dial()` itself. `onUp` fires synchronously, once immediately (during this very
  // constructor call) and again on every future redial: `bytePump.attach(conn)` re-points the
  // ring<->wire bridge at the new `Connection` (`pump.ts`'s own "detaches any previously attached
  // connection first"), `attached` resets so `pumpPreWelcome` runs the handshake again, and a
  // fresh `Hello` goes out. `onDown` is deliberately inert here beyond bookkeeping: a reattach
  // that also needs to reconcile already-applied replica state against a new epoch is M28b's own
  // scope (Non-scope, Consumes), not this milestone's.
  const link = createLink({
    dial: opts.dial,
    clock: opts.clock ?? { now: () => 0 },
    scheduler: opts.scheduler ?? noopScheduler(),
    seed: opts.linkSeed ?? 1,
    onUp: (conn) => {
      currentConn = conn
      attached = false
      linkUpCount++
      linkDown = null
      bytePump.attach(conn)
      sendHello()
    },
    onDown: (why, code) => {
      linkDown = code === undefined ? { reason: why } : { reason: why, code }
      // Bookkeeping only (Deviations above): `createLink` itself keeps retrying (backoff) unless
      // the reason is terminal, in which case no further `onUp` ever fires and this client simply
      // stays not-live (`status().live` reads the clock block's own `SessionState`, untouched by
      // this callback).
    },
  })

  const clockView = new ClockBlockView(sabs.clockBlock)
  // Sized 7, matching `readClockBlockInto`'s own `scratchFieldsView()` (the seventh slot is
  // `tickFraction`'s raw bits, unused here -- `CLOCK_FIELD` has no entry for it, `clock-block.ts`'s
  // own doc comment).
  const clockScratch = new Uint32Array(8)

  const cameraState = new CameraState()
  const cameraWriter = new CameraBlockView(
    // A private (non-shared) camera block would do just as well single-threaded, but reusing
    // `createSabSet`'s own `cameraBlock` (already allocated) avoids a second bespoke SAB here.
    sabs.cameraBlock,
  )
  const halfScratch = { x: 0, y: 0 }

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let lastUi: unknown = null
  type Listener = (seq: number, result: ActionOutcome<unknown>) => void
  const listeners: Listener[] = []
  let nextSeq = -1
  let seeded = false

  function pumpGenSync(): void {
    if (!genInst || !genOutRegion || !genInRegion || !resultRegion) return
    for (;;) {
      const took = inst.call1(inst.x.gen_take, 0)
      if (took !== 1) break
      const cx = readI32LE(resultRegion.u8, 0)
      const cy = readI32LE(resultRegion.u8, 4)
      genInst.call2(genInst.x.gen_chunk, cx, cy)
      writeGenHeader(genInRegion.u8, 0, cx, cy)
      genInRegion.u8.set(genOutRegion.u8, GEN_RECORD_HEADER_BYTES)
      const status = inst.call2(inst.x.gen_deliver, 0, GEN_RECORD_HEADER_BYTES + genOutRegion.len)
      if (status !== Status.Ok) {
        throw new Error(`HeadlessClient: gen_deliver failed: status ${status}`)
      }
    }
  }

  function pollUi(): void {
    if (!uiRegion) return
    for (;;) {
      const n = inst.call0(inst.x.client_poll_ui)
      if (n <= 0) break
      let i = 0
      while (i + 5 <= n) {
        const kind = uiRegion.u8[i] as number
        const recLen = readU32LE(uiRegion.u8, i + 1)
        const bodyStart = i + 5
        if (bodyStart + recLen > n) break
        const text = decoder.decode(uiRegion.u8.subarray(bodyStart, bodyStart + recLen))
        if (kind === 1) {
          lastUi = JSON.parse(text)
        } else if (kind === 2) {
          const parsed = JSON.parse(text) as { seq: number; result: ActionOutcome<unknown> }
          for (const cb of listeners) cb(parsed.seq, parsed.result)
        }
        i = bodyStart + recLen
      }
    }
  }

  /** `client_presence_sample_at(i)`'s `Result` bytes (a copy; test-only, allocation is fine). */
  function sampleAt(i: number): Uint8Array {
    const status = inst.call1(inst.x.client_presence_sample_at, i)
    if (status !== Status.Ok) {
      throw new Error(`HeadlessClient: client_presence_sample_at failed: status ${status}`)
    }
    return resultRegion.u8.slice(0, PRESENCE_SAMPLE_BYTES)
  }

  function readClock(): void {
    readClockBlockInto(clockView, clockScratch)
    if (!seeded && clockScratch[CLOCK_FIELD.SessionState] === SessionState.Online) {
      seeded = true
      nextSeq = (clockScratch[CLOCK_FIELD.SeqSeed] as number) + 1
    }
  }

  /** M37 step 1 (0014 §6, client role): the instance is garbage. A
   * fresh one from the kept `Module`, the same `Hello` a new connection sends (no resume hint: the
   * replica died with the instance) on the connection that is already up (the host re-handshakes a
   * settled connection that sends `Hello`, `server.ts`'s `reopenOnHello`), and `Lost` for the
   * pending actions the old instance can no longer resolve (M28b). */
  let trapCount = 0
  let lastDispatchedSeq = -1
  function recoverFromTrap(): void {
    const afterSeq = netPump.ackSeq()
    trapCount++
    inst = instantiate(opts.wasm, Role.Client, clientConfig)
    rx = requireRegion(inst, RegionId.Rx, 'Rx')
    uiRegion = inst.region(RegionId.Ui)
    resultRegion = requireRegion(inst, RegionId.Result, 'Result')
    downlinkRegion = requireRegion(inst, RegionId.Downlink, 'Downlink')
    txRegion = requireRegion(inst, RegionId.Tx, 'Tx')
    genInRegion = inst.region(RegionId.GenIn)
    cameraRegion = requireRegion(inst, RegionId.Camera, 'Camera')
    netPump = buildNetPump()
    attached = false
    for (let seq = afterSeq + 1; seq <= lastDispatchedSeq; seq++) {
      for (const cb of listeners.slice()) cb(seq, 'Lost')
    }
    sendHello()
  }

  function pump(): void {
    if (inst.dead) recoverFromTrap()
    try {
      pumpOnce()
    } catch (e) {
      if (!(e instanceof EngineTrap)) throw e
      recoverFromTrap()
    }
  }

  function pumpOnce(): void {
    bytePump.drain() // retry any downlink backpressure before this wake's own drain
    if (!attached) {
      pumpPreWelcome()
      if (!attached) return // still waiting on Welcome; nothing else to pump yet
    }
    netPump.pump()
    pumpGenSync()
    pollUi()
    bytePump.drain() // flush whatever client_poll_uplink just produced
    readClock()
  }

  let pan: { x: number; y: number; tilesPerS: number } | null = null

  function advancePan(p: { x: number; y: number; tilesPerS: number }, dtMs: number): void {
    const dx = p.x - cameraState.centreX
    const dy = p.y - cameraState.centreY
    const dist = Math.hypot(dx, dy)
    const step = (p.tilesPerS * dtMs) / 1000
    if (dist <= step || dist === 0) {
      cameraState.centreX = p.x
      cameraState.centreY = p.y
      cameraState.velocityX = 0
      cameraState.velocityY = 0
      pan = null
      return
    }
    cameraState.centreX += (dx / dist) * step
    cameraState.centreY += (dy / dist) * step
    cameraState.velocityX = Math.round((dx / dist) * p.tilesPerS)
    cameraState.velocityY = Math.round((dy / dist) * p.tilesPerS)
  }

  function dispatch(action: unknown): number {
    if (inst.dead) recoverFromTrap()
    readClock()
    // `!attached`: between a trap and the new `Welcome` the clock block still reads `Online` (the
    // dead instance's last write), but no session exists yet.
    if (!attached || clockScratch[CLOCK_FIELD.SessionState] !== SessionState.Online) {
      throw new Error('engine: dispatch before ready')
    }
    const candidateSeq = nextSeq
    const ackSeq = clockScratch[CLOCK_FIELD.AckSeq] as number
    const OUTBOX_CAPACITY = 32 // 0012 (`client::core::OUTBOX_CAPACITY`), `src/client.ts`'s own mirror
    if (candidateSeq - ackSeq > OUTBOX_CAPACITY) {
      throw new Error('engine: action queue full')
    }
    const jsonBytes = encoder.encode(JSON.stringify(action))
    const total = 8 + jsonBytes.length
    if (total > rx.u8.length) {
      throw new Error(`engine: action payload too large (${jsonBytes.length} bytes)`)
    }
    writeU32LE(rx.u8, 0, candidateSeq)
    writeU32LE(rx.u8, 4, jsonBytes.length)
    rx.u8.set(jsonBytes, 8)
    const status = inst.call1(inst.x.on_action, total)
    if (status !== Status.Ok) {
      throw new Error(`engine: dispatch: on_action failed: status ${status}`)
    }
    nextSeq = candidateSeq + 1
    lastDispatchedSeq = candidateSeq
    return candidateSeq
  }

  return {
    dispatch,
    setView(report) {
      pan = null
      cameraState.centreX = report.x
      cameraState.centreY = report.y
      cameraState.halfExtentTilesX = report.halfW
      cameraState.halfExtentTilesY = report.halfH
      cameraState.velocityX = report.velX ?? 0
      cameraState.velocityY = report.velY ?? 0
    },
    panTo(x, y, tilesPerS) {
      pan = { x, y, tilesPerS }
    },
    setCamera(opts) {
      pan = null
      cameraState.centreX = opts.x
      cameraState.centreY = opts.y
      cameraState.tilesAcross = opts.tilesAcross
      halfExtentTiles(cameraState, SQUARE_VIEWPORT, halfScratch)
      cameraState.halfExtentTilesX = halfScratch.x
      cameraState.halfExtentTilesY = halfScratch.y
    },
    ui() {
      return lastUi
    },
    draws() {
      const region = inst.region(RegionId.DrawList)
      if (!region) return []
      const n = inst.call0(inst.x.drawlist_len)
      const view = new DataView(region.u8.buffer, region.u8.byteOffset, region.u8.byteLength)
      const out: DrawRecord[] = []
      for (let i = 0; i < n; i++) {
        const b = DRAWLIST_HEADER_BYTES + i * 32
        const kindSprite = view.getUint16(b + 16, true)
        out.push({
          pos: [view.getFloat32(b, true), view.getFloat32(b + 4, true)],
          size: [view.getFloat32(b + 8, true), view.getFloat32(b + 12, true)],
          kind: kindSprite >>> 12,
          spriteId: kindSprite & 0x0fff,
          layer: view.getUint8(b + 18),
          flags: view.getUint8(b + 19),
          color: view.getUint32(b + 20, true),
          param: view.getFloat32(b + 24, true),
          pickId: view.getUint32(b + 28, true),
        })
      }
      return out
    },
    replicaHash() {
      const status = inst.call0(inst.x.client_region_hash)
      if (status !== Status.Ok) {
        throw new Error(`HeadlessClient: replicaHash: client_region_hash failed: status ${status}`)
      }
      return inst.readU64Hex(RegionId.Result, 0)
    },
    desyncs() {
      return readDesyncLog(
        inst,
        (i) => inst.call1(inst.x.client_desync, i),
        'HeadlessClient.desyncs',
      )
    },
    takeDesyncDumps() {
      return takeDesyncDumps(inst)
    },
    chunkHash(cx, cy) {
      const status = inst.call2(inst.x.client_chunk_hash, cx, cy)
      if (status === Status.NotCached) return null
      if (status !== Status.Ok) {
        throw new Error(`HeadlessClient.chunkHash(${cx}, ${cy}): status ${status}`)
      }
      let hex = ''
      for (let i = 7; i >= 0; i--)
        hex += (resultRegion.u8[i] as number).toString(16).padStart(2, '0')
      return hex
    },
    corruptChunk(cx, cy) {
      const status = inst.call2(inst.x.client_corrupt_chunk, cx, cy)
      if (status !== Status.Ok) {
        throw new Error(`HeadlessClient.corruptChunk(${cx}, ${cy}): status ${status}`)
      }
    },
    onActionResult(cb) {
      const listener = cb as Listener
      listeners.push(listener)
      return () => {
        const i = listeners.indexOf(listener)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    status() {
      readClock()
      return {
        live: clockScratch[CLOCK_FIELD.SessionState] === SessionState.Online,
        tick: clockScratch[CLOCK_FIELD.AuthoritativeTick] as number,
        predictedTick: clockScratch[CLOCK_FIELD.PredictedTick] as number,
        ackSeq: clockScratch[CLOCK_FIELD.AckSeq] as number,
        ownPlayerId,
        revealed: clockScratch[CLOCK_FIELD.Revealed] === 1,
        linkUpCount,
        linkDown,
        sessionState: clockScratch[CLOCK_FIELD.SessionState] as number,
      }
    },
    pump,
    stepFrame(dtMs) {
      if (pan) advancePan(pan, dtMs)
      cameraState.frameTimeMs += dtMs
      writeCameraBlock(cameraWriter, cameraState)
      if (inst.dead) recoverFromTrap()
      readCameraBlockInto(cameraWriter, cameraRegion.u8, 0)
      try {
        inst.call1(inst.x.frame, 0)
      } catch (e) {
        if (!(e instanceof EngineTrap)) throw e
        recoverFromTrap()
        return
      }
      framedThisStep = true
      pump()
      framedThisStep = false
    },
    injectTrap() {
      try {
        injectTrap(inst, 'HeadlessClient.injectTrap: client trap')
      } catch (e) {
        if (!(e instanceof EngineTrap)) throw e
      }
    },
    trapCount: () => trapCount,
    samplePresences() {
      const rows: PresenceSampleRow[] = []
      for (let i = 0; ; i++) {
        const r = sampleAt(i)
        if (i >= visibleCount(r)) return rows
        rows.push(rowFrom(r))
      }
    },
    interpCounters() {
      return decodeCounters(sampleAt(0))
    },
    rebase() {
      const status = inst.call0(inst.x.client_rebase)
      if (status !== Status.Ok) {
        throw new Error(`HeadlessClient: client_rebase failed: status ${status}`)
      }
    },
    leave() {
      // Sent before `link.stop()` closes the connection (Deviations, `conditionLink`'s own
      // close-ordering fix): a `Bye` queued immediately before a close is delivered first, not
      // dropped. `link.stop()`, not a direct `currentConn.close()`: disarms every `createLink`
      // timer too, so a leave never races a pending redial.
      currentConn?.send(MsgClass.ReliableOrdered, buildBye(ByeReason.Leave))
      link.stop()
    },
  }
}
