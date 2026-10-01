// `client`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): instantiate, reserve the
// arena, copy the camera block into its `Camera` region and call `frame(t_ms)` when `CB_FRAME_REQ`
// has advanced since the last wake, storing `W_ACK` (Planning decisions "Worker frame clock",
// amended: see `FRAME_ARG` below). `test.echo` additionally drives the `echo` zero-GC page's SAB ->
// region -> region -> SAB round trip (Tests added), gated so it never runs in a production build
// that never sets the flag.
import { RegionId, Role } from '../abi.js'
import { CameraBlockView, readCameraBlockInto } from '../camera/block.js'
import { systemClock } from '../clock.js'
import { type EngineInstance, EngineTrap, type RegionView } from '../loader.js'
import {
  CB_CLIENT_FRAME_N,
  CB_CLIENT_FRAME_US,
  CB_FLAGS,
  CB_FRAME_REQ,
  FLAG_REBASE,
  FLAG_RENDERER_RESET,
  W_ACK,
  workerWord,
} from '../sab/control.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'
import { createActionPump } from './client-action.js'
import { createDrawlistPump } from './client-drawlist.js'
import { createGenPump } from './client-gen.js'
import { createInputPump } from './client-input.js'
import { createNetPump } from './client-net.js'
import { createUploadPump } from './client-upload.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateFactoryForSetup } from './instantiate.js'
import {
  CLIENT_TRAPS_CALL,
  type FromWorker,
  type SetupMessage,
  type TestCallMessage,
  TRAPS_BYTES,
} from './protocol.js'
import type { LoopState, Shell } from './shell.js'
import { noTimeout } from './shell.js'
import { handleTestCall } from './test-call.js'
import { asNumberList, injectTrap } from './test-trap.js'

/**
 * The *raw export argument* of `frame(t_ms: f64)` is a vestigial Smi, not the frame time (Planning
 * decisions "Worker frame clock" amended, fix round 2: docs/plan/06b-workers-and-spawn.md,
 * Deviations). The game-facing `Instance::frame(t_ms, ...)` still receives the real frame time:
 * decision A of fix round 3 has `abi::frame` (`crates/engine/src/abi/mod.rs`) drop this argument on
 * the floor and pass `camera.frame_time_ms` instead, and `workers.camera_block_reaches_wasm` holds
 * it to that bit-exactly.
 * `frameTime[0] as number`, a `Float64Array` read of the just-copied camera block, boxed a fresh
 * `HeapNumber` on every real frame in the interpreter tier (`byFn` evidence on `topology clean`);
 * the whole 80-byte block -- `frame_time_ms` included -- is already copied into this role's own
 * `Camera` region by `readCameraBlockInto` on the very same pass, so Rust can read it there
 * (`CameraBlock::frame_time_ms`, `client/camera.rs`) instead of receiving it a second time as a
 * boxed argument. The export keeps its declared shape (`frame(t_ms: f64) -> status`, unchanged ABI,
 * no `ABI_VERSION` bump) because docs/plan/{15b,17,18,19,26,30}.md and 08b's Consumes all cite
 * `frame(t_ms)` by this name; only what crosses as the argument changed, from memory. */
const FRAME_ARG = 0

function requireRegion(inst: EngineInstance, id: RegionId, what: string): RegionView {
  const r = inst.region(id)
  if (!r)
    throw new Error(`client worker: ${what} region required but engine_init did not reserve it`)
  return r
}

/** One client instance and every pump built over it (docs/plan/37-robustness-events.md step 1):
 * `setup` builds one, and builds a fresh one over a fresh instance when the first traps (0014 §6).
 * Nothing here outlives its instance: the pumps close over `inst`, the regions and the ring
 * endpoints (the rings themselves live in the SABs, so a new endpoint continues where the old one
 * stopped). */
