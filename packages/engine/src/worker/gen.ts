// `gen`-kind worker body (docs/plan/08b-gen-workers-and-queue.md, Order of work 3): drains its own
// `genRequest[i]` ring, calls `gen_chunk`, and produces a `genResult[i]` record back to the client
// (whose `W_WAKE` the result producer is constructed with, so a finished chunk wakes the client,
// Planning decisions 2). `W_ACK` is still stored on every real wake regardless of `gcHook` (a plain
// `Atomics.store`, allocation-free, after any job work that pass): docs/plan/
// 06b-workers-and-spawn.md, Notes for later briefs, and this milestone's own orchestrator decision
// ("`W_ACK` on a gen worker keeps M06b's meaning, not 'jobs finished'"). Finished jobs are counted
// where they are consumed: `GenStats.delivered` through `client_gen_stats`, and the ring's own
// `pushed`/`popped` counters.
import { RegionId, Role } from '../abi.js'
import { W_ACK, WORKER_CLIENT, WORKER_GEN0, workerWord } from '../sab/control.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'
import { applyGcHook } from './gc-hook.js'
import { instantiateForSetup } from './instantiate.js'
import type { SetupMessage } from './protocol.js'
import type { LoopState, Shell } from './shell.js'
import { noTimeout } from './shell.js'

/** Request/result header bytes (docs/plan/08b-gen-workers-and-queue.md, Seams: `[cx i32][cy
 * i32][0 u32][0 u32]`; a result record is the same header followed by `GenOut`'s tile bytes). */
const HEADER_BYTES = 16

function readI32LE(u8: Uint8Array, off: number): number {
  return (
    (u8[off] as number) |
    ((u8[off + 1] as number) << 8) |
    ((u8[off + 2] as number) << 16) |
    ((u8[off + 3] as number) << 24) |
    0
  )
}

function writeI32LE(u8: Uint8Array, off: number, v: number): void {
  u8[off] = v & 0xff
  u8[off + 1] = (v >>> 8) & 0xff
  u8[off + 2] = (v >>> 16) & 0xff
  u8[off + 3] = (v >>> 24) & 0xff
}

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  const inst = await instantiateForSetup(shell, message, Role.Gen)
  const gcHook = message.test?.gcHook === true

  // `null` for a game with no `Worldgen` (e.g. `fx-hash`'s gen role, over which the production
  // `gc-topology`/`gc-echo` pages still spawn a gen worker by default, 0008 §2): the loop below
  // then never touches a ring, which is always correct there -- the client's own `gen_take` always
  // returns 0 without a `client::TerrainFeed`, so no request is ever dispatched to this worker.
  const genOut = inst.region(RegionId.GenOut)

  // The control-block worker index (WORKER_GEN0/1) is not the array index into `sabs.genRequest`/
  // `genResult` (Planning decisions 6: `SabSet` is created before any instance exists, sized for
  // the worst case of two gen workers, ordinal 0 or 1).
  const ordinal = shell.index - WORKER_GEN0
  const requestSab = message.sabs.genRequest[ordinal]
  const resultSab = message.sabs.genResult[ordinal]
  if (!requestSab || !resultSab) {
    throw new Error(`gen worker: no genRequest/genResult SAB at ordinal ${ordinal}`)
  }
  const requests = new RingConsumer(requestSab)
  const results = new RingProducer(resultSab, { control: shell.control, index: WORKER_CLIENT })

  // 0015 §6: the gen worker checks its own result slot against the region it will copy, once, at
  // setup, and fails readably instead of writing past the slot on every job. A thrown `setup()`
  // rejects, which `worker.ts`'s `run()` turns into `shell.fatal` *without* starting the blocking
  // loop (`shell.fatal` itself would leave a loop that still blocks forever in `Atomics.wait`
  // before ever observing `stopped()`).
  if (genOut && genOut.len + HEADER_BYTES > resultSab.byteLength) {
    throw new Error(
      `gen worker: GenOut (${genOut.len} B) + header does not fit the configured genResult slot`,
    )
  }

  function body(wokenBy: number): void {
    if (gcHook) applyGcHook(shell.control, shell.index)
    if (genOut) {
      for (;;) {
        // Claim a result slot before touching a request (Planning decisions 5: "a gen worker that
        // finds genResult full retries on its next wake and does not start another job"). An
        // uncommitted claim reserves nothing (docs/plan/06-sab-primitives-and-workers.md,
        // Deviations), so abandoning it here when there is no request is free.
        const claimed = results.tryClaim()
        if (claimed < 0) break
        const reqIdx = requests.peek()
        if (reqIdx < 0) break
        const req = requests.slotView(reqIdx)
        const cx = readI32LE(req, 0)
        const cy = readI32LE(req, 4)
        requests.release()

        inst.call2(inst.x.gen_chunk, cx, cy)

        const out = results.slotView(claimed)
        writeI32LE(out, 0, cx)
        writeI32LE(out, 4, cy)
        writeI32LE(out, 8, 0)
        writeI32LE(out, 12, 0)
        out.set(genOut.u8, HEADER_BYTES)
        results.commit()
      }
    }
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
  }

  return { body, timeoutMs: noTimeout }
}
