// `HeadlessClient` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Seams; Planning
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
// synchronously on miss" (docs/plan/08b-gen-workers-and-queue.md, Consumes). A second, `Role.Gen`
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
import { CLOCK_FIELD, ClockBlockView, readClockBlockInto, SessionState } from '../clock-block.js'
import { ByeReason, buildBye } from '../host/handshake.js'
import type { EngineInstance } from '../loader.js'
import { instantiate } from '../loader.js'
import { createBytePump } from '../net/pump.js'
import { readU32LE, writeU32LE } from '../sab/bytes.js'
import { ControlBlock, WORKER_CLIENT } from '../sab/control.js'
import { createSabSet } from '../sab/layout.js'
import { RingConsumer } from '../sab/ring.js'
import { type Connection, MsgClass } from '../server.js'
import { seedToHexU64 } from '../sim-config.js'
import { createNetPump } from '../worker/client-net.js'
import { GEN_RECORD_HEADER_BYTES, readI32LE, writeGenHeader } from '../worker/gen-record.js'
import { createShell } from '../worker/shell.js'

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
  /** docs/plan/28-sessions-and-reconnect.md: this connection's own `PlayerId`, learned from
   * `Welcome` (`0`, "none", before it arrives). */
  ownPlayerId: number
  /** docs/plan/28-sessions-and-reconnect.md: `ClientCore::revealed()`'s own value, mirrored in
   * the clock block's `revealed` word -- true once every chunk of the visible rectangle is both
   * held by the replica and locally generated. */
  revealed: boolean
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
  /** The last kind-1 `Ui` record's decoded JSON (`src/CLAUDE.md`'s own `uiRing` framing, read here
   * directly off `client_poll_ui()` rather than through a ring), or `null` before the first one. */
  ui(): unknown
  /** `client_region_hash()`, 16-digit lowercase hex. */
  replicaHash(): string
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
   * docs/plan/28-sessions-and-reconnect.md: before the session has attached (`Welcome` applied),
   * this instead looks for `Welcome` on the downlink and applies it (`client_on_welcome`) -- the
   * normal `on_frame`/`client_poll_uplink` pump only starts once that succeeds. */
  pump(): void
  /** `pump()` plus a real client frame: writes the pending camera state into the camera block,
   * calls `frame(t_ms)` (so `ClientSide::frame`/`TerrainFeed::on_frame` produce presence and gen
   * requests, once M18/M19 land), then `pump()`. */
  stepFrame(dtMs: number): void
  /** docs/plan/28-sessions-and-reconnect.md Scope: "Client `Bye{Leave}` on `client.leave()` /
   * `HeadlessClient.leave()`" -- sends `Bye{Leave}` over the attached `Connection` then closes
   * it (0009: an ordinary, self-initiated close, not one of 0013's host-driven `CloseCode`s).
   * Idempotent: closing an already-closed `Connection` is every real `Connection`'s own no-op
   * (`memory-connection.ts`'s own `if (end.closed) return`). */
  leave(): void
}

export interface HeadlessClientOptions {
  wasm: WebAssembly.Module
  game: { seed: string; worldgen: unknown }
  /** The end this client talks to the host through -- raw (`memoryConnectionPair`) or conditioned
   * (`conditionLink`'s own `ends[i]`); `createNetHarness` decides which. */
  connection: Connection
  /** docs/plan/28-sessions-and-reconnect.md: this device's own identity secret (16 bytes,
   * `loadOrMintSecret`'s own shape) -- `client_hello`'s own source, via `TerrainConfig`'s `secret`
   * config field (hex). Replaces M27's pre-handshake `myPlayerId` stopgap: the client's own
   * `PlayerId` now comes from `Welcome` (`status().ownPlayerId`), not a config value. */
  secret: Uint8Array
  /** `""` for single-player and open servers (0013); `createNetHarness` mirrors `WorldConfig.
   * joinKey`. */
  joinKey?: string
  /** The world's own build hash (32 bytes, full SHA-256) -- `WorldConfig.buildHash`, hex-decoded. */
  buildHash: Uint8Array
  /** docs/plan/28-sessions-and-reconnect.md: a virtual clock for the Hello -> Welcome round trip
   * fed to `LeadEstimator.seed_rtt_ms` (M26, if ticked) -- `createNetHarness` passes its own
   * `VirtualClock`. Omitted (`rttMs` always `0`) for a caller that does not care, e.g. a
   * `connectRaw()`-driven scenario that never applies `Welcome` through this type at all. */
  clock?: { now(): number }
}

function requireRegion(inst: EngineInstance, id: RegionId, what: string) {
  const r = inst.region(id)
  if (!r)
    throw new Error(`HeadlessClient: ${what} region required but engine_init did not reserve it`)
  return r
}

