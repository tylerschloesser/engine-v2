// M39d ( at the default `maxPlayers` (8 = `MAX_CONNS`) a
// player whose socket died silently and who redials with its secret before the 3 s dead timer is
// admitted, superseding the old connection (0013). The harness's `connectRaw` calls the production
// `accept` directly; an adapter's `catch { close(CloseCode.Full) }` is what a throw becomes.
import { expect, test } from 'vitest'
import { buildReject, CloseCode, RejectReason } from '../../src/host/handshake.js'
import { hexDecode } from '../../src/host/sessions.js'
import { MsgClass } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { buildHelloBytes, fixedSecret, putsFixture } from './support.js'

test('full-world/returning-player-supersedes', async () => {
  const fixture = await putsFixture()
  const secrets = Array.from({ length: 8 }, (_, i) => fixedSecret(0x40 + i))
  const harness = await createNetHarness({ fixture, seed: 3900, clients: 8, secrets })
  try {
    await harness.settle()
    harness.link(0).stall(60_000) // silent death: nothing arrives either way, no close
    await harness.advanceTicks(2)
    const conn = harness.connectRaw() // same path an adapter uses; throws when no slot (adapter closes Full)
    let closeCode: number | undefined
    let welcome = false
    conn.onMessage = (b) => {
      if (b[0] === 0x03) welcome = true
    }
    conn.onClose = (c) => {
      closeCode = c
    }
    conn.send(
      MsgClass.ReliableOrdered,
      buildHelloBytes(fixture.wasm, {
        secret: secrets[0] as Uint8Array,
        joinKey: '',
        buildHash: hexDecode(fixture.buildHash),
      }),
    )
    await harness.advanceTicks(10) // 0.5 s at 20 Hz, well under the 3 s dead timer
    expect(closeCode).toBeUndefined()
    expect(welcome).toBe(true)
    // The other seven are untouched; the old, stalled connection was superseded, not added to.
    expect(harness.clients.slice(1).every((c) => c.status().live)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test('full-world/ninth-player-gets-reject-full', async () => {
  const fixture = await putsFixture()
  const secrets = Array.from({ length: 8 }, (_, i) => fixedSecret(0x40 + i))
  const harness = await createNetHarness({ fixture, seed: 3901, clients: 8, secrets })
  try {
    await harness.settle()
    const conn = harness.connectRaw()
    const frames: Uint8Array[] = []
    let closeCode: number | undefined
    conn.onMessage = (b) => {
      frames.push(b.slice())
    }
    conn.onClose = (c) => {
      closeCode = c
    }
    conn.send(
      MsgClass.ReliableOrdered,
      buildHelloBytes(fixture.wasm, {
        secret: fixedSecret(0x77), // a ninth distinct secret
        joinKey: '',
        buildHash: hexDecode(fixture.buildHash),
      }),
    )
    await harness.advanceTicks(10)
    expect(frames.length, 'one Reject frame, then the close').toBe(1)
    expect(Array.from(frames[0] as Uint8Array)).toEqual(
      Array.from(buildReject(RejectReason.Full, hexDecode(fixture.buildHash))),
    )
    expect(closeCode).toBe(CloseCode.Full)
    expect(harness.clients.every((c) => c.status().live)).toBe(true)
  } finally {
    await harness.dispose()
  }
})

test('full-world/max-players-above-half-the-slots-is-rejected', async () => {
  const fixture = await putsFixture()
  await expect(
    createNetHarness({ fixture, seed: 3902, clients: 0, world: { maxPlayers: 9 } }),
  ).rejects.toThrow(/maxPlayers 9 is out of range/)
})
