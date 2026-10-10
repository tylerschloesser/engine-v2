// `gen`-kind worker body (M08b, Order of work 3): drains its own
// `genRequest[i]` ring, calls `gen_chunk`, and produces a `genResult[i]` record back to the client
// (whose `W_WAKE` the result producer is constructed with, so a finished chunk wakes the client,
// Planning decisions 2). `W_ACK` is still stored on every real wake regardless of `gcHook` (a plain
// `Atomics.store`, allocation-free, after any job work that pass): docs/plan/
// 06b-workers-and-spawn.md, Notes for later briefs, and this milestone's own orchestrator decision
// ("`W_ACK` on a gen worker keeps M06b's meaning, not 'jobs finished'"). Finished jobs are counted
// where they are consumed: `GenStats.delivered` through `client_gen_stats`, and the ring's own
// `pushed`/`popped` counters.
import { RegionId, Role } from '../abi.js'
import { EngineTrap } from '../loader.js'
import { W_ACK, WORKER_CLIENT, WORKER_GEN0, workerWord } from '../sab/control.js'
import { RingConsumer, RingProducer } from '../sab/ring.js'
import { applyGcHook } from './gc-hook.js'
import { GEN_RECORD_HEADER_BYTES, readI32LE, writeGenHeader } from './gen-record.js'
import { instantiateFactoryForSetup } from './instantiate.js'
import { GEN_TRAPS_CALL, type SetupMessage, TRAPS_BYTES } from './protocol.js'
import type { LoopState, Shell } from './shell.js'
import { noTimeout } from './shell.js'
import { handleTestCall } from './test-call.js'
import { injectTrap } from './test-trap.js'

/** Request/result header bytes (M08b, Seams: `[cx i32][cy
 * i32][0 u32][0 u32]`; a result record is the same header followed by `GenOut`'s tile bytes). */
const HEADER_BYTES = GEN_RECORD_HEADER_BYTES

export async function setup(shell: Shell, message: SetupMessage): Promise<LoopState> {
  const newInstance = await instantiateFactoryForSetup(shell, message, Role.Gen)
  let inst = newInstance()
  const gcHook = message.test?.gcHook === true
  // `TestFlags.trapGenAtChunk` (M37 step 1): how many more traps to
  // inject for that chunk; counted across instance rebuilds.
  const trapSpec = message.test?.trapGenAtChunk
  let trapsLeft = trapSpec ? (trapSpec.times ?? 1) : 0
  // 0014 §6 (gen role): a trap means a fresh instance and the request tried again. Worldgen is pure,
  // so the same chunk trapping twice in a row will trap forever: fatal (reaches main as `fatal`, which
  // raises `client.onFatal`). `trappedOn` is the chunk the previous trap happened on.
  let trappedOn: { cx: number; cy: number } | null = null
  let traps = 0

  // `null` for a game with no `Worldgen` (e.g. `fx-hash`'s gen role, over which the production
  // `gc-topology`/`gc-echo` pages still spawn a gen worker by default, 0008 §2): the loop below
  // then never touches a ring, which is always correct there -- the client's own `gen_take` always
  // returns 0 without a `client::TerrainFeed`, so no request is ever dispatched to this worker.
  let genOut = inst.region(RegionId.GenOut)

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

  // 0015 §6 / Planning decisions 6: the gen worker checks its own result *slot's payload capacity*
  // against the region it will copy, once, at setup, and fails readably instead of writing past the
  // slot on every job -- `results.slotPayloadBytes()`, not `resultSab.byteLength` (the whole ring's
  // total bytes, `RING_CONTROL_BYTES + slotBytes * slots`: comparing against that instead would let
  // a slab many times too big for one slot pass this check, only to throw a much less readable
  // `RangeError` out of `Uint8Array.prototype.set` the first time a job actually ran). A thrown
  // `setup()` rejects, which `worker.ts`'s `run()` turns into `shell.fatal` *without* starting the
  // blocking loop (`shell.fatal` itself would leave a loop that still blocks forever in
  // `Atomics.wait` before ever observing `stopped()`).
  if (genOut && genOut.len + HEADER_BYTES > results.slotPayloadBytes()) {
    throw new Error(
      `gen worker: GenOut (${genOut.len} B) + header does not fit the configured genResult slot ` +
        `(${results.slotPayloadBytes()} B payload)`,
    )
  }

  /** Runs `gen_chunk(cx, cy)`; on a trap replaces the instance and returns `false` (the request
   * stays at the head of its ring, so the next pass tries it again). */
  function generate(cx: number, cy: number): boolean {
    try {
      if (trapSpec && trapsLeft > 0 && cx === trapSpec.cx && cy === trapSpec.cy) {
        trapsLeft--
        injectTrap(inst, `trapGenAtChunk: gen trap at chunk (${cx}, ${cy})`)
      }
      inst.call2(inst.x.gen_chunk, cx, cy)
      trappedOn = null
      return true
    } catch (e) {
      if (!(e instanceof EngineTrap)) throw e
      if (trappedOn !== null && trappedOn.cx === cx && trappedOn.cy === cy) {
        throw new Error(
          `gen worker: chunk (${cx}, ${cy}) trapped twice, worldgen is pure so it would trap forever: ${e.panicMessage}`,
        )
      }
      trappedOn = { cx, cy }
      traps++
      inst = newInstance()
      genOut = inst.region(RegionId.GenOut)
      return false
    }
  }

  function body(wokenBy: number): void {
    if (gcHook) applyGcHook(shell.control, shell.index)
    if (genOut) {
      for (;;) {
        // Claim a result slot before touching a request (Planning decisions 5: "a gen worker that
        // finds genResult full retries on its next wake and does not start another job"). An
        // uncommitted claim reserves nothing (M06,
        // Deviations), so abandoning it here when there is no request is free.
        const claimed = results.tryClaim()
        if (claimed < 0) break
        const reqIdx = requests.peek()
        if (reqIdx < 0) break
        const req = requests.slotView(reqIdx)
        const cx = readI32LE(req, 0)
        const cy = readI32LE(req, 4)

        // The request is released only after the chunk is generated (a trap leaves it queued for the
        // retry above).
        if (!generate(cx, cy)) continue
        requests.release()

        const out = results.slotView(claimed)
        writeGenHeader(out, 0, cx, cy)
        out.set((genOut as NonNullable<typeof genOut>).u8, HEADER_BYTES)
        results.commit()
      }
    }
    Atomics.store(shell.control.words, workerWord(shell.index, W_ACK), wokenBy)
  }

  return {
    body,
    timeoutMs: noTimeout,
    testCall: (m) => {
      if (m.name === GEN_TRAPS_CALL) {
        const result = new Uint8Array(TRAPS_BYTES)
        new DataView(result.buffer).setUint32(0, traps, true)
        return { type: 'test-result', id: m.id, value: 0, result }
      }
      return handleTestCall(inst, m)
    },
  }
}
