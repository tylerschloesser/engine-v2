// M25 Tests added, WASM-under-Node suite: `predict_not_predictable_
// event` -- dispatch at the subscription edge yields `NotPredictable` then `Confirmed` from
// `onActionResult`, driven from a real `.wasm` host (sim role) and a real `.wasm` client (client
// role), not a stub. No `createClient()` here (that needs real `Worker`s and a canvas, browser
// only): two raw `EngineInstance`s of the same module, wired by hand the way `runScriptScenario`
// (`tests/support/scenario.ts`) already wires a sim + an "encoder" -- except this client is a full
// round trip (also `on_frame`/`client_poll_ui`, which `runScriptScenario`'s own encoder never
// calls) and needs a real camera report to establish a subscription before dispatching, since the
// whole point of this scenario is a chunk *outside* it.
import { expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import type { EngineInstance } from '../../src/loader.js'
import { instantiate } from '../../src/loader.js'
import { loadFixture } from '../support/fixtures.js'

function ok(status: number, what: string): void {
  if (status !== Status.Ok) throw new Error(`${what}: status ${status}`)
}

function gameConfig(cacheChunks: number) {
  return {
    arenaBytes: 64 * 1024 * 1024,
    game: {
      seed: '0x1',
      params: null,
      maxEntities: 4096,
      maxModifiedTiles: 4096,
      maxActionGrowth: 4096,
      cacheChunks,
    },
  }
}

/** `client::camera::CameraBlock`'s own 80-byte layout, byte for byte (`camera/block.ts`'s
 * `CAM_OFF_*`; `client/camera.rs`'s own doc comment: "byte-for-byte the same 80 bytes"). Written
 * directly into the client instance's own `Camera` region -- there is no SAB/worker in this test,
 * so nothing else would ever write it. */
function writeCameraRegion(client: EngineInstance, centerX: number, centerY: number): void {
  const region = client.region(RegionId.Camera)
  if (!region) throw new Error('predict.test: client Camera region is missing')
  const view = new DataView(region.u8.buffer, region.u8.byteOffset, region.u8.byteLength)
  view.setInt32(0, 1, true) // seq (unused by CameraBlock's own read)
  view.setUint32(4, 0, true) // cursor_valid
  view.setFloat64(8, centerX, true)
  view.setFloat64(16, centerY, true)
  view.setFloat64(24, 0, true) // frame_time_ms
  view.setFloat32(32, 0, true) // velocity.x
  view.setFloat32(36, 0, true) // velocity.y
  view.setFloat32(40, 0, true) // tiles_across
  view.setFloat32(44, 0, true) // zoom_rate
  view.setFloat32(48, 1, true) // half_extent_tiles.x
  view.setFloat32(52, 1, true) // half_extent_tiles.y
  view.setFloat32(56, 1, true) // dpr
  view.setUint32(60, 0, true) // reserved0
  view.setInt32(64, 0, true) // cursor_tile.x
  view.setInt32(68, 0, true) // cursor_tile.y
  view.setFloat32(72, 0, true) // viewport_px.x
  view.setFloat32(76, 0, true) // viewport_px.y
}

/** Flushes whatever the client's own uplink has due (a camera report and/or a queued action) to
 * the sim, admitting it into the *next* `sim_tick`'s own batch (0004 host arrival order). A no-op
 * (returns `false`) when nothing is due yet. */
function flushUplink(sim: EngineInstance, client: EngineInstance, tMs: number): boolean {
  const len = client.call1(client.x.client_poll_uplink, tMs)
  if (len <= 0) return false
  const simRx = sim.region(RegionId.Rx)
  const clientTx = client.region(RegionId.Tx)
  if (!simRx || !clientTx) throw new Error('predict.test: Rx/Tx region missing')
  simRx.u8.set(clientTx.u8.subarray(0, len))
  ok(sim.call2(sim.x.sim_admit, 0, len), 'sim_admit')
  return true
}

/** One host tick, delivered to the client immediately (delay 0: this test drives both instances
 * by hand, one step at a time, so there is no queue to model). */
function tickAndDeliver(sim: EngineInstance, client: EngineInstance): void {
  ok(sim.call0(sim.x.sim_tick), 'sim_tick')
  const len = sim.call1(sim.x.sim_build_frame, 0)
  if (len <= 0) return
  const simTx = sim.region(RegionId.Tx)
  const clientDown = client.region(RegionId.Downlink)
  if (!simTx || !clientDown) throw new Error('predict.test: Tx/Downlink region missing')
  clientDown.u8.set(simTx.u8.subarray(0, len))
  ok(client.call1(client.x.on_frame, len), 'on_frame')
}

/** Every kind-2 (`ActionResults`) UI-ring record `client_poll_ui` has due right now, decoded
 * (`onActionResult`'s own production JSON, `game_instance::push_result_record`/
 * `push_not_predictable_record`): `{ seq, result }` pairs, oldest first. */
function drainActionResults(client: EngineInstance): Array<{ seq: number; result: unknown }> {
  const out: Array<{ seq: number; result: unknown }> = []
  const uiRegion = client.region(RegionId.Ui)
  if (!uiRegion) throw new Error('predict.test: client Ui region is missing')
  const decoder = new TextDecoder()
  for (;;) {
    const len = client.call0(client.x.client_poll_ui)
    if (len <= 0) break
    let consumed = 0
    while (consumed + 5 <= len) {
      const kind = uiRegion.u8[consumed]
      const bodyLen = new DataView(
        uiRegion.u8.buffer,
        uiRegion.u8.byteOffset + consumed + 1,
        4,
      ).getUint32(0, true)
      const bodyStart = consumed + 5
      const bodyEnd = bodyStart + bodyLen
      if (kind === 2) {
        const json = decoder.decode(uiRegion.u8.subarray(bodyStart, bodyEnd))
        const parsed = JSON.parse(json) as { seq: number; result: unknown }
        out.push(parsed)
      }
      consumed = bodyEnd
    }
  }
  return out
}

function placeAction(seq: number, x: number, y: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ Place: { origin: { x, y } } }))
  const record = new Uint8Array(8 + json.length)
  const view = new DataView(record.buffer)
  view.setUint32(0, seq, true)
  view.setUint32(4, json.length, true)
  record.set(json, 8)
  return record
}

