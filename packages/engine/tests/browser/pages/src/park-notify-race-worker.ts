// M19b (docs/plan/19b-sim-park-while-armed.md): constructs, deterministically, the residual race
// `armedLoop`'s own fix closes -- a park signal (`harness.ts`'s `parkOne`) landing in the gap
// between the loop's own `Yield` check and the moment its `Atomics.wait` call actually registers
// this thread as a waiter. `armedLoop` cannot be paused from outside mid-statement, so this worker
// widens that one gap on purpose, through the caller-supplied `testHooks.beforeWait` hook
// (`src/test/harness-worker.ts`, present only for this test): tell the page the loop is about to
// call `Atomics.wait`, then spin this worker's own OS thread for a real, bounded stretch of
// wall-clock time before actually calling it -- giving the page script (on a genuinely different
// thread) a real window to land its own store+notify before the wait registers. Sibling to
// `armed-loop-race-worker.ts` (M17c), which constructs the *other* gap (before the loop's own first
// wait); this one is for the narrower, per-iteration gap fix round 3 left open.
import { armedLoop } from '../../../../src/test/harness-worker.ts'

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<{ block: SharedArrayBuffer; spinMs: number }>) => void) | null
  postMessage(m: string): void
}

scope.onmessage = (ev) => {
  const { block, spinMs } = ev.data
  const view = new Int32Array(block)
  armedLoop(view, {
    beforeWait: () => {
      // Fires once per loop pass, on this worker's own thread, right after the `Yield` check and
      // right before `Atomics.wait` -- exactly the spot `armedLoop`'s own doc comment names.
      scope.postMessage('about-to-wait')
      const until = Date.now() + spinMs
      while (Date.now() < until) {
        // Deliberately busy: widens the real gap on this thread so the page script's own
        // store+notify (sent the instant it receives 'about-to-wait') reliably lands inside it.
      }
    },
  })
  scope.postMessage('returned')
}
