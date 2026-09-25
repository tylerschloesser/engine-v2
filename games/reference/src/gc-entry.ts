// `gc.html`'s script (docs/plan/20b-reference-player-and-collect-ui.md, zero-allocation exit
// criterion; `gc-test` skill "Production-topology pages", `gc-terrain.ts`'s own precedent): a real
// `startGame` topology -- the exact device/renderer/collectUi/inventoryUi wiring `main.ts`/
// `test-entry.ts` share -- driven through `asHarness` instead of a real frame loop, with two collect
// buttons mounted and the camera panning, for 600 stepped frames (0016 §3). Proves `RefClient::
// ui()`/`extract`, and the client worker's own ABI glue calling them every frame, allocate nothing.
//
// **Never imported by `main.ts`/`test-entry.ts`.** A separate entry, same reason `test-entry.ts`
// already is: this page sets `ClientOptions.test` and never ships to a player.
import { createUploadDrain, RingConsumer, type UploadDrain } from 'engine/render'
import {
  asHarness,
  createManualClock,
  installGcPage,
  parkWorkers,
  pumpUntilLive,
  stepFrame,
  stepSimTickSync,
} from 'engine/test'
import { startGame } from './game.js'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement
const clock = createManualClock()

const { client, renderer, device, canvasFormat } = await startGame({
  canvas,
  host: {
    kind: 'local',
    world: { worldId: 'reference', params: { seed: '6840143426475589698', worldgen: {} } },
    connect: true,
  },
  test: { clock, flags: { gcHook: true } },
  clock,
  scheduler: clock,
})

// `pumpUntilLive`, not a bare `await client.ready` (`test-entry.ts`'s own reasoning: a
// `connect: true` topology's own `client.ready` also waits for a real host frame).
await pumpUntilLive(client)

const harness = asHarness(client)

// The iron and stone landmarks near the origin (`tests/fixtures/landmarks.json`, `TEST_SEED`: iron
// at `(0, 0)`, stone at `(-1, 2)`): both stay inside `RANGE` (3 tiles) of every camera position this
// page ever takes (the oscillation below never exceeds 0.3 tiles of amplitude, all on the x axis),
// so exactly two collect buttons stay mounted for the whole run.
const CENTRE_X = 0
const CENTRE_Y = 0
client.cameraState.centreX = CENTRE_X
client.cameraState.centreY = CENTRE_Y
client.cameraState.tilesAcross = 20
// Found live (`gc-terrain.ts`'s own precedent, same reasoning): this page drives `cameraState`
// directly, never through `client.camera.tick()` (the real integrator, which writes this from the
// real canvas viewport every rAF) -- `halfExtentTilesX/Y` default to `0` (`CameraState`'s own
// field default), which means "nothing is ever in view" for chunk subscription/downlink purposes
// regardless of `centreX/Y`, however many ticks run. Set once, directly, matching `tilesAcross`.
client.cameraState.halfExtentTilesX = 15
client.cameraState.halfExtentTilesY = 15

