// M39d (docs/plan/39d-full-world-reconnect.md): at the default `maxPlayers` (8 = `MAX_CONNS`) a
// player whose socket died silently and who redials with its secret before the 3 s dead timer is
// admitted, superseding the old connection (0013). The harness's `connectRaw` calls the production
// `accept` directly; an adapter's `catch { close(CloseCode.Full) }` is what a throw becomes.
import { expect, test } from 'vitest'
import { CloseCode } from '../../src/host/handshake.js'
import { hexDecode } from '../../src/host/sessions.js'
import { MsgClass } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { buildHelloBytes, fixedSecret, putsFixture } from './support.js'

// Step 1 evidence test: `.fails` marks the defect as expected. Step 2 removes `.fails`.
test.fails('full-world/returning-player-supersedes', async () => {
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
    expect(CloseCode.Full).not.toBe(closeCode)
  } finally {
    await harness.dispose()
  }
})
