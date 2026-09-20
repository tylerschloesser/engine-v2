import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'
import { createSeqlock, SeqlockReader, SeqlockWriter } from './seqlock.js'

test('seqlock.no_torn_read', async () => {
  const dataBytes = 64
  const count = 80
  const baseSpins = 6_000_000
  const sab = createSeqlock(dataBytes)
  const reader = new SeqlockReader(sab)
  const doneFlag = new SharedArrayBuffer(4)
  const done = new Int32Array(doneFlag)
  const worker = new Worker(new URL('../test/sab-seqlock-worker.mjs', import.meta.url), {
    workerData: { sab, count, baseSpins, doneFlag },
  })
  let workerError: unknown
  worker.on('error', (e) => {
    workerError = e
  })

  // A tight synchronous loop below never yields to the event loop, so it cannot depend on a
  // 'message' listener firing mid-loop (Node dispatches those on the event loop, which this loop
  // never reaches until it returns). Poll `done` as plain shared memory instead -- correct
  // regardless of how much the reader's own presence slows the writer down -- and pace the reader
  // with its own jittered idle spin between reads (see the worker file for why a real timed sleep
  // on both sides was worse, not better).
  const dst = new Uint8Array(dataBytes)
  let reads = 0
  let inconsistent = 0
  let i = 0
  while (Atomics.load(done, 0) === 0 || reads < 30) {
    const ok = reader.readInto(dst, 0)
    if (ok) {
      reads++
      const first = dst[0] as number
      for (let b = 1; b < dst.length; b++) {
        if (dst[b] !== first) {
          inconsistent++
          break
        }
      }
    }
    const spins = 4_000_000 + (((i * 2246822519) >>> 0) % 4_000_000)
    i++
    let sink = 0
    for (let k = 0; k < spins; k++) sink = (sink + 1) | 0
    if (sink < 0) throw new Error('unreachable')
  }

  await new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve())
    worker.once('error', reject)
  })
  if (workerError) throw workerError
  expect(reads).toBeGreaterThan(0)
  expect(inconsistent).toBe(0) // structural: readInto never returns a torn copy
  expect(reader.torn()).toBe(0)
}, 15_000)

test('seqlock.begin_end_toggle_parity', () => {
  // Single-threaded: begin() must leave the seq word odd, end() even, so a concurrent reader's
  // "(seq & 1) === 1 means write in progress" check is meaningful.
  const sab = createSeqlock(8)
  const writer = new SeqlockWriter(sab)
  const seqView = new Int32Array(sab, 0, 1)
  expect(Atomics.load(seqView, 0)).toBe(0)
  writer.begin()
  expect(Atomics.load(seqView, 0) % 2).toBe(1)
  writer.end()
  expect(Atomics.load(seqView, 0) % 2).toBe(0)

  const reader = new SeqlockReader(sab)
  const dst = new Uint8Array(8)
  expect(reader.readInto(dst, 0)).toBe(true)
  expect(reader.torn()).toBe(0)
})
