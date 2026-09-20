// Test-only worker for `ring.test.ts`'s `ring.spsc_sequence` (docs/plan/06-sab-primitives-and-
// workers.md): a producer on a real Node `worker_threads` thread, pushing sequenced, variable-size
// messages (up to 5 slots) into a ring the main thread drains. Imports the built `dist/` output
// (the `tsc` build step of `pnpm test` runs before `unit`; same pattern as `tests/wasm/bun-leg.mjs`)
// since a plain `.mjs` worker cannot import `.ts` sources directly. Busy-retries `tryPush` on a full
// ring rather than sleeping: no ambient-time globals are needed, and the real parallel consumer
// drains it quickly.
import { parentPort, workerData } from 'node:worker_threads'
import { RingProducer } from '../../dist/sab/ring.js'

const { sab, count, payloadBytes } = workerData
const producer = new RingProducer(sab)
const maxLen = payloadBytes * 5
const msg = new Uint8Array(maxLen)

for (let i = 0; i < count; i++) {
  const len = 4 + (((i * 2654435761) >>> 0) % (maxLen - 4))
  msg[0] = i & 0xff
  msg[1] = (i >>> 8) & 0xff
  msg[2] = (i >>> 16) & 0xff
  msg[3] = (i >>> 24) & 0xff
  for (let b = 4; b < len; b++) msg[b] = (i + b) & 0xff
  while (!producer.tryPush(msg, len)) {
    // ring full: the consumer drains in parallel, retry
  }
}
parentPort?.postMessage({ done: true, pushed: count })
