// `upload-quiescence.html`'s script (docs/plan/20c-client-ack-freeze-under-untilquiescent.md): the
// minimal deterministic reproduction of `untilQuiescent` hanging on an undrained `uploadRing`. A
// real `createClient()` local, **connected** topology over `fx-puts` (the same fixture `connected.
// ts`/`connected-terrain.ts` use -- its client role does reserve `ChunkTexels`/`Uploader`, so real
// camera movement genuinely stages `CHUNK` records into `uploadRing`), driven by a manual clock with
// no real frame loop at all -- `asHarness`, `stepFrame`, `pumpUntilLive`, `stepTick`'s own free
// functions, this file's one topology.
//
// **Nothing on this page ever drains `client.uploadRing`.** Every other `connect: true` page in
// this directory works around `untilQuiescent` waiting on that one ring: `connected.ts`'s own
// `uploadDiscard` interval, `connected-terrain.ts`'s background drain, `gc-connected-terrain.ts`'s
// per-frame `uploadDrain.drain()` (`games/reference/src/gc-entry.ts`'s own `drainUploadsFully`, the
// same shape again). This page deliberately omits all of that: after the fix (`test/client.ts`'s
// `ringSabs` no longer includes `uploadRing`), `stepTick` must still resolve promptly regardless.
import { createClient } from '../../../../src/client.ts'
import { RingConsumer, type RingStats } from '../../../../src/sab/ring.ts'
import {
  pumpUntilLive,
  resumeWorkers,
  setCamera,
  stepFrame,
  stepTick,
} from '../../../../src/test/client.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    // Not named `__advance`: every other page's own `declare global` augmentation of that name
    // returns `Promise<NetCounters>` (a project-wide TS merge, `gc-connected-terrain.ts`'s own
    // doc comment: "a TS project-wide `declare global` must match exactly everywhere it appears"),
    // and this page has no `netCounters()` need.
    __advanceNoWait?: (x: number, y: number, tilesAcross: number, ticks: number) => Promise<void>
    /** Proof this test's own `stepTick` calls genuinely resolved with `uploadRing` still
     * undrained (`pushed > popped`), not merely because it happened to be empty already. */
    __uploadStats?: () => RingStats
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
    world: { worldId: 'upload-quiescence-test', params: { seed: '1', worldgen: null } },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: {} },
})
await pumpUntilLive(client)

// `connected.ts`'s own `__advance`, minus the `netCounters()` read-back this page has no need for:
// `resumeWorkers` (a no-op if nothing is parked; a prior call's own trailing `stepTick`/
// `untilQuiescent` leaves every worker parked, and a bare `stepFrame` cannot reach a parked worker)
// + `setCamera` + one `stepFrame` (past `ClientCore::poll_uplink`'s own rate limits) + `stepTick(n)`
// -- the exact shape that hangs on the base commit once real chunk uploads have landed in
// `uploadRing` (Deviations has the pasted red output).
window.__advanceNoWait = async (x, y, tilesAcross, ticks) => {
  await resumeWorkers(client)
  setCamera(client, { x, y, tilesAcross })
  stepFrame(client, 2000)
  await stepTick(client, ticks)
}

window.__uploadStats = () => {
  const stats: RingStats = { drops: 0, pushed: 0, popped: 0 }
  new RingConsumer(client.uploadRing).stats(stats)
  return stats
}

window.__pageReady = true
