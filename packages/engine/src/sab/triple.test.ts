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
  // Decodes the worker's stamp: the full 32-bit counter as four repeated little-endian bytes (see
  // sab-triple-worker.mjs), so every 4-byte chunk of header/body must read back the same value.
  function decodeStamp(view: Uint8Array, off: number): number {
    return (
      (view[off] as number) |
      ((view[off + 1] as number) << 8) |
      ((view[off + 2] as number) << 16) |
      ((view[off + 3] as number) << 24)
    )
  }

  let lastValue = 0
  let freshCount = 0
  let inconsistent = 0
  let wentBackwards = 0
  // Loop exactly until the writer's own `done` flag is observed set, plus the one iteration that
  // observes it (never on `freshCount`, see the fix-round-2 Deviations note: requiring a minimum
  // fresh-read count before exiting can livelock forever if the reader thread is starved relative
  // to the writer -- the writer finishes its fixed 2,000 publishes regardless, and once it is gone
  // no future acquire() can ever be fresh again). A deadline is still a backstop against a genuine
  // stall (the writer's worker never finishing at all): `process.hrtime.bigint()` is not one of
  // `packages/engine/src/**`'s banned ambient-time globals (`Date`/`performance`/timers), only a
  // monotonic duration check, and this file is test-only.
  const deadlineNs = 12_000_000_000n // 12s: under this test's own 15s Vitest timeout, so a genuine
  // stall reports this file's own diagnostic message instead of Vitest's generic timeout.
  const loopStart = process.hrtime.bigint()
  for (;;) {
    if (process.hrtime.bigint() - loopStart > deadlineNs) {
      throw new Error(
        `triple.newest_wins_never_partial: reader made no progress toward done within ` +
          `${deadlineNs}ns (freshCount=${freshCount}, done=${Atomics.load(done, 0)})`,
      )
    }
    const doneAlready = Atomics.load(done, 0) !== 0
    const slot = reader.acquire()
    const header = reader.headerView(slot)
    const body = reader.bodyView(slot)
    const value = decodeStamp(header, 0)
    for (let b = 0; b < header.length; b += 4) if (decodeStamp(header, b) !== value) inconsistent++
    for (let b = 0; b < body.length; b += 4) if (decodeStamp(body, b) !== value) inconsistent++
    if (reader.fresh) {
      freshCount++
      if (value < lastValue) wentBackwards++
      lastValue = value
    }
    if (doneAlready) break
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