test('predict_not_predictable_event', async () => {
  const { wasm } = await loadFixture('predict')
  const sim = instantiate(wasm, Role.Sim, gameConfig(1024), { onLog() {} })
  const client = instantiate(wasm, Role.Client, gameConfig(1024), { onLog() {} })

  ok(sim.call0(sim.x.sim_genesis), 'sim_genesis')
  // `Host::connect` assigns `PlayerId(conn + 1)`; `ClientInstance::init` hardcodes `PlayerId(1)`
  // (game_instance.rs: "own_player is PlayerId(1) unconditionally") -- conn 0 lines the two up
  // with no handshake, the same convention `runScriptScenario` relies on.
  ok(sim.call1(sim.x.sim_connect, 0), 'sim_connect')

  // Camera centred in chunk (0,0): ring1 subscribes chunk (1,0) (tile 63 is in it) but not chunk
  // (2,0) (tile 64), the same edge `fixtures/predict/tests/loopback.rs`'s own `BORDER_ORIGIN`
  // tests use natively.
  writeCameraRegion(client, 10, 10)
  ok(client.call1(client.x.frame, 0), 'frame')
  flushUplink(sim, client, 0)
  for (let i = 0; i < 6; i++) tickAndDeliver(sim, client)

  const borderX = 63
  const borderY = 5
  const record = placeAction(1, borderX, borderY)
  const rx = client.region(RegionId.Rx)
  if (!rx) throw new Error('predict.test: client Rx region is missing')
  rx.u8.set(record)
  ok(client.call1(client.x.on_action, record.length), 'on_action')

  // `NotPredictable` at dispatch (0003): pushed synchronously by `Instance::on_action` itself
  // (`game_instance.rs` step 7), before any frame ever crosses the wire for this seq.
  const results = drainActionResults(client)
  expect(results).toEqual([{ seq: 1, result: 'NotPredictable' }])

  // The host holds the whole world: it accepts the placement for real. Deliver ticks until the
  // ack (`Confirmed`) arrives.
  let confirmed: unknown = null
  for (let i = 0; i < 10 && confirmed === null; i++) {
    flushUplink(sim, client, 50 * (i + 1))
    tickAndDeliver(sim, client)
    for (const r of drainActionResults(client)) {
      if (r.seq === 1) confirmed = r.result
    }
  }
  expect(confirmed).toBe('Confirmed')
})
