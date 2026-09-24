// `presence-worker-path.html`'s script (docs/plan/19-presence-channel.md, step 6): a real
// `createClient()` local topology over `fx-presence` (`host.connect: true`, `connected.ts`'s own
// precedent), no renderer -- this page is for `presence-worker-path.spec.ts`'s own claim that a
// fixture presence sample written every client frame reaches the sim worker's own `PresenceTable`
// (`host::ConnCounters::presence_bytes_up`, `engine/test`'s `uplinkPresenceBytes`) with `drops ==
// 0` on both rings.
import { createClient } from '../../../../src/client.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import type { NetCounters } from '../../../../src/test/client.ts'
import {
  netCounters,
  pumpUntilLive,
  resumeWorkers,
  stepFrame,
  stepSimTickSync,
  untilQuiescent,
} from '../../../../src/test/client.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** Runs `frames` client frames at a steady 60 fps (`PresenceClient::frame`'s own counter-driven
     * sample changes every single call, `fixtures/presence/src/lib.rs`), ticking the sim worker
     * every `ticksEvery`-th frame (roughly 20 Hz against a 60 fps frame loop, matching 0010's own
     * tick rate), then settles and returns `netCounters()`. One round trip for the whole run, per
     * the fast `browser` suite's own time budget (keep this page's own test short).
     */
    __run?: (frames: number) => Promise<NetCounters>
  }
}

const wasm = await fixtureWasm('presence')
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'presence-worker-path', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: {} },
})
// `pumpUntilLive` (docs/plan/16-action-round-trip.md, `engine/test`'s own doc comment): this
// page's own ticks are test-driven, and `client.ready` now needs one real frame before it
// resolves.
await pumpUntilLive(client)

// This page draws nothing: keep `uploadRing` drained the same way `connected.ts` does, so it never
// fills while `__run` is stepping frames.
const uploadDiscard = new RingConsumer(client.uploadRing)
const uploadDiscardBuf = new Uint8Array(4112)
setInterval(() => {
  for (;;) {
    if (uploadDiscard.popInto(uploadDiscardBuf, 0) < 0) break
  }
}, 16)

window.__run = async (frames) => {
  await resumeWorkers(client)
  const TICK_EVERY = 3 // ~20 Hz sim ticks against a 60 fps frame loop (0010's own 20 Hz default)
  for (let i = 0; i < frames; i++) {
    stepFrame(client, 1000 / 60)
    if (i % TICK_EVERY === 0) {
      // `stepSimTickSync`, not `stepTick`: the latter parks every worker on its own way out
      // (`untilQuiescent`'s own tail call), which the very next `stepFrame` in this loop cannot
      // wake from without an explicit `resumeWorkers` round trip -- `gc-connected-terrain.ts`'s
      // own `drive()` is the precedent for driving frame and tick in the same tight loop.
      stepSimTickSync(client, 1)
    }
  }
  // Settles every ring and parks every worker once, at the end (`netCounters`'s own precondition).
  await untilQuiescent(client)
  return netCounters(client)
}

window.__pageReady = true
