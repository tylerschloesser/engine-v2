// `client`-kind worker body (docs/plan/06b-workers-and-spawn.md, Scope): instantiate, reserve the
// arena, copy the camera block into its `Camera` region and call `frame(t_ms)` when `CB_FRAME_REQ`
// has advanced since the last wake, storing `W_ACK` (Planning decisions "Worker frame clock").
// `test.echo` additionally drives the `echo` zero-GC page's SAB -> region -> region -> SAB round
// trip (Tests added), gated so it never runs in a production build that never sets the flag.
import { RegionId, Role } from '../abi.js'
import { CameraBlockView, readCameraBlockInto } from '../camera/block.js'
import type { EngineInstance, RegionView } from '../loader.js'
import { CB_FRAME_REQ, W_ACK, workerWord } from '../sab/control.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'

/** `CAM_OFF_FRAME_TIME_MS` (`camera/block.ts`): where `frame_time_ms` lands once the whole 80-byte
 * block is copied into this role's `Camera` region. */
const FRAME_TIME_BYTE_OFFSET = 24

function frameTimeView(region: RegionView): Float64Array {
  return new Float64Array(region.u8.buffer, region.u8.byteOffset + FRAME_TIME_BYTE_OFFSET, 1)
}

function requireRegion(inst: EngineInstance, id: RegionId, what: string): RegionView {
  const r = inst.region(id)
  if (!r)
    throw new Error(`client worker: ${what} region required but engine_init did not reserve it`)
  return r
}

const NO_TIMEOUT = (): number => Number.POSITIVE_INFINITY

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  const inst = await instantiateForSetup(shell, message, Role.Client)
  // A debugging/test convenience only: lets a Playwright test read the client instance's own
  // memory directly through `worker.evaluate()` (docs/plan/06b-workers-and-spawn.md, Tests added,
  // `workers.camera_block_reaches_wasm`) instead of inventing a message type for it.
  ;(self as unknown as { __engineInstance?: EngineInstance }).__engineInstance = inst
  const cameraRegion = requireRegion(inst, RegionId.Camera, 'Camera')
  const cameraReader = new CameraBlockView(message.sabs.cameraBlock)
  let frameTime = frameTimeView(cameraRegion)
  inst.onViewsRebuilt(() => {
    frameTime = frameTimeView(cameraRegion)
  })
  let lastFrameReq = Atomics.load(shell.control.words, CB_FRAME_REQ)

  const echo = message.test?.echo === true
  const actionRing = echo ? new RingConsumer(message.sabs.actionRing) : null
  const uiRing = echo ? new RingProducer(message.sabs.uiRing) : null
  const rx = echo ? requireRegion(inst, RegionId.Rx, 'Rx') : null
  const tx = echo ? requireRegion(inst, RegionId.Tx, 'Tx') : null

  function body(): void {
    const frameReq = Atomics.load(shell.control.words, CB_FRAME_REQ)
    if (frameReq !== lastFrameReq) {
      lastFrameReq = frameReq
      if (readCameraBlockInto(cameraReader, cameraRegion.u8, 0)) {
        inst.call1(inst.x.frame, frameTime[0] as number)
      }
      Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), frameReq)
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
  }

  return { body, timeoutMs: NO_TIMEOUT }
}
