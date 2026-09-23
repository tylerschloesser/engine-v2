// `armed-loop-race.html`'s script (M17c step 3, fix round 3, docs/plan/17c-client-park-stall.md):
// exposes a debug hook that constructs the exact race `armedLoop`'s own doc comment names
// (`src/test/harness-worker.ts`) -- `Yield` already 1 before `armedLoop`'s own first wait ever
// runs, the same shape `harness.ts`'s `parkOne` produces when its own `Atomics.notify(Req)` (never
// changing `Req`) lands before the worker is back in `Atomics.wait` -- and bounds the result from
// outside, since a still-broken `armedLoop` blocks its own worker thread in `Atomics.wait` forever
// (no timeout argument, and this test supplies no producer to ever notify it again).
import { createStepBlock, StepBlockField, stepBlockView } from '../../../../src/test/step-block.ts'

declare global {
  interface Window {
    __pageReady?: true
    __testArmedLoopChecksYieldFirst?: (timeoutMs: number) => Promise<'returned' | 'timed-out'>
  }
}

window.__testArmedLoopChecksYieldFirst = (timeoutMs) => {
  return new Promise((resolve) => {
    const sabBuffer = createStepBlock()
    const block = stepBlockView(sabBuffer)
    // The race: stored before `armedLoop` (in the worker below) ever reads anything at all.
    Atomics.store(block, StepBlockField.Yield, 1)

    const worker = new Worker(new URL('./armed-loop-race-worker.ts', import.meta.url), {
      type: 'module',
    })
    const timer = setTimeout(() => {
      worker.terminate()
      resolve('timed-out')
    }, timeoutMs)
    worker.onmessage = (ev: MessageEvent<unknown>) => {
      // `armedLoop` itself posts `{ type: 'armed' }`/`{ type: 'parked' }` (`harness-worker.ts`'s
      // own protocol, unrelated to this test) well before it could ever hang -- `post(ARMED)` runs
      // before the loop's own first wait. Only this worker's own plain `'returned'` string means
      // `armedLoop` actually returned.
      if (ev.data !== 'returned') return
      clearTimeout(timer)
      worker.terminate()
      resolve('returned')
    }
    worker.postMessage(sabBuffer)
  })
}

window.__pageReady = true
