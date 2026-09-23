// docs/plan/17-drawlist-and-sprites.md: proves the publish end to end (the client worker's real
// `createDrawlistPump`, `worker/client-drawlist.ts`) *and*, per the M17 cut-1 gate ("native-vs-
// `.wasm` equality, not self-consistency"), that the real `.wasm` build's DrawList agrees with the
// native one for the same replica + camera -- the same shape `tests/wasm/puts.test.ts`'s own
// `wasm_idle_100_matches_native` uses (one committed golden file, `fixtures/drawables/tests/
// golden/drawables_hash.hash`, read by both `fixtures/drawables/tests/drawlist_golden.rs`'s own
// `drawlist_fixture_hash_golden` and this file's `drawlist_hash_matches_native_golden`).
//
// No worker/SAB-ring plumbing needed for either test: two `EngineInstance`s (sim, client) driven
// directly through their raw ABI exports, real wire bytes end to end (`sim_admit`/`sim_build_frame`/
// `on_frame`/`client_poll_uplink`, the same primitives `tests/wasm/puts.test.ts`'s own
// `host_accepts_ring_connection_and_hashes_match` drives, minus the ring in between -- a plain
// region-to-region byte copy stands in for it here, since nothing about the ring itself is under
// test).
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import { CameraBlockView, createCameraBlock, writeCameraBlock } from '../../src/camera/block.js'
import { CameraState } from '../../src/camera/state.js'
import { type EngineInstance, instantiate, type RegionView } from '../../src/loader.js'
import { DRAWLIST_BODY_BYTES, DRAWLIST_HEADER_BYTES } from '../../src/sab/layout.js'
import { createTriple, TripleReader } from '../../src/sab/triple.js'
import { hashDrawListFields } from '../../src/test/client.js'
import { createDrawlistPump } from '../../src/worker/client-drawlist.js'
import { fixtureDir, loadFixture } from '../support/fixtures.js'

const ARENA_BYTES = 32 * 1024 * 1024

// Matches `fixtures/drawables/tests/drawlist_golden.rs`'s own `GAME_CFG` exactly (the seed does
// not actually change `fx-drawables`' own output -- genesis spawns fixed entities regardless, and
// every tile is `VOID` regardless of seed -- but keeping it literally identical removes one more
// thing a reader would otherwise have to reason "doesn't matter" about).
function gameConfig() {
  return { arenaBytes: ARENA_BYTES, game: { seed: '0x1234567890abcdef', params: null } }
}

/** Copies `region.u8[0, len)` into `dst.u8`, whole-region `.set()` (test-only code, `.claude/
 * rules/hot-paths.md` does not apply to `tests/`). */
function copyRegion(dst: { u8: Uint8Array }, src: { u8: Uint8Array }, len: number): void {
  dst.u8.set(src.u8.subarray(0, len))
}

/** The exact camera `fixtures/drawables/tests/drawlist_golden.rs`'s own `shared_camera()` builds:
 * centre `(0, 0)`, `tilesAcross` 10 (below `fx-drawables`' own `SMALL_ZOOM_THRESHOLD`, 32), half
 * extent `(40, 40)`, no cursor. `centreX`/`tilesAcross` are the two knobs the gate's own example
 * names (a different centre changes `window_origin`'s snap; a different `tilesAcross` changes
 * `zoom()`) -- see "Verified: a perturbation goes red" in Deviations for the one actually tried.
 */
function writeSharedCamera(client: EngineInstance): void {
  const camSab = createCameraBlock()
  const camView = new CameraBlockView(camSab)
  const state = new CameraState()
  state.centreX = 0
  state.centreY = 0
  state.tilesAcross = 10
  state.halfExtentTilesX = 40
  state.halfExtentTilesY = 40
  writeCameraBlock(camView, state)
  const clientCameraRegion = client.region(RegionId.Camera)
  if (!clientCameraRegion) throw new Error('client instance has no Camera region')
  clientCameraRegion.u8.set(new Uint8Array(camSab))
}

/** Drives sim + client through 8 real ticks with the shared camera (module doc comment): enough
 * for the camera report to admit, the host to subscribe the chunks `fx-drawables`' fixed entities
 * live in, and a chunk snapshot carrying them to reach the client -- then one final `frame()`, the
 * real frame both this file's tests assert over. Returns the client, its own `RegionId.DrawList`
 * region and the record count `frame()` last produced. */
function driveFixedScenario(wasm: WebAssembly.Module): {
  client: EngineInstance
  drawListRegion: RegionView
  recordCount: number
} {
  const sim = instantiate(wasm, Role.Sim, gameConfig(), { onLog() {} })
  const client = instantiate(wasm, Role.Client, gameConfig(), { onLog() {} })

  expect(sim.call0(sim.x.sim_genesis)).toBe(0) // Status.Ok
  expect(sim.call1(sim.x.sim_connect, 0)).toBe(0) // Status.Ok, conn 0 -> PlayerId(1)
  writeSharedCamera(client)

  const clientTx = client.region(RegionId.Tx)
  const simRx = sim.region(RegionId.Rx)
  const simTx = sim.region(RegionId.Tx)
  const clientDownlink = client.region(RegionId.Downlink)
  if (!clientTx || !simRx || !simTx || !clientDownlink) {
    throw new Error('expected region missing')
  }

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

  client.call1(client.x.frame, 0)
  const recordCount = client.call0(client.x.drawlist_len)
  const drawListRegion = client.region(RegionId.DrawList)
  if (!drawListRegion) throw new Error('client instance has no DrawList region')
  return { client, drawListRegion, recordCount }
}

test('drawlist_publish_matches_the_wasm_region_byte_for_byte', async () => {
  const { wasm } = await loadFixture('drawables')
  const { client, drawListRegion, recordCount } = driveFixedScenario(wasm)
  expect(recordCount).toBe(3)
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

/** M17 cut-1 gate: "native-vs-`.wasm` equality, not self-consistency". Drives the real `.wasm`
 * through the identical fixed scenario `fixtures/drawables/tests/drawlist_golden.rs`'s own
 * `drive_real_game_instance` drives natively, hashes the result with the exact same field
 * selection (`hashDrawListFields`/`hash_region` both skip `frame_seq`/`frame_time_ms`, Deviations),
 * and compares against the one golden file both sides read -- proving the `.wasm` build's
 * `extract`/`sort_into`/window-origin/visible-rect path has not diverged from native. */
test('drawlist_hash_matches_native_golden', async () => {
  const { wasm } = await loadFixture('drawables')
  const { drawListRegion, recordCount } = driveFixedScenario(wasm)
  expect(recordCount).toBe(3)

  const header = drawListRegion.u8.subarray(0, DRAWLIST_HEADER_BYTES)
  const body = drawListRegion.u8.subarray(DRAWLIST_HEADER_BYTES)
  const hash = hashDrawListFields(header, body, recordCount)

  const goldenPath = `${fixtureDir('drawables')}/tests/golden/drawables_hash.hash`
  const golden = readFileSync(goldenPath, 'utf8').trim()
  expect(hash).toBe(golden)
})
