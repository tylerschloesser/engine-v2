// `puts-dispatch.html`'s script (docs/plan/16-action-round-trip.md step 4, "bindings step + typed
// fixture page"): proves the generated `bindings/*.ts` are real types a page can build `dispatch`
// calls and `onActionResult` handlers against, and that `pnpm lint`'s `tsc` catches a mismatch
// between them and `client.ts`'s own generic surface. Deliberately separate from `slice.html`
// (steps 6-7, a different implementer's own page, with the HUD/Paint-control/Playwright-driven
// vertical slice): this page exists only to be built and type-checked, never opened by a spec here.

import type { Action } from '../../../../fixtures/puts/bindings/Action.ts'
import type { Reject } from '../../../../fixtures/puts/bindings/Reject.ts'
import { createClient } from '../../../../src/client.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import { parkWorkers, resumeWorkers, stepFrame, stepTick } from '../../../../src/test/client.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Dispatches a typed `Paint` action at `(x, y)`; returns its `seq`. */
    __dispatchPaint?: (x: number, y: number) => number
    /** Dispatches a typed `Bump` action at a position no entity ever occupies (`fx-puts`'s own
     * `Bump`/`Remove` handlers always reject `NotFound` until M21, module doc comment on
     * `fixtures/puts/src/lib.rs`): the one deterministic way this fixture ever produces a
     * `Rejected` result. */
    __dispatchBumpNothing?: (x: number, y: number) => number
    __confirmed?: number
    __rejected?: number
    __stepTick?: (n: number) => Promise<void>
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
  }
}

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'puts-dispatch-test', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: {} },
})
await client.ready

// Nothing here renders (bare, undrawn `<canvas>`, `connected.ts`'s own precedent): the upload ring
// is kept empty by a plain discard loop rather than a real renderer.
const uploadDiscard = new RingConsumer(client.uploadRing)
const uploadDiscardBuf = new Uint8Array(4112)
setInterval(() => {
  for (;;) {
    if (uploadDiscard.popInto(uploadDiscardBuf, 0) < 0) break
  }
}, 16)

window.__confirmed = 0
window.__rejected = 0
// `Reject` supplied as `onActionResult`'s own type parameter (Deviations: "onActionResult's reason
// is fully typed on both halves") -- `result` here is `ActionOutcome<Reject>`, not `unknown`.
client.onActionResult<Reject>((_seq, result) => {
  if (result === 'Confirmed') window.__confirmed = (window.__confirmed ?? 0) + 1
  else window.__rejected = (window.__rejected ?? 0) + 1
})

window.__dispatchPaint = (x, y) => {
  const action: Action = { Paint: { pos: { x, y }, base: 1, resource: 0 } }
  return client.dispatch(action)
}
window.__dispatchBumpNothing = (x, y) => {
  const action: Action = { Bump: { at: { x, y } } }
  return client.dispatch(action)
}
window.__stepTick = (n) => stepTick(client, n)
window.__park = () => parkWorkers(client)
window.__resume = () => resumeWorkers(client)

// One deterministic frame/tick so a caller can `dispatch` immediately after `__pageReady` without
// separately driving the sim itself (`stepFrame`'s own manual-clock precedent, `connected.ts`).
stepFrame(client, 0)

window.__pageReady = true