const uploadConsumer = new RingConsumer(client.uploadRing)
const uploadDrain: UploadDrain = createUploadDrain(uploadConsumer, renderer)
const target = device.device.createTexture({
  label: 'gc-reference-target',
  size: [64, 64],
  format: canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64
renderer.frameUniform.tilesPerPx = client.cameraState.tilesAcross / 64

// Found live (this cut's own gap, no existing zero-GC page drives `onUi`): neither `test.scheduler`
// nor `startGame`'s own `scheduler` param is the manual clock here (matching every existing page's
// own precedent, `test-entry.ts` included), so `client.onUi`'s own drain (`client.ts`'s
// `resultsFrame`, `scheduler.requestFrame`) runs on the *real* browser rAF, not on `stepFrame`'s
// advance -- harmless on every page that only ever awaits between individual `stepFrame` calls
// (real IPC round trips give rAF room to fire), fatal to a fully synchronous priming loop, which a
// zero-GC page's own setup otherwise would be. A real `requestAnimationFrame` await between steps,
// here only (never inside `drive()`, which must stay synchronous), gives that drain the room it
// needs to actually mount the collect buttons before the measured run starts.
function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

// Found live: `game.ts`'s own shared spawn-follow `onUi` subscription (M20b step 5) fires once, on
// this page like any other, and its own `client.camera.moveTo` overwrites `cameraState.centreX/Y`
// back to the spawn tile the moment it runs -- which lands somewhere inside this very priming loop
// (the `requestAnimationFrame` yields below are exactly what let its own `onUi` delivery arrive).
// Re-asserting the real target every iteration costs nothing outside the measured window and
// defeats it deterministically, whichever iteration it lands on.
function pinCamera(): void {
  client.cameraState.centreX = CENTRE_X
  client.cameraState.centreY = CENTRE_Y
}

// Found live: `untilQuiescent` (inside `stepTick` below) waits for every ring, `uploadRing`
// included, to reach `pushed === popped` -- undrained upload records left over from an earlier
// `stepFrame` call make it spin for its own full timeout even though the client is keeping up fine
// (`test-entry.ts`'s own `drainUploadsFully`, verbatim, is the fix: drain to empty, not once).
function drainUploadsFully(): void {
  for (;;) {
    const { records } = uploadDrain.drain(1_000_000)
    if (records === 0) break
  }
}

// Priming, outside the measured window: enough ticks/frames for the host to have downlinked both
// landmark tiles into the client's own replica and for the collect buttons to actually be mounted
// before `installGcPage`'s own warmup starts (`games/reference/CLAUDE.md`: `Ui.in_range` needs a
// real sim tick, not just `stepFrame`; `ui-smoke.spec.ts`'s own precedent for the counts).
//
// **Found live, this cut's own gap: `engine/test.stepTick` (the free function, `stepSimTickSync` +
// `untilQuiescent`) deadlocks the client worker the first time it is called after a run of plain
// `stepFrame` calls on this exact topology** (`host: { kind: 'local', connect: true }` driven by
// `asHarness`/a manual clock with no real frame loop -- a combination no existing zero-GC page
// exercises: `gc-topology.ts` never sets `connect: true`, `gc-terrain.ts`'s host has no `Sim` role
// at all). Reproduced with `client`'s own `W_ACK` frozen at its last real `stepFrame` ack while
// `W_WAKE` kept climbing from the sim's own downlink-ring pushes -- `untilQuiescent`'s own ring-
// quiescence wait never resolves. `stepSimTickSync` alone (no `untilQuiescent`), followed by this
// page's own `drainUploadsFully`, ticks the sim and reaches the same live state without it -- a
// workaround, not a fix to the underlying engine gap, which is out of this milestone's own Files
// touched (`packages/engine/src/test/**` beyond the barrel-export additions already justified as
// bug fixes elsewhere in this cut).
for (let i = 0; i < 20; i++) {
  pinCamera()
  stepFrame(client, 50)
  drainUploadsFully()
  await nextAnimationFrame()
}
stepSimTickSync(client, 5)
drainUploadsFully()
for (let i = 0; i < 10; i++) {
  pinCamera()
  stepFrame(client, 50)
  drainUploadsFully()
  await nextAnimationFrame()
}

// A production worker enters its blocking loop right after `ready`, and stays running (not
// parked) through every priming call above: park only now, right before `__pageReady`, so CDP can
// reach every worker the instant the test attaches (`packages/engine/CLAUDE.md`, `gc-topology.ts`/
// `gc-terrain.ts`'s own precedent) -- `installGcPage`'s own `run()` resumes them again through the
// normal `yield` protocol.
await parkWorkers(client)

// Small, bounded oscillation (`Math.sin`, no allocation): enough real camera motion to exercise
// `extract`/overlay-anchor code every frame without ever panning either landmark tile out of `RANGE`.
const PAN_AMPLITUDE_TILES = 0.3
const PAN_PERIOD_FRAMES = 120

function drive(f: number): void {
  const cx = CENTRE_X + PAN_AMPLITUDE_TILES * Math.sin((2 * Math.PI * f) / PAN_PERIOD_FRAMES)
  client.cameraState.centreX = cx
  const camTileX = Math.floor(cx)
  const camTileY = Math.floor(CENTRE_Y)
  const fu = renderer.frameUniform
  fu.camTileX = camTileX
  fu.camTileY = camTileY
  fu.camFracX = cx - camTileX
  fu.camFracY = CENTRE_Y - camTileY

  harness.stepFrame(1000 / 60)
  harness.stepTick()
  uploadDrain.drain(1_000_000)
  renderer.writeFrameUniform(fu)
  renderer.draw(target)
  // M18 Deviations ("client.overlay.anchor's per-frame refresh is not called automatically by
  // frame-loop.ts"): called directly here, the same reason `test-entry.ts`'s own `__stepFrame` does
  // (this page's own `real.loop` never ticks either, same manual-clock topology).
  client.overlay.update()
}

installGcPage(harness, {
  adapter: device.adapterInfo,
  drive,
})

window.__pageReady = true
