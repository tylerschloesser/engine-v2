// Test-only worker for `seqlock.test.ts`'s `seqlock.no_torn_read` (docs/plan/06-sab-primitives-and-
// workers.md, Planning decisions "Seqlock reader rule"): a writer on a real Node `worker_threads`
// thread, stamping every byte of the record with one rotating value per write ("the writer stamps
// all bytes with one value", Tests added). A jittered busy-spin between writes keeps the writer's
// duty cycle low, the same shape as "one write per frame" (0015 §2), without an ambient timer
// (banned in `packages/engine/src/**` outside `src/clock.ts`) and without the exact-period lockstep
// an `Atomics.wait` timeout on both sides produced (measured while developing this test: real
// timed sleeps on both threads resonate and collide far more than jittered spinning).
//
// `doneFlag` (a one-word `SharedArrayBuffer`, separate from the seqlock's own SAB) is set last, so
// the main thread's reader -- a tight loop that cannot process a `postMessage` event without
// yielding to the event loop (it never does) -- can still poll "is the writer finished?" as plain
// shared memory.
import { workerData } from 'node:worker_threads'
import { SeqlockWriter } from '../../dist/sab/seqlock.js'

const { sab, count, baseSpins, doneFlag } = workerData
const writer = new SeqlockWriter(sab)
const done = new Int32Array(doneFlag)

for (let i = 0; i < count; i++) {
  const value = i & 0xff
  const data = writer.begin()
  for (let b = 0; b < data.length; b++) data[b] = value
  writer.end()
  const spins = baseSpins + (((i * 2654435761) >>> 0) % baseSpins)
  let sink = 0
  for (let k = 0; k < spins; k++) sink = (sink + 1) | 0
  if (sink < 0) throw new Error('unreachable') // keeps the idle loop from being optimised away
}
Atomics.store(done, 0, 1)
