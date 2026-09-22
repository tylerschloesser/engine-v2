// `connected.html`'s script (docs/plan/15b-ring-connection-and-replica-rendering.md, step 6): a
// real `createClient()` local topology over `fx-puts`, `host.connect: true` (Orchestrator ruling
// 1) -- the sim and client workers linked over a real uplink/downlink ring pair, `SimHost.accept`
// admitting a real connection at startup. No renderer/canvas wiring (bare `<canvas>`, never drawn
// to): this page is for the non-pixel tests (`replica_hash_equals_host_in_browser`,
// `pan_changes_subscription`, `join_at_max_zoom_out_never_drops`, the ADR 0030 wake test) --
// `connected-terrain.html` is the renderer-backed sibling `overlay_tile_reaches_screen`/
// `hidden_tab_sends_no_camera_report` need. `test.flags = {}` (not omitted) enables the parked
// `test-call` channel `netCounters`/`replicaHash`/`hostRegionHash`/`worldHash`/`simCounters` all
// need, without arming real-time pacing (`test.pace` stays unset): every tick here is driven
// deterministically through `stepTick`, exactly like `sim-worker.ts`.
import { createClient } from '../../../../src/client.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import type { SimHostCounters } from '../../../../src/server.ts'
import type { NetCounters } from '../../../../src/test/client.ts'
import {
  hostRegionHash,
  netCounters,
  parkWorkers,
  replicaHash,
  resumeWorkers,
  setCamera,
  simCounters,
  stepFrame,
  stepTick,
  untilQuiescent,
  worldHash,
} from '../../../../src/test/client.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __setCamera?: (x: number, y: number, tilesAcross: number) => void
    __stepFrame?: (dtMs: number) => void
    __stepTick?: (n: number) => Promise<void>
    __untilQuiescent?: () => Promise<void>
    __netCounters?: (conn?: number) => Promise<NetCounters>
    __replicaHash?: () => Promise<string>
    __hostRegionHash?: (conn?: number) => Promise<string>
    __worldHash?: () => Promise<string>
    __simCounters?: () => Promise<SimHostCounters>
    __park?: () => Promise<void>
    __resume?: () => Promise<void>
    /** Combines `resumeWorkers` (a no-op if nothing is parked, `resumeWorkers`'s own doc comment)
     * + `setCamera` + one `stepFrame` (so the new camera report is queued for `client_poll_
     * uplink`'s next wake) + `stepTick(n)` (drives the sim, which admits that report, then parks
     * every worker again on its own way out) -- the one call a spec needs per phase, since
     * `stepTick`'s own trailing `parkWorkers` (`untilQuiescent`) leaves the client parked and a
     * bare `stepFrame` cannot reach a parked worker (`worker/shell.ts`: "a worker blocked in
     * Atomics.wait/parked receives no events"). Returns `netCounters()` read after settling. */
    __advance?: (x: number, y: number, tilesAcross: number, ticks: number) => Promise<NetCounters>
  }
}

const wasm = await fixtureWasm('puts')
const canvas = document.createElement('canvas')
// A manual clock (docs/plan/11-camera-and-input.md Planning decisions "Stepped frames in tests"):
// `ClientCore::poll_uplink`'s own 50 ms/1 s pacing (0010 "Rates") is real milliseconds read from
// `CameraBlock.frame_time_ms`, which `stepFrame` sets from this clock's `now()` -- without one,
// two `stepFrame` calls close together in *real* wall-clock time (this whole page's script easily
// runs faster than 50 ms) would fall inside the same rate-limit window and the second camera
// change would never actually reach the wire, deterministically or otherwise.
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: {
      worldId: 'connected-test',
      params: { seed: '1', worldgen: null },
    },
    connect: true,
  },
  genWorkers: 1,
  test: { clock, flags: {} },
})
await client.ready

// This page draws nothing (no renderer/canvas wiring): `engine/test.untilQuiescent` waits for
// *every* ring to reach `pushed === popped`, `uploadRing` included, and nothing else here would
// ever drain it (`terrain-client.ts`'s own precedent, docs/plan/09-renderer-terrain.md Deviations
// "Steps 5-7"). A plain interval pop-and-discard loop, not a render loop: this page only needs the
// ring kept empty, never the bytes.
const uploadDiscard = new RingConsumer(client.uploadRing)
const uploadDiscardBuf = new Uint8Array(4112)
setInterval(() => {
  for (;;) {
    if (uploadDiscard.popInto(uploadDiscardBuf, 0) < 0) break
  }
}, 16)

window.__setCamera = (x, y, tilesAcross) => setCamera(client, { x, y, tilesAcross })
window.__stepFrame = (dtMs) => stepFrame(client, dtMs)
window.__stepTick = (n) => stepTick(client, n)
window.__untilQuiescent = () => untilQuiescent(client)
window.__netCounters = (conn) => netCounters(client, conn)
window.__replicaHash = () => replicaHash(client)
window.__hostRegionHash = (conn) => hostRegionHash(client, conn)
window.__worldHash = () => worldHash(client)
window.__simCounters = () => simCounters(client)
window.__park = () => parkWorkers(client)
window.__resume = () => resumeWorkers(client)
window.__advance = async (x, y, tilesAcross, ticks) => {
  await resumeWorkers(client)
  setCamera(client, { x, y, tilesAcross })
  // 2 s: past both of `ClientCore::poll_uplink`'s own rate limits (50 ms between any two
  // batches, 1 s keepalive, 0010 "Rates") every single call, deterministically (the manual clock
  // above), so a camera change this call makes is never coalesced into the same rate-limit window
  // as the previous `__advance` call's own report.
  stepFrame(client, 2000)
  await stepTick(client, ticks)
  return netCounters(client)
}

window.__pageReady = true
