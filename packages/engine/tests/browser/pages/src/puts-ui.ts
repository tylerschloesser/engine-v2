// `puts-ui.html`'s script (docs/plan/16b-ui-observation-and-clock.md step 4/5, "a DOM counter
// driven by onUi and a progress value derived from a done_at tick and clock()"): a real, connected
// `createClient()` topology over `fx-puts`'s own `PutsUi { motd, note, note_until, global_ticks }`.
// The game-owned DOM overlay (0003: "Game UI is a game-owned DOM overlay; the engine renders no UI
// widgets") is exactly the two `<div>`s `puts-ui.html` declares, written only from `client.onUi` --
// no other code here ever touches them, so their text is a direct, end-to-end proof of the whole
// UI-ring -> onUi -> DOM path.
import type { Action } from '../../../../fixtures/puts/bindings/Action.ts'
import type { PutsUi } from '../../../../fixtures/puts/bindings/PutsUi.ts'
import { createClient } from '../../../../src/client.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  lastUi,
  parkWorkers,
  pumpUntilLive,
  resumeWorkers,
  stepTick,
} from '../../../../src/test/client.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Dispatches `SetNote { n }` (a player-scoped put, `fx-puts`'s own action); returns its
     * `seq`. `n = 0` is `Puts::tick`'s own "no note" convention -- dispatching it clears a note
     * early instead of waiting out `NOTE_TTL_SECS`. */
    __dispatchSetNote?: (n: number) => number
    __stepTick?: (n: number) => Promise<void>
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
    /** Count of `Confirmed` results seen so far (`puts-dispatch.ts`'s own `__confirmed` shape): a
     * `SetNote` dispatch needs a real host round trip (admit, apply, a downlink frame back) before
     * its note shows up in `Ui`, and the delivery-order rule (Provides: "onUi then results") means
     * this counter moving to 1 is a safe proxy for "the corresponding `Ui` update, if any, has
     * already been delivered too" -- a test ticks until this moves rather than assuming a fixed
     * tick count. */
    __confirmed?: number
    /** `engine/test.lastUi`'s own reading, exposed here as the "ground truth" channel
     * (docs/plan/16b-ui-observation-and-clock.md Tests added, `dom_counter_follows_global`):
     * independent of the DOM (a second `client.onUi` subscription, not a read of `#global`'s own
     * text), so comparing the two proves the DOM overlay actually reflects what `onUi` delivered,
     * not merely that the page can read its own state back. */
    __lastGlobalTicks?: () => number | null
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
    world: { worldId: 'puts-ui-test', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: {} },
})
await pumpUntilLive(client)

// Nothing here renders (bare, undrawn `<canvas>`, `puts-dispatch.ts`'s own precedent): the upload
// ring is kept empty by a plain discard loop rather than a real renderer.
const uploadDiscard = new RingConsumer(client.uploadRing)
const uploadDiscardBuf = new Uint8Array(4112)
setInterval(() => {
  for (;;) {
    if (uploadDiscard.popInto(uploadDiscardBuf, 0) < 0) break
  }
}, 16)

const globalEl = document.getElementById('global')
const progressEl = document.getElementById('progress')
// `onUi` only ever fires for a change delivered *after* this subscription exists (Provides:
// "coalesced to the newest value per rAF" -- a listener registered late simply never sees an
// earlier delivery, the same shape `onActionResult` already has). `pumpUntilLive`'s own ticking
// happened before this registration and may already have produced a real change no listener here
// ever saw, so these two elements start at their own sensible "nothing dispatched yet" defaults
// rather than staying blank until the next real one.
if (globalEl) globalEl.textContent = '0'
if (progressEl) progressEl.textContent = '0'

client.onUi<PutsUi>((ui) => {
  if (globalEl) globalEl.textContent = String(ui.global_ticks)
  // docs/decisions/0006-time-units.md "On the client": the UI never counts ticks itself -- derives
  // remaining time from the replicated `done_at` tick (`note_until`) and `client.clock()`'s own
  // authoritative tick, not from anything `Ui` itself accumulates. `note_until === 0` is "no note
  // set (or already expired)" (`PutsClient::ui`'s own doc comment): zero remaining, not a stale
  // negative countdown from tick 0.
  const remaining =
    ui.note_until === 0 ? 0 : Math.max(0, ui.note_until - client.clock().authoritative)
  if (progressEl) progressEl.textContent = String(remaining)
})

window.__confirmed = 0
client.onActionResult((_seq, result) => {
  if (result === 'Confirmed') window.__confirmed = (window.__confirmed ?? 0) + 1
})

window.__dispatchSetNote = (n) => {
  const action: Action = { SetNote: { n } }
  return client.dispatch(action)
}
window.__stepTick = (n) => stepTick(client, n)
window.__park = () => parkWorkers(client)
window.__resume = () => resumeWorkers(client)
window.__lastGlobalTicks = () => lastUi<PutsUi>(client)?.global_ticks ?? null

window.__pageReady = true