type Assembly = {
  body(): void
  testCall(m: TestCallMessage): FromWorker
  /** See `NetPump.ackSeq`; `0` for a topology with no link. */
  ackSeq(): number
  /** See `ActionPump.lastSeq`; `-1` before the first action or without an action pump. */
  lastSeq(): number
  pushLost(afterSeq: number, throughSeq: number): void
}

type AssembleOptions = {
  /** Test only: called before each `frame()`; may trap the instance (`TestFlags.trapClientAtFrame`). */
  beforeFrame: ((inst: EngineInstance) => void) | null
  /** This assembly replaced a trapped one on an up link: a restarted net pump (`Resyncing`, `Hello`
   * without a resume hint) and no DrawList published until the replica holds a frame, so main keeps
   * presenting the last DrawList it had. */
  restart: boolean
}

function assemble(
  shell: Shell,
  message: SetupMessage,
  inst: EngineInstance,
  opts: AssembleOptions,
): Assembly {
  // A debugging/test convenience only, gated the same way as `worker.ts`'s own globals
  // (orchestrator decision 1): lets a Playwright test read the client instance's own memory
  // directly through `worker.evaluate()` (docs/plan/06b-workers-and-spawn.md, Tests added,
  // `workers.camera_block_reaches_wasm`) instead of inventing a message type for it.
  if (message.test) {
    ;(self as unknown as { __engineInstance?: EngineInstance }).__engineInstance = inst
  }
  const gcHook = message.test?.gcHook === true
  // M36's bench HUD (`CB_CLIENT_FRAME_US`): times each `frame()` call. Only a bench page's setup
  // carries it; a shipped build never reads the clock here.
  const timing = message.test?.timing === true
  const cameraRegion = requireRegion(inst, RegionId.Camera, 'Camera')
  const cameraReader = new CameraBlockView(message.sabs.cameraBlock)
  let lastFrameReq = Atomics.load(shell.control.words, CB_FRAME_REQ)

  const echo = message.test?.echo === true
  const actionRing = echo ? new RingConsumer(message.sabs.actionRing) : null
  const uiRing = echo ? new RingProducer(message.sabs.uiRing) : null
  const rx = echo ? requireRegion(inst, RegionId.Rx, 'Rx') : null
  const tx = echo ? requireRegion(inst, RegionId.Tx, 'Tx') : null

  // docs/plan/16-action-round-trip.md, step 3: the real action/UI-result pump, mutually exclusive
  // with the `echo`-gated test-only round trip immediately above (both would otherwise construct
  // their own, independent `RingConsumer`/`RingProducer` over the *same* `actionRing`/`uiRing`
  // SABs, corrupting each other's SPSC bookkeeping). `Rx`/`Ui` are looked up unconditionally
  // (`fixtures/hash`'s own `Rx` is unrelated to actions, the same "no coexistence today" note
  // `inputRxRegion` above already carries).
  const actionPump = echo
    ? null
    : createActionPump(
        inst,
        message.sabs.actionRing,
        message.sabs.uiRing,
        inst.region(RegionId.Rx),
        inst.region(RegionId.Ui),
      )

  // docs/plan/16-action-round-trip.md ("`tick_hz()` already exists as an export, so
  // `ticks_per_second` need not be re-plumbed per frame"): read once here, at setup, from this
  // instance's own role -- broadened from a sim-only export (`abi::tick_hz`'s own Deviations) --
  // and handed to `createNetPump` below, which mirrors it into the clock block unchanged on every
  // write rather than calling this export again every wake.
  const ticksPerSecond = inst.call0(inst.x.tick_hz)

  // docs/plan/08b-gen-workers-and-queue.md, Order of work 4: the gen pump, built once and run every
  // wake (orchestrator decision: it must cost nothing and answer 0 on a page whose client role has
  // no `client::TerrainFeed`, e.g. `fx-hash`'s `topology`/`echo`). `GenIn` is optional: absent
  // there, present wherever `Instance::init` declares it (`TerrainFeed::gen_in_bytes`).
  const resultRegion = requireRegion(inst, RegionId.Result, 'Result')
  const genIn = inst.region(RegionId.GenIn)
  const genPump = createGenPump(inst, shell.control, message.sabs, genIn, resultRegion, (msg) =>
    shell.fatal(msg),
  )

  // docs/plan/09-renderer-terrain.md, Order of work 5: the upload-staging pump, built once and run
  // every wake, same shape as `genPump` above (`ChunkTexels` is optional: `null` on a client role
  // with no `client::Uploader`, e.g. `fx-hash`'s `topology`/`echo`/`gen` pages).
  const chunkTexels = inst.region(RegionId.ChunkTexels)
  const uploadPump = createUploadPump(inst, message.sabs.uploadRing, chunkTexels)

  // docs/plan/17-drawlist-and-sprites.md, step 3: the DrawList publish pump, built once.
  // `RegionId.DrawList` is optional, same shape as `chunkTexels`/`genIn` above: absent on a client
  // role with no `Game` (e.g. `fx-hash`'s `topology`/`echo` pages).
  const drawListRegion = inst.region(RegionId.DrawList)
  const drawlistPump = createDrawlistPump(inst, message.sabs.drawList, drawListRegion)

  // docs/plan/11-camera-and-input.md, Order of work 5: the input-drain pump, built once and run
  // every wake, same shape as `genPump`/`uploadPump` above. `RegionId.Rx` is looked up
  // unconditionally, independent of the `echo`-only `rx` local above (`fixtures/hash`'s own `Rx`
  // is unrelated to input; the two never coexist on one instance today, Deviations).
  const inputRxRegion = inst.region(RegionId.Rx)
  const inputPump = createInputPump(inst, message.sabs.inputRing, inputRxRegion)

  // docs/plan/15b-ring-connection-and-replica-rendering.md, step 4: the net pump, built only when
  // this topology is linked (`message.link`, Orchestrator ruling 1) and run every wake, same shape
  // as `genPump`/`uploadPump`/`inputPump` above -- unconditional, not gated behind `CB_FRAME_REQ`
  // the way `frame()` itself still is (Scope's per-wake order lists it alongside `frame(t_ms)`, but
  // draining the downlink and polling the uplink both have their own internal pacing/emptiness
  // checks, so running them on every wake, not only a real render frame's, is what keeps a linked
  // client caught up between renders too).
  // docs/plan/28-sessions-and-reconnect.md step 5: a linked client worker now always speaks the
  // real handshake (`Hello` first, `ready` means `Welcome` applied) -- single-player takes the
  // same path as a real connection would (Scope). `onAttached` forwards Welcome's own view
  // clamps to the main thread (0019 §1's `setViewClamp`, which only main can call, `Client.camera`
  // being main-thread-only): `client-welcome` is a one-off lifecycle notification, the same
  // "setup, fatal errors and lifecycle only" carve-out `ready`/`fatal` already use (0015 §2).
  // Set by `body()` when it ran `frame()` this wake; read by `onConfigured` below.
  let framedThisWake = false
  const netPump = message.link
    ? createNetPump(
        inst,
        shell,
        message.sabs.uplink,
        message.sabs.downlink,
        inst.region(RegionId.Downlink),
        inst.region(RegionId.Tx),
        message.sabs.clockBlock,
        resultRegion,
        ticksPerSecond,
        {
          clock: systemClock,
          // docs/plan/29-net-worker-and-reference-server.md steps 1-2: gates the first
          // `client_hello()` send on the net worker's own `CB_LINK_STATE` (`worker/client-net.ts`'s
          // own doc comment) -- absent for a `local` host, unchanged from before this milestone
          // (`exactOptionalPropertyTypes`: omitted, not `undefined`, when unset).
          ...(message.remoteLinked ? { remoteLinked: true as const } : {}),
          ...(opts.restart ? { restart: true as const } : {}),
          // docs/plan/33f (ADR 0042): the one `Welcome` that configured this client's world.
          // Once per instance (the wasm side reports it once), so this is not a steady-state
          // message: it carries the config main needs to spawn the gen workers late.
          onConfigured: () => {
            const len = inst.call0(inst.x.client_world_config)
            const txRegion = inst.region(RegionId.Tx)
            if (len <= 0 || !txRegion) {
              shell.fatal(`client worker: client_world_config failed: ${len}`)
              return
            }
            shell.post({
              type: 'client-configured',
              config: new TextDecoder().decode(txRegion.u8.subarray(0, len)),
            })
            // This wake's `frame()` ran before the world was known and did nothing: run it again
            // now, before the pump polls the uplink, so the first presence sample and gen
            // requests go out as they did for a client configured at init (ADR 0042 §3). The
            // camera region still holds this wake's block.
            if (framedThisWake) {
              inst.call1(inst.x.frame, FRAME_ARG)
              drawlistPump.publish()
            }
          },
          // A `Welcome` for another world than the one this client took from its first one
          // (0013: one world per server). Ends this worker; `client.ts` surfaces the prefix as
          // `onLink` `rejected` / `WorldMismatch`. No reload policy (ADR 0042).
          onWorldMismatch: () => {
            shell.fatal('WorldMismatch: a Welcome for a different world than this client joined')
          },
          onAttached: (info) => {
            shell.post({
              type: 'client-welcome',
              playerId: info.playerId,
              viewMaxTilesPerAxis: info.viewMaxTilesPerAxis,
              viewMaxChunks: info.viewMaxChunks,
            })
          },
        },
        // docs/plan/28b-reconnect-and-lifecycle.md step 2: a second `Welcome` on this same linked
        // connection (a panic recovery or an upgrade bump, this milestone's own `resyncAll()`) --
        // `client-resyncing` is the same one-off "setup, fatal errors and lifecycle only"
        // notification `client-welcome` already is, forwarded to `Client.onResyncing` listeners.
        () => {
          shell.post({ type: 'client-resyncing' })
        },
      )
    : null

  let gateDraw = opts.restart && netPump !== null
  function body(): void {
    framedThisWake = false
    if (gcHook) applyGcHook(shell.control, shell.index)
    // docs/plan/18-picking-and-overlay.md, gate round 1: `inputPump.pump()` must run *before*
    // `frame()`, in this same wake, not after it -- `game_instance.rs`'s `GameInstance::frame` now
    // reads `InputQueue` (`FrameCx::input()`) and clears it at the end of the same call, so an event
    // drained into the queue only *after* `frame()` already ran would sit unread until the *next*
    // real frame, one wake later, every time, on every real page. Before this milestone nothing in
    // Rust read input inside `frame` at all, so the two pumps' relative order never mattered; it
    // does now. Safe to move ahead of every other pump here: `inputPump` only touches `inputRing`
    // and the `Rx` region transiently (`on_input` decodes and pushes into `InputQueue`'s own owned
    // storage, retaining no reference to `Rx`'s bytes once the call returns), and nothing later in
    // this function reads `Rx` before overwriting it for its own, unrelated purpose (`actionPump`'s
    // own action-record decode, below) -- single-threaded, sequential, no concurrent readers.
    inputPump.pump()
    // docs/plan/37b-device-loss.md (0018 §8): main rebuilt the renderer after a WebGPU device loss
    // and set `FLAG_RENDERER_RESET`. Consume it at this wake, before `frame()` and `uploadPump`:
    // every resident chunk and the indirection window are marked for re-upload, and the ring's byte
    // budget on main paces the refill like a join. One atomic load per wake, no allocation.
    if ((Atomics.load(shell.control.words, CB_FLAGS) & FLAG_RENDERER_RESET) !== 0) {
      Atomics.and(shell.control.words, CB_FLAGS, ~FLAG_RENDERER_RESET)
      inst.call0(inst.x.upload_requeue_all)
    }
    const frameReq = Atomics.load(shell.control.words, CB_FRAME_REQ)
    if (frameReq !== lastFrameReq) {
      lastFrameReq = frameReq
      // docs/plan/30-interpolation.md (0018 section 8): main set `FLAG_REBASE` on return from the
      // background. Consume it before this frame so the first frame after the return renders from
      // rebased clocks and empty interpolation buffers. One atomic load, no allocation.
      if ((Atomics.load(shell.control.words, CB_FLAGS) & FLAG_REBASE) !== 0) {
        Atomics.and(shell.control.words, CB_FLAGS, ~FLAG_REBASE)
        inst.call0(inst.x.client_rebase)
      }
      if (readCameraBlockInto(cameraReader, cameraRegion.u8, 0)) {
        if (opts.beforeFrame) opts.beforeFrame(inst)
        if (timing) {
          const t0 = systemClock.now()
          inst.call1(inst.x.frame, FRAME_ARG)
          Atomics.store(
            shell.control.words,
            CB_CLIENT_FRAME_US,
            Math.round((systemClock.now() - t0) * 1000),
          )
          Atomics.add(shell.control.words, CB_CLIENT_FRAME_N, 1)
        } else {
          inst.call1(inst.x.frame, FRAME_ARG)
        }
        framedThisWake = true
        // docs/plan/17-drawlist-and-sprites.md Scope: "once per produced frame" (0018 §2) -- only
        // after a real `frame()` call, never on a wake where `CB_FRAME_REQ` did not advance.
        if (gateDraw) {
          if (netPump?.hasFrame()) gateDraw = false
        }
        if (!gateDraw) drawlistPump.publish()
      }
    }
    if (actionRing && uiRing && rx && tx) {
      const len = actionRing.popInto(rx.u8, 0)
      if (len >= 0) {
        // Region -> region: both are WASM linear memory (0014 §4's "WASM -> SAB" gap the `echo`
        // page closes starts from here); whole-block `set()`, sizes match exactly (no `subarray`).
        tx.u8.set(rx.u8)
        uiRing.tryPush(tx.u8, tx.u8.length)
      }
    }
    // `netPump` runs before `uploadPump` (docs/plan/15b-ring-connection-and-replica-rendering.md,
    // step 5): `on_frame` (inside `netPump.pump()`, when a downlink message arrived) enqueues any
    // dirty chunks straight into `Uploader`'s own pending queues, and this order stages them onto
    // the upload ring the very same wake, not one wake later -- `untilQuiescent`'s own "every ring
    // drained" check would otherwise see the upload ring trivially drained (nothing pushed *yet*)
    // before `uploadPump` ever got a chance to try.
    //
    // `actionPump` also runs before `uploadPump` now, for the identical reason, one milestone
    // later (docs/plan/26-prediction-rendering-and-clocks.md steps 4-6, found live by the browser
    // `prediction-no-flicker` test: a semantic pixel probe read the *pristine* colour for one
    // extra wake after dispatch, every time). `ClientCore::on_action` (inside `actionPump.pump()`)
    // calls `sync_overlay_dirty`/`mark_dirty` synchronously as part of predicting the just-
    // dispatched action -- with `actionPump` running *after* `uploadPump` (the order before this
    // fix), that mark landed one wake too late for `uploadPump.pump()` to have staged it yet,
    // exactly the "the browser prediction-no-flicker test ... should see a chunk re-upload
    // immediately on dispatch ... worth asserting explicitly if the semantic pixel probe ever
    // seems to lag one frame behind a tap" risk `.claude/rules/prediction.md` (steps 1-3's own
    // Deviations note for this implementer) already named. `genPump`'s own position is unrelated
    // to either ordering constraint and is left where it was.
    netPump?.pump()
    genPump.pump()
    actionPump?.pump()
    uploadPump.pump()
    // `W_ACK` is stored last, after every pump (not right after the `frame()` block, M09b's own
    // original spot): `stepFrame`'s own spin and `untilQuiescent`'s `W_ACK === CB_FRAME_REQ` check
    // both use this as "this wake's work is done" -- if it fires as soon as `frame()` returns, a
    // caller can observe the ack (and, for `untilQuiescent`, an as-yet-untouched uplink ring, which
    // reads as trivially "drained") *before* `netPump.pump()` -- later in this same function, but a
    // separate statement Atomics can race a cross-thread reader on -- has actually produced and
    // pushed this wake's own uplink batch. Storing the same `frameReq` value here instead (every
    // wake, not only one where it changed: idempotent when it didn't) closes that window: by the
    // time a caller sees the ack, this whole body() pass, `netPump` included, has finished. Found by
    // `hidden_tab_sends_no_camera_report` failing 7/15 (`connected-terrain.spec.ts`): `bytesUp` had
    // not grown by the time `netCounters` was read after `__advance`'s own `await stepTick(...)`.
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), frameReq)
  }

  // `engine/test`'s `callParked` reaches `client_gen_stats`/`client_chunk_hash` (this instance's
  // own non-shared WASM memory) through this, while parked only (docs/plan/
  // 08b-gen-workers-and-queue.md, orchestrator decision 1 at the step-5 boundary): `worker.ts`
  // routes a `test-call` message here only when this worker's own setup carried `test`.
  return {
    body,
    testCall: (m) => handleTestCall(inst, m),
    ackSeq: () => netPump?.ackSeq() ?? 0,
    lastSeq: () => actionPump?.lastSeq() ?? -1,
    pushLost: (afterSeq, throughSeq) => actionPump?.pushLost(afterSeq, throughSeq),
  }
}

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  const newInstance = await instantiateFactoryForSetup(shell, message, Role.Client)
  // `TestFlags.trapClientAtFrame`: counts every `frame()` this worker runs, across rebuilds.
  const trapAtFrames = asNumberList(message.test?.trapClientAtFrame)
  let framesRun = 0
  const beforeFrame =
    trapAtFrames === null
      ? null
      : (inst: EngineInstance): void => {
          framesRun++
          if (trapAtFrames.includes(framesRun)) {
            injectTrap(inst, `trapClientAtFrame: client trap at frame ${framesRun}`)
          }
        }

  let current = assemble(shell, message, newInstance(), { beforeFrame, restart: false })
  let traps = 0

  /** 0014 §6 (client role): the instance is garbage; a fresh one from the kept `Module`, then the
   * full resync used for reconnect. Prediction, interpolation and pending actions died with the old
   * instance: the seqs it had not resolved are reported `Lost` (M28b). The main thread keeps its
   * last DrawList meanwhile (`AssembleOptions.restart`). A trap while building the new instance
   * (`engine_init` itself) is not recoverable and ends the worker like any other error. */
  function recover(trap: EngineTrap): void {
    const afterSeq = current.ackSeq()
    const throughSeq = current.lastSeq()
    traps++
    shell.post({ type: 'client-trapped', message: trap.panicMessage })
    current = assemble(shell, message, newInstance(), { beforeFrame, restart: true })
    current.pushLost(afterSeq, throughSeq)
    // The wake that trapped is finished: a caller waiting on `W_ACK` (`stepFrame`) must not spin on it.
    const frameReq = Atomics.load(shell.control.words, CB_FRAME_REQ)
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), frameReq)
  }

  function body(): void {
    try {
      current.body()
    } catch (e) {
      if (!(e instanceof EngineTrap)) throw e
      recover(e)
    }
  }

  return {
    body,
    timeoutMs: noTimeout,
    testCall: (m) => {
      if (m.name === CLIENT_TRAPS_CALL) {
        const result = new Uint8Array(TRAPS_BYTES)
        new DataView(result.buffer).setUint32(0, traps, true)
        return { type: 'test-result', id: m.id, value: 0, result }
      }
      return current.testCall(m)
    },
  }
}
