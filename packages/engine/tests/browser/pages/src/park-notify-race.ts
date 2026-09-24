// `park-notify-race.html`'s script (M19b, docs/plan/19b-sim-park-while-armed.md): races the real
// `parkOne` signal against a worker deliberately paused inside the gap `park-notify-race-worker.ts`'s
// own hook widens. Gate round 1: calls `signalPark` (`src/test/step-block.ts`), the exact exported
// function `src/test/harness.ts`'s `parkOne` itself calls -- not a hand-written copy of its two
// statements -- so this test guards `parkOne`'s own side of the fix (a dropped `Atomics.add` inside
// the shared signal) as well as `armedLoop`'s (the wait target). Bounded from outside (`setTimeout`
// + `worker.terminate()`): a worker that misses the signal blocks in `Atomics.wait` forever, since
// this test supplies no further notify.
import { createStepBlock, signalPark, stepBlockView } from '../../../../src/test/step-block.ts'

declare global {
  interface Window {
    __pageReady?: true
    __testParkNotifySurvivesWaitRegistrationGap?: (
      spinMs: number,
      timeoutMs: number,
    ) => Promise<'returned' | 'timed-out'>
  }
}

window.__testParkNotifySurvivesWaitRegistrationGap = (spinMs, timeoutMs) => {
  return new Promise((resolve) => {
    const sabBuffer = createStepBlock()
    const block = stepBlockView(sabBuffer)

    const worker = new Worker(new URL('./park-notify-race-worker.ts', import.meta.url), {
      type: 'module',
    })
    const timer = setTimeout(() => {
      worker.terminate()
      resolve('timed-out')
    }, timeoutMs)
    worker.onmessage = (ev: MessageEvent<unknown>) => {
      if (ev.data === 'about-to-wait') {
        // The real `parkOne` signal, called through the same exported function `parkOne` itself
        // uses, fired the instant the worker says it is about to call `Atomics.wait` (still
        // spinning in its own hook, not yet registered as a waiter).
        signalPark(block)
        return
      }
      // `armedLoop` itself posts `{ type: 'armed' }`/`{ type: 'parked' }` (`harness-worker.ts`'s own
      // protocol, unrelated to this test); only this worker's own plain strings matter here.
      if (ev.data !== 'returned') return
      clearTimeout(timer)
      worker.terminate()
      resolve('returned')
    }
    worker.postMessage({ block: sabBuffer, spinMs })
  })
}

window.__pageReady = true