export function createHeadlessClient(opts: HeadlessClientOptions): HeadlessClient {
  const hexSeed = seedToHexU64(opts.game.seed)
  const clientConfig = {
    arenaBytes: CLIENT_ARENA_BYTES,
    game: {
      seed: hexSeed,
      params: opts.game.worldgen,
      secret: hexEncode(opts.secret),
      joinKey: opts.joinKey ?? '',
      buildHash: hexEncode(opts.buildHash),
    },
  }
  const genConfig = {
    arenaBytes: GEN_ARENA_BYTES,
    game: { seed: hexSeed, params: opts.game.worldgen },
  }

  const inst = instantiate(opts.wasm, Role.Client, clientConfig)
  const genInst = instantiate(opts.wasm, Role.Gen, genConfig)

  const rx = requireRegion(inst, RegionId.Rx, 'Rx')
  const uiRegion = inst.region(RegionId.Ui)
  const resultRegion = requireRegion(inst, RegionId.Result, 'Result')
  const downlinkRegion = requireRegion(inst, RegionId.Downlink, 'Downlink')
  const txRegion = requireRegion(inst, RegionId.Tx, 'Tx')
  const genInRegion = inst.region(RegionId.GenIn)
  const genOutRegion = genInst.region(RegionId.GenOut)
  const cameraRegion = requireRegion(inst, RegionId.Camera, 'Camera')

  // Only the two rings a real boundary crosses here (Deviations above): no `actionRing`/`uiRing`,
  // no `genRequest`/`genResult`, no `inputRing`/`uploadRing`/`drawList` -- `createSabSet` builds
  // all of them, but this file only ever touches `uplink`/`downlink`/`clockBlock`/`control`
  // (`Shell`'s own requirement for `createNetPump`'s wake target).
  const sabs = createSabSet('net', 0)
  const shell = createShell(new ControlBlock(sabs.control), WORKER_CLIENT)
  const ticksPerSecond = inst.call0(inst.x.tick_hz)
  const netPump = createNetPump(
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
  const bytePump = createBytePump({ uplink: sabs.uplink, downlink: sabs.downlink })
  bytePump.attach(opts.connection)

  // docs/plan/28-sessions-and-reconnect.md: a second `RingConsumer` over the same `downlink` SAB,
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

  /** Builds `Hello` (`client_hello`) and sends it directly over `opts.connection`, bypassing the
   * uplink ring entirely (0009: `Hello` precedes any `UplinkBatch`, and `client_poll_uplink` has
   * nothing to flush yet regardless). One-off, not a per-frame path (`.claude/rules/hot-paths.md`'s
   * exemption for "one-time setup"). */
  function sendHello(): void {
    const len = inst.call0(inst.x.client_hello)
    if (len <= 0) {
      throw new Error(`HeadlessClient: client_hello failed: status ${-len}`)
    }
    helloSentAtMs = opts.clock?.now() ?? 0
    opts.connection.send(MsgClass.ReliableOrdered, txRegion.u8.slice(0, len))
  }

  /** Pops at most one message off the downlink ring and applies it as `Welcome`
   * (`client_on_welcome`); does nothing once `attached`. `Status.Decode` (a non-`Welcome` message,
   * or a malformed one) is swallowed here -- the same "leaves state untouched" contract `on_frame`
   * has, and there is nothing else this pump could usefully do with it before a session exists. */
  function pumpPreWelcome(): void {
    if (attached) return
    for (;;) {
      const len = preWelcomeConsumer.popInto(downlinkRegion.u8, 0)
      if (len < 0) return
      const rttMs = Math.max(0, (opts.clock?.now() ?? 0) - helloSentAtMs)
      const status = inst.call2(inst.x.client_on_welcome, len, rttMs)
      if (status === Status.Ok) {
        attached = true
        ownPlayerId = readU32LE(resultRegion.u8, 0)
        const seqSeed = readU32LE(resultRegion.u8, 4)
        netPump.seedFromWelcome(seqSeed)
        return
      }
    }
  }

  sendHello()

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
    if (!genOutRegion || !genInRegion || !resultRegion) return
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

  function readClock(): void {
    readClockBlockInto(clockView, clockScratch)
    if (!seeded && clockScratch[CLOCK_FIELD.SessionState] === SessionState.Online) {
      seeded = true
      nextSeq = (clockScratch[CLOCK_FIELD.SeqSeed] as number) + 1
    }
  }

  function pump(): void {
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

  function dispatch(action: unknown): number {
    readClock()
    if (clockScratch[CLOCK_FIELD.SessionState] !== SessionState.Online) {
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
    return candidateSeq
  }

  return {
    dispatch,
    setView(report) {
      cameraState.centreX = report.x
      cameraState.centreY = report.y
      cameraState.halfExtentTilesX = report.halfW
      cameraState.halfExtentTilesY = report.halfH
      cameraState.velocityX = report.velX ?? 0
      cameraState.velocityY = report.velY ?? 0
    },
    setCamera(opts) {
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
    replicaHash() {
      const status = inst.call0(inst.x.client_region_hash)
      if (status !== Status.Ok) {
        throw new Error(`HeadlessClient: replicaHash: client_region_hash failed: status ${status}`)
      }
      return inst.readU64Hex(RegionId.Result, 0)
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
      }
    },
    pump,
    stepFrame(dtMs) {
      cameraState.frameTimeMs += dtMs
      writeCameraBlock(cameraWriter, cameraState)
      readCameraBlockInto(cameraWriter, cameraRegion.u8, 0)
      inst.call1(inst.x.frame, 0)
      pump()
    },
    leave() {
      opts.connection.send(MsgClass.ReliableOrdered, buildBye(ByeReason.Leave))
      opts.connection.close(0)
    },
  }
}
