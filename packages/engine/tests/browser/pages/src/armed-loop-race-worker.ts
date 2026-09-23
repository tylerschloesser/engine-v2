// M17c step 3, fix round 3 (docs/plan/17c-client-park-stall.md): calls `armedLoop`
// (`src/test/harness-worker.ts`) directly against a caller-supplied step block, so the race in its
// own doc comment (a `Yield` already set before `armedLoop`'s own first wait) can be constructed
// deterministically rather than timed through a real `parkOne` message round trip. Posts `'returned'`
// once `armedLoop` returns; on the broken protocol it never does, since nothing else notifies this
// block once it is inside `Atomics.wait` (this test supplies no producer at all) -- `armed-loop-
// race.ts`'s own caller bounds that with a `setTimeout` plus `worker.terminate()`.
import { armedLoop } from '../../../../src/test/harness-worker.ts'

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<SharedArrayBuffer>) => void) | null
  postMessage(m: string): void
}

scope.onmessage = (ev) => {
  armedLoop(new Int32Array(ev.data))
  scope.postMessage('returned')
}
