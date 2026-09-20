// Test-only worker for `control.test.ts`'s `control.no_lost_wakeup` (docs/plan/06-sab-primitives-
// and-workers.md, Planning decisions "The wake word is per consumer thread"). Loops the exact
// pattern `waitForWake` exists for: load the wake word, check the real condition (`CB_FRAME_REQ`
// reaching a target the main thread also bumps), and only block if it has not; a wake that raced
// ahead of the `wait` call is still seen because the loaded value already differs. If a wake were
// ever lost, this would block forever and the test's own timeout would catch it.
import { parentPort, workerData } from 'node:worker_threads'
import {
  CB_FRAME_REQ,
  ControlBlock,
  W_WAKE,
  WORKER_CLIENT,
  workerWord,
} from '../../dist/sab/control.js'

const { sab, target } = workerData
const control = new ControlBlock(sab)
const wakeAt = workerWord(WORKER_CLIENT, W_WAKE)
let last = Atomics.load(control.words, wakeAt)

for (;;) {
  const frameReq = Atomics.load(control.words, CB_FRAME_REQ)
  if (frameReq >= target) break
  last = control.waitForWake(WORKER_CLIENT, last, 5000)
}
parentPort?.postMessage({ done: true, frameReq: Atomics.load(control.words, CB_FRAME_REQ) })
