// docs/plan/17-drawlist-and-sprites.md, extra ask (not in the brief's own Tests added list, per
// its delegation prompt): proves the publish end to end -- the client worker's real
// `createDrawlistPump` (`worker/client-drawlist.ts`), against a real `fx-drawables.wasm` client
// instance, copies the exact same bytes into the newest `drawList` triple-buffer slot that
// `RegionId.DrawList` itself holds right after `frame()`'s own `extract` + `sort_into` ran. Cut 2
// (steps 4-6) builds on a publish proven this way.
//
// No worker/SAB-ring plumbing needed for this: two `EngineInstance`s (sim, client) driven directly
// through their raw ABI exports, real wire bytes end to end (`sim_admit`/`sim_build_frame`/
// `on_frame`/`client_poll_uplink`, the same primitives `tests/wasm/puts.test.ts`'s own
// `host_accepts_ring_connection_and_hashes_match` drives, minus the ring in between -- a plain
// region-to-region byte copy stands in for it here, since nothing about the ring itself is under
// test).
import { expect, test } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import { CameraBlockView, createCameraBlock, writeCameraBlock } from '../../src/camera/block.js'
import { CameraState } from '../../src/camera/state.js'
import { instantiate } from '../../src/loader.js'
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../../src/sab/layout.js'
import { createTriple, TripleReader } from '../../src/sab/triple.js'
import { createDrawlistPump } from '../../src/worker/client-drawlist.js'
import { loadFixture } from '../support/fixtures.js'

const ARENA_BYTES = 32 * 1024 * 1024

function simConfig() {
  return { arenaBytes: ARENA_BYTES, game: { seed: '0x1', params: null } }
}

function clientConfig() {
  return { arenaBytes: ARENA_BYTES, game: { seed: '0x1', params: null } }
}

/** Copies `region.u8[0, len)` into `dst.u8`, whole-region `.set()` (test-only code, `.claude/
 * rules/hot-paths.md` does not apply to `tests/`). */
function copyRegion(dst: { u8: Uint8Array }, src: { u8: Uint8Array }, len: number): void {
  dst.u8.set(src.u8.subarray(0, len))
}

test('drawlist_publish_matches_the_wasm_region_byte_for_byte', async () => {
  const { wasm } = await loadFixture('drawables')
  const sim = instantiate(wasm, Role.Sim, simConfig(), { onLog() {} })
  const client = instantiate(wasm, Role.Client, clientConfig(), { onLog() {} })

  expect(sim.call0(sim.x.sim_genesis)).toBe(0) // Status.Ok
  expect(sim.call1(sim.x.sim_connect, 0)).toBe(0) // Status.Ok, conn 0 -> PlayerId(1)

  // A wide, centred camera: every one of `fx-drawables`' three fixed genesis entities falls
  // inside it (module doc comment of `fixtures/drawables/tests/drawlist_golden.rs`, this
  // milestone's own native counterpart -- same fixture, same fixed positions).
  const camSab = createCameraBlock()
  const camView = new CameraBlockView(camSab)
  const state = new CameraState()
  state.centreX = 0
  state.centreY = 0
  state.tilesAcross = 10 // below fx-drawables' own SMALL_ZOOM_THRESHOLD (32)
  state.halfExtentTilesX = 40
  state.halfExtentTilesY = 40
  writeCameraBlock(camView, state)
  const clientCameraRegion = client.region(RegionId.Camera)
  if (!clientCameraRegion) throw new Error('client instance has no Camera region')
  clientCameraRegion.u8.set(new Uint8Array(camSab))

  const clientTx = client.region(RegionId.Tx)
  const simRx = sim.region(RegionId.Rx)
  const simTx = sim.region(RegionId.Tx)
  const clientDownlink = client.region(RegionId.Downlink)
  if (!clientTx || !simRx || !simTx || !clientDownlink) {
    throw new Error('expected region missing')
  }

  // A handful of ticks: enough for the camera report to admit, the host to subscribe the chunks
  // fx-drawables' fixed entities live in, and a chunk snapshot carrying them to reach the client.
  for (let i = 0; i < 8; i++) {
    client.call1(client.x.frame, 0)
    const upLen = client.call1(client.x.client_poll_uplink, 0)
    if (upLen > 0) {
      copyRegion(simRx, clientTx, upLen)
      expect(sim.call2(sim.x.sim_admit, 0, upLen)).toBe(0)
    }
    expect(sim.call0(sim.x.sim_tick)).toBe(0)
    const downLen = sim.call1(sim.x.sim_build_frame, 0)
    if (downLen > 0) {
      copyRegion(clientDownlink, simTx, downLen)
      expect(client.call1(client.x.on_frame, downLen)).toBe(0) // Status.Ok
    }
  }

  // The real frame this test asserts over: `extract` must see every genesis entity by now.
  client.call1(client.x.frame, 0)
  const recordCount = client.call0(client.x.drawlist_len)
  expect(recordCount).toBe(3)

  const drawListRegion = client.region(RegionId.DrawList)
  if (!drawListRegion) throw new Error('client instance has no DrawList region')
  const usedBytes = DRAWLIST_HEADER_BYTES + recordCount * 32

  const drawListSab = createTriple(DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
  const pump = createDrawlistPump(client, drawListSab, drawListRegion)
  pump.publish()

  const reader = new TripleReader(drawListSab, DRAWLIST_HEADER_BYTES, DRAWLIST_BODY_BYTES)
  const slot = reader.acquire()
  expect(reader.fresh).toBe(true)
  const publishedHeader = reader.headerView(slot)
  const publishedBody = reader.bodyView(slot)

  // Byte-for-byte: the published slot's header and used body bytes must equal the WASM region's
  // own bytes at the moment of publish -- the actual thing the publish pump is for.
  expect(Array.from(publishedHeader)).toEqual(
    Array.from(drawListRegion.u8.subarray(0, DRAWLIST_HEADER_BYTES)),
  )
  expect(Array.from(publishedBody.subarray(0, usedBytes - DRAWLIST_HEADER_BYTES))).toEqual(
    Array.from(drawListRegion.u8.subarray(DRAWLIST_HEADER_BYTES, usedBytes)),
  )

  // `dropped == 0`: every genesis entity fit (Exit criteria: "drawListDropped == 0 in every test
  // except the overflow test").
  const dropped = new DataView(
    publishedHeader.buffer,
    publishedHeader.byteOffset,
    publishedHeader.byteLength,
  ).getUint32(88, true)
  expect(dropped).toBe(0)
})
