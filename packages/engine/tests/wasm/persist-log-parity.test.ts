// docs/plan/22-persistence-log-and-snapshots.md Exit criteria: "The native log written by step 3
// and the log written by the Node host for the same script are byte-identical
// (`log_bytes_native_equals_wasm`)." `fixtures/persist/tests/abi_log_parity.rs`'s own doc comment
// has the reasoning for why this compares against a *new* golden
// (`persist_abi_log_parity.hex`, driven through the real admit pipeline -- `Host::connect`/
// `Host::on_uplink`, both `Joined` and `Connected`) rather than step 3's own `persist_fixture_log`
// golden (built by a testkit backdoor no real `.wasm` can reach). This test drives the identical
// script through the real ABI (`sim_connect`/`sim_admit`/`sim_seal_frame`/`sim_tick`, a real
// client-role instance turning each action into real wire bytes) over the real `.wasm`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { RegionId, Role, Status } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { buildSimInstanceConfig } from '../../src/server.js'
import { loadFixture } from '../support/fixtures.js'

const CFG = {
  worldId: 'w1',
  buildHash: '00'.repeat(32),
  params: { seed: '42', worldgen: null },
}

function readGoldenHex(name: string): Uint8Array {
  const path = fileURLToPath(new URL('../../fixtures/persist/tests/golden/', import.meta.url))
  const text = readFileSync(`${path}${name}.hex`, 'utf8')
  const digits = text.replace(/\s+/g, '')
  const out = new Uint8Array(digits.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  return out
}

test('log_bytes_native_equals_wasm', async () => {
  const { wasm } = await loadFixture('persist')
  const sim = instantiate(wasm, Role.Sim, buildSimInstanceConfig(CFG))
  const encoder = instantiate(wasm, Role.Client, buildSimInstanceConfig(CFG))

  const simRxMaybe = sim.region(RegionId.Rx)
  const encoderRxMaybe = encoder.region(RegionId.Rx)
  const encoderTxMaybe = encoder.region(RegionId.Tx)
  const persistMaybe = sim.region(RegionId.Persist)
  if (!simRxMaybe || !encoderRxMaybe || !encoderTxMaybe || !persistMaybe) {
    throw new Error('a required region is missing')
  }
  // Narrowed once, above; TS does not carry that narrowing into the nested function declarations
  // below (`admit`/`sealAndTick`), so these are re-bound as definitely non-null.
  const simRx = simRxMaybe
  const encoderRx = encoderRxMaybe
  const encoderTx = encoderTxMaybe
  const persist = persistMaybe

  const jsonEncoder = new TextEncoder()
  let seq = 0

  function admit(action: unknown): void {
    seq += 1
    const json = jsonEncoder.encode(JSON.stringify(action))
    const record = new Uint8Array(8 + json.length)
    const view = new DataView(record.buffer)
    view.setUint32(0, seq, true)
    view.setUint32(4, json.length, true)
    record.set(json, 8)
    encoderRx.u8.set(record)
    const onActionStatus = encoder.call1(encoder.x.on_action, record.length)
    if (onActionStatus !== Status.Ok) throw new Error(`on_action failed: status ${onActionStatus}`)
    const uplinkLen = encoder.call1(encoder.x.client_poll_uplink, 0)
    if (uplinkLen <= 0) throw new Error('client_poll_uplink produced no uplink batch')
    simRx.u8.set(encoderTx.u8.subarray(0, uplinkLen))
    const admitStatus = sim.call2(sim.x.sim_admit, 0, uplinkLen)
    if (admitStatus !== Status.Ok) throw new Error(`sim_admit failed: status ${admitStatus}`)
  }

  const log: number[] = []
  function sealAndTick(): void {
    const len = sim.call0(sim.x.sim_seal_frame)
    if (len < 0) throw new Error(`sim_seal_frame failed: status ${-len}`)
    if (len > 0) log.push(...persist.u8.subarray(0, len))
    const status = sim.call0(sim.x.sim_tick)
    if (status !== Status.Ok) throw new Error(`sim_tick failed: status ${status}`)
  }

  const genesisStatus = sim.call0(sim.x.sim_genesis)
  if (genesisStatus !== Status.Ok) throw new Error(`sim_genesis failed: status ${genesisStatus}`)

  // `fixtures/persist/tests/abi_log_parity.rs`'s own script, replayed call for call.
  const connectStatus = sim.call1(sim.x.sim_connect, 0)
  if (connectStatus !== Status.Ok) throw new Error(`sim_connect failed: status ${connectStatus}`)
  sealAndTick() // Joined + Connected

  admit({ PlaceTimer: { at: { x: 5, y: 5 }, period: 7 } })
  sealAndTick()

  for (let i = 0; i < 3; i++) sealAndTick() // idle

  admit('Roll')
  sealAndTick()

  admit({ Harvest: { at: { x: 0, y: 0 } } })
  sealAndTick()

  admit({ Harvest: { at: { x: 0, y: 0 } } })
  sealAndTick()

  for (let i = 0; i < 5; i++) sealAndTick() // idle

  const golden = readGoldenHex('persist_abi_log_parity')
  expect(new Uint8Array(log)).toEqual(golden)
})
