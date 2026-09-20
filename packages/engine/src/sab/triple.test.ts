import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'
import { createTriple, TripleReader, TripleWriter } from './triple.js'

test('triple.newest_wins_never_partial', async () => {
  const headerBytes = 16
  const bodyBytes = 32
  const count = 2000
  const sab = createTriple(headerBytes, bodyBytes)
  const reader = new TripleReader(sab, headerBytes, bodyBytes)
  const doneFlag = new SharedArrayBuffer(4)
  const done = new Int32Array(doneFlag)
  const worker = new Worker(new URL('../test/sab-triple-worker.mjs', import.meta.url), {
    workerData: { sab, headerBytes, bodyBytes, count, idleSpins: 20_000, doneFlag },
  })
  let workerError: unknown
  worker.on('error', (e) => {
    workerError = e
  })

  // A tight synchronous loop below never yields to the event loop, so it cannot depend on a
  // 'message' listener firing mid-loop; poll `done` as plain shared memory instead (`seqlock.
  // test.ts` has the same shape, with more detail on why).
  let lastValue = 0
  let freshCount = 0
  let inconsistent = 0
  let wentBackwards = 0
  while (Atomics.load(done, 0) === 0 || freshCount < 10) {
    const slot = reader.acquire()
    const header = reader.headerView(slot)
    const body = reader.bodyView(slot)
    const value = header[0] as number
    for (let b = 0; b < header.length; b++) if (header[b] !== value) inconsistent++
    for (let b = 0; b < body.length; b++) if (body[b] !== (value & 0xff)) inconsistent++
    if (reader.fresh) {
      freshCount++
      if (value !== 0 && value <= lastValue && lastValue !== 0) {
        // values are stamped mod 256 (`i & 0xff`); only flag a real regression, not the wrap.
        if (!(lastValue > 200 && value < 56)) wentBackwards++
      }
      lastValue = value
    }
  }

  await new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve())
    worker.once('error', reject)
  })
  if (workerError) throw workerError
  expect(inconsistent).toBe(0)
  expect(wentBackwards).toBe(0)
  expect(freshCount).toBeGreaterThan(0)
}, 15_000)

test('triple.slot_handoff_never_aliases', () => {
  // Single-threaded simulation of several publish/acquire rounds: writer and reader must never
  // hold the same slot index at the same time.
  const sab = createTriple(4, 4)
  const writer = new TripleWriter(sab, 4, 4)
  const reader = new TripleReader(sab, 4, 4)

  for (let round = 0; round < 10; round++) {
    const backBefore = writer.backSlot()
    writer.headerView(backBefore)[0] = round
    writer.publish()
    const front = reader.acquire()
    expect(front).not.toBe(writer.backSlot()) // writer's new back is never the reader's front
    expect(reader.headerView(front)[0]).toBe(round)
    expect(reader.fresh).toBe(true)
  }

  // A second acquire with nothing new published is not fresh and returns the same slot.
  const front = reader.acquire()
  expect(reader.fresh).toBe(false)
  expect(front).toBe(reader.acquire())
})
