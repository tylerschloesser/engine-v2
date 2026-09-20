import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'
import {
  CB_FRAME_REQ,
  ControlBlock,
  createControlBlock,
  W_WAKE,
  WORKER_CLIENT,
  workerWord,
} from './control.js'

test('control.no_lost_wakeup', async () => {
  const target = 2000
  const sab = createControlBlock()
  const control = new ControlBlock(sab)
  const worker = new Worker(new URL('../test/sab-control-worker.mjs', import.meta.url), {
    workerData: { sab, target },
  })
  let workerError: unknown
  worker.on('error', (e) => {
    workerError = e
  })

  const done = new Promise<{ done: boolean; frameReq: number }>((resolve, reject) => {
    worker.once('message', (m) => resolve(m))
    worker.once('error', reject)
  })

  // Races the worker's own load/wait window on purpose: every iteration bumps the shared counter
  // and wakes, whether or not the worker has reached its `wait` call yet.
  for (let i = 0; i < target; i++) {
    Atomics.add(control.words, CB_FRAME_REQ, 1)
    control.wake(WORKER_CLIENT)
  }

  const result = await done
  if (workerError) throw workerError
  expect(result.frameReq).toBe(target)

  // Terminates the worker rather than waiting for its own natural `'exit'`: by this point the
  // worker's script has already finished and posted its result, so nothing further is being
  // tested -- only its OS thread teardown remains, and a *natural* exit's teardown work (see the
  // fix-round-2 Deviations note) can occasionally take several real seconds under heavy system
  // load, which blew this test's timeout despite the assertion above having already passed.
  // `terminate()` tears the thread down directly instead of waiting on that same slow path.
  await worker.terminate()
}, 8_000)

test('control.workerWord addressing', () => {
  expect(workerWord(0, W_WAKE)).toBe(8)
  expect(workerWord(1, W_WAKE)).toBe(16)
  expect(workerWord(3, W_WAKE)).toBe(32)
})
