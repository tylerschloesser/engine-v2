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

  await new Promise<void>((resolve) => worker.once('exit', () => resolve()))
}, 8_000)

test('control.workerWord addressing', () => {
  expect(workerWord(0, W_WAKE)).toBe(8)
  expect(workerWord(1, W_WAKE)).toBe(16)
  expect(workerWord(3, W_WAKE)).toBe(32)
})
