// `client`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): instantiate, reserve the
// arena, copy the camera block into its `Camera` region and call `frame(t_ms)` when `CB_FRAME_REQ`
// has advanced since the last wake, storing `W_ACK` (Planning decisions "Worker frame clock",
// amended: see `FRAME_ARG` below). `test.echo` additionally drives the `echo` zero-GC page's SAB ->
// region -> region -> SAB round trip (Tests added), gated so it never runs in a production build
// that never sets the flag.
import { RegionId, Role } from '../abi.js'
import { CameraBlockView, readCameraBlockInto } from '../camera/block.js'
import type { EngineInstance, RegionView } from '../loader.js'
import { CB_FRAME_REQ, W_ACK, workerWord } from '../sab/control.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'
import { createActionPump } from './client-action.js'
import { createDrawlistPump } from './client-drawlist.js'
import { createGenPump } from './client-gen.js'
import { createInputPump } from './client-input.js'
import { createNetPump } from './client-net.js'
import { createUploadPump } from './client-upload.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'
import { noTimeout } from './shell.js'
import { handleTestCall } from './test-call.js'

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

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  const inst = await instantiateForSetup(shell, message, Role.Client)
  // A debugging/test convenience only, gated the same way as `worker.ts`'s own globals
  // (orchestrator decision 1): lets a Playwright test read the client instance's own memory
  // directly through `worker.evaluate()` (docs/plan/06b-workers-and-spawn.md, Tests added,
  // `workers.camera_block_reaches_wasm`) instead of inventing a message type for it.
  if (message.test) {
    ;(self as unknown as { __engineInstance?: EngineInstance }).__engineInstance = inst
  }
  const gcHook = message.test?.gcHook === true
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
      )
    : null

  function body(): void {
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
    const frameReq = Atomics.load(shell.control.words, CB_FRAME_REQ)
    if (frameReq !== lastFrameReq) {
      lastFrameReq = frameReq
      if (readCameraBlockInto(cameraReader, cameraRegion.u8, 0)) {
        inst.call1(inst.x.frame, FRAME_ARG)
        // docs/plan/17-drawlist-and-sprites.md Scope: "once per produced frame" (0018 §2) -- only
        // after a real `frame()` call, never on a wake where `CB_FRAME_REQ` did not advance.
        drawlistPump.publish()
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
    netPump?.pump()
    genPump.pump()
    uploadPump.pump()
    actionPump?.pump()
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
  return { body, timeoutMs: noTimeout, testCall: (m) => handleTestCall(inst, m) }
}
