// `engine/test`: the production-topology counterparts of `src/test/harness.ts`'s M03 helpers, this
// time driving a real `createClient()` result (docs/plan/06b-workers-and-spawn.md, Seams). Never
// imported by production code.

import { writeCameraBlock } from '../camera/block.js'
import type { CameraState } from '../camera/state.js'
import type { Client } from '../client.js'
import { clientTestHandle } from '../client.js'
import {
  CB_FRAME_REQ,
  W_ACK,
  W_PARKED,
  W_YIELD,
  WORKER_CLIENT,
  workerWord,
} from '../sab/control.js'
import { RingConsumer, type RingStats } from '../sab/ring.js'

/** The spike's ack-timeout guard (`spikes/zero-gc-webgpu/public/main.js`), reused by `stepFrame`
 * (Planning decisions "Stepped frames in tests"). */
const SPIN_LIMIT = 2_000_000_000
const POLL_TIMEOUT_MS = 10_000

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Polls `predicate` on a macrotask (main never blocks, 0015 §2), rejecting after
 * `POLL_TIMEOUT_MS` so a stuck worker fails a test instead of hanging the runner. */
function pollUntil(predicate: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = now()
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (now() - start > POLL_TIMEOUT_MS) {
        reject(new Error(`${what}: timed out after ${POLL_TIMEOUT_MS} ms`))
        return
      }
      setTimeout(tick, 0)
    }
    tick()
  })
}

/** Every ring `SharedArrayBuffer` in a `SabSet` (`untilQuiescent`'s "every ring `PUSHED ==
 * POPPED`"). */
function ringSabs(client: Client): SharedArrayBuffer[] {
  const { sabs } = clientTestHandle(client)
  return [
    sabs.uploadRing,
    sabs.actionRing,
    sabs.inputRing,
    sabs.uiRing,
    sabs.uplink,
    sabs.downlink,
    ...sabs.genRequest,
    ...sabs.genResult,
  ]
}

function ringDrained(sab: SharedArrayBuffer): boolean {
  const stats: RingStats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer(sab).stats(stats)
  return stats.pushed === stats.popped
}

/** Parks every spawned worker: `W_YIELD = 1` then a wake, polling `W_PARKED` (main never blocks on
 * a `SharedArrayBuffer`, so this is a macrotask poll, not `Atomics.wait`). */
export function parkWorkers(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  for (const w of h.workers) {
    Atomics.store(h.control.words, workerWord(w.index, W_YIELD), 1)
    h.control.wake(w.index)
  }
  return pollUntil(
    () =>
      h.workers.every((w) => Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) === 1),
    'parkWorkers',
  )
}

/** Resumes every parked worker: `W_YIELD = 0`, `{ type: 'resume' }` (a parked worker is not
 * blocked, so this is the one way to reach it: Planning decisions "`yield` protocol"). */
export function resumeWorkers(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  for (const w of h.workers) {
    Atomics.store(h.control.words, workerWord(w.index, W_YIELD), 0)
    w.worker.postMessage({ type: 'resume' })
  }
  return pollUntil(
    () =>
      h.workers.every((w) => Atomics.load(h.control.words, workerWord(w.index, W_PARKED)) === 0),
    'resumeWorkers',
  )
}

/** Resolves once every worker has acknowledged every request and is parked (Seams): the client's
 * `W_ACK` has caught up with `CB_FRAME_REQ`, every ring is drained, then every worker is parked. */
export async function untilQuiescent(client: Client): Promise<void> {
  const h = clientTestHandle(client)
  const hasClient = h.workers.some((w) => w.kind === 'client')
  await pollUntil(() => {
    if (
      hasClient &&
      Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)) !==
        Atomics.load(h.control.words, CB_FRAME_REQ)
    ) {
      return false
    }
    return ringSabs(client).every(ringDrained)
  }, 'untilQuiescent')
  await parkWorkers(client)
}

/**
 * Advances the injected clock, writes the camera block, increments `CB_FRAME_REQ`, wakes the
 * client worker and spins on `W_ACK` (Planning decisions "Stepped frames in tests"; the spike's own
 * lockstep). Throws if no `client`-kind worker was spawned, or if it never acks.
 */
export function stepFrame(client: Client, dtMs: number): void {
  const h = clientTestHandle(client)
  const clockLike = h.clock as unknown as { advance?(ms: number): void; now(): number }
  clockLike.advance?.(dtMs)
  h.cameraState.frameTimeMs = clockLike.now()
  writeCameraBlock(h.cameraWriter, h.cameraState)
  const req = (Atomics.add(h.control.words, CB_FRAME_REQ, 1) + 1) >>> 0
  h.control.wake(WORKER_CLIENT)
  let spins = 0
  while (Atomics.load(h.control.words, workerWord(WORKER_CLIENT, W_ACK)) !== req) {
    if (++spins > SPIN_LIMIT) {
      throw new Error('stepFrame: the client worker did not ack the frame request')
    }
  }
}

/** Sets the camera state `stepFrame` will next write to the camera block; takes effect on the next
 * `stepFrame` call, not immediately (Seams). */
export function setCamera(
  client: Client,
  opts: { x: number; y: number; tilesAcross: number },
): void {
  const { cameraState } = clientTestHandle(client)
  cameraState.centreX = opts.x
  cameraState.centreY = opts.y
  cameraState.tilesAcross = opts.tilesAcross
}

export type { CameraState }
