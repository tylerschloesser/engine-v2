// `gc-gen.html`'s script (docs/plan/08b-gen-workers-and-queue.md, Tests added, `gen: zero-GC over a
// scripted pan`): a real `createClient()` over `fx-worldgen`, `host: { kind: 'remote', ... }` (no
// `Sim` role), driven by `asHarness`'s `stepFrame`/`stepTick` the same way `gc-topology.ts` does --
// except the camera pans a little every frame, so the generation queue keeps finding fresh work for
// the whole measured window instead of idling once the initial view is filled. Named `gc-gen`, not
// `gen.html` (already the imperative debug API `gen.spec.ts` owns): matches M06b's own `topology
// .html`/`gc-topology.html` split (a zero-GC page auto-creates its client at load, which would spawn
// extra, uncounted workers under the debug page's own explicit `__genCreateClient()` count).
import { clientTestHandle, createClient } from '../../../../src/client.ts'
import { asHarness, parkWorkers } from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const wasm = await fixtureWasm('worldgen')
const GAME = { seed: '0x00c0ffee5eed1234', params: {}, genWorkers: 1 }
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  host: { kind: 'remote', url: 'ws://unused.invalid' },
  genWorkers: 1,
  test: { clock, game: GAME, flags: { gcHook: true } },
})
await client.ready
// A production worker enters its blocking loop right after `ready` (unlike the M03/M04 harness,
// which starts idle): park every worker before `__pageReady` so CDP can reach them the moment the
// test attaches (packages/engine/CLAUDE.md, "call `parkWorkers` before any CDP call into a
// worker"; same reasoning as `gc-topology.ts`/`gc-echo.ts`).
const harness = asHarness(client)
await parkWorkers(client)

const { cameraState } = clientTestHandle(client)
cameraState.centreX = 32
cameraState.centreY = 32
cameraState.halfExtentTilesX = 16
cameraState.halfExtentTilesY = 16
// ~8 tiles/second at 60 fps: enough to cross a chunk boundary every few seconds, so the queue keeps
// finding fresh work for the whole measured window (warm-up included) rather than idling once the
// initial view is filled -- the "scripted pan" the test name and Tests added both name. `gen0`'s
// own reliable, every-frame wake (for the burst/object negative control's sake, not just real
// dispatch traffic) comes from `harness.stepTick()` below, not from panning faster.
const PAN_TILES_PER_SECOND = 8
const PAN_TILES_PER_FRAME = PAN_TILES_PER_SECOND / 60
// Plain tiles/second, the camera block's own f32 unit (`camera/state.ts`): `TerrainFeed::on_frame`
// converts this to Q24.8 itself (`client/terrain_feed.rs`), not this page.
cameraState.velocityX = PAN_TILES_PER_SECOND

installGcPage(harness, {
  // `harness.stepTick()` still runs every frame (unlike its own doc comment's original reasoning --
  // "they have no ring traffic of their own to synchronise on before M13/M08b" -- gen0 now does):
  // it is what gives `gen0` a *reliable, every-frame* wake regardless of how often the pan below
  // actually dispatches real work, which the burst/object negative control needs to accumulate
  // enough allocation, close enough together, to trigger a real V8 scavenge within the window. A
  // real dispatch wake (`genRequest`/`genResult` commit) can race this synthetic one and coalesce
  // into one body() call; `stepTick`'s own poll now tolerates that (`test/client.ts`, Deviations:
  // "< want, not !== want") instead of hanging on the exact match it can no longer expect.
  drive() {
    cameraState.centreX += PAN_TILES_PER_FRAME
    harness.stepFrame(1000 / 60)
    harness.stepTick()
  },
})

window.__pageReady = true
