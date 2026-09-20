// Test-only worker for `triple.test.ts`'s `triple.newest_wins_never_partial` (docs/plan/06-sab-
// primitives-and-workers.md, Planning decisions "Triple-buffer state word"): a writer on a real
// Node `worker_threads` thread, publishing frames each stamped with one monotonically increasing
// value across header and body, so the reader can check every acquired frame is internally
// consistent (never a mix of two publishes) and never equal to a slot it currently owns. The value
// is the full 32-bit counter, as four repeated little-endian bytes (not `i & 0xff`, which wraps
// every 256 and makes "did the reader ever go backwards" ambiguous once it starts legitimately
// skipping values -- newest-wins is the whole point, so the reader never sees most publishes).
//
// `doneFlag` (a one-word `SharedArrayBuffer`, separate from the triple buffer's own SAB) is set
// last: the main thread's reader is a tight loop that cannot process a `postMessage` event without
// yielding to the event loop (it never does), so it polls this as plain shared memory instead
// (`seqlock.test.ts`'s worker has the same shape, for the same reason).
import { workerData } from 'node:worker_threads'
import { TripleWriter } from '../../dist/sab/triple.js'

const { sab, headerBytes, bodyBytes, count, idleSpins, doneFlag } = workerData
const writer = new TripleWriter(sab, headerBytes, bodyBytes)
const done = new Int32Array(doneFlag)

function stamp(view, i) {
  const b0 = i & 0xff
  const b1 = (i >>> 8) & 0xff
  const b2 = (i >>> 16) & 0xff
  const b3 = (i >>> 24) & 0xff
  for (let b = 0; b < view.length; b += 4) {
    view[b] = b0
    view[b + 1] = b1
    view[b + 2] = b2
    view[b + 3] = b3
  }
}

for (let i = 1; i <= count; i++) {
  const slot = writer.backSlot()
  stamp(writer.headerView(slot), i)
  stamp(writer.bodyView(slot), i)
  writer.publish()
  let sink = 0
  for (let k = 0; k < idleSpins; k++) sink = (sink + 1) | 0
  if (sink < 0) throw new Error('unreachable')
}
Atomics.store(done, 0, 1)
