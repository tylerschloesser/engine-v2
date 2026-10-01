// docs/plan/37-robustness-events.md steps 1 and 3, Tests added (`netcode`): a trapped client
// instance resyncs (0014 §6, client role), and a world that cannot continue reports `onFatal`
// (0005 Panic recovery 4; 0024 §5), stops, closes its sockets and touches no file.
import { expect, test } from 'vitest'
import { SessionState } from '../../src/clock-block.js'
import { serverInternals } from '../../src/server.js'
import type { Storage } from '../../src/storage/types.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { loadFixture } from '../support/fixtures.js'
import { putsFixture, square } from './support.js'

async function dumpStorage(storage: Storage): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of await storage.list('')) {
    const bytes = await storage.read(key)
    out[key] = bytes ? Buffer.from(bytes).toString('hex') : ''
  }
  return out
}

test('trap: headless client resyncs', async () => {
  const seed = 3701
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.advanceTicks(5)
    client.dispatch({ Paint: { pos: { x: 2, y: 2 }, base: 1, resource: 0 } })
    await harness.settle()
    harness.assertConverged()
    const playerBefore = client.status().ownPlayerId

    // An action dispatched but not yet sent when the instance dies: the new instance cannot resolve
    // it, so it is reported `Lost` (M28b), never silently dropped.
    const results: [number, unknown][] = []
    client.onActionResult((seq, result) => {
      results.push([seq, result])
    })
    const pendingSeq = client.dispatch({ Paint: { pos: { x: 3, y: 3 }, base: 1, resource: 0 } })
    client.injectTrap()
    await harness.advanceTicks(2)
    expect(client.trapCount()).toBe(1)
    expect(results).toContainEqual([pendingSeq, 'Lost'])
    // Between the trap and the new `Welcome` nothing can be dispatched.
    expect(() => client.dispatch({ Paint: { pos: { x: 4, y: 4 }, base: 1, resource: 0 } })).toThrow(
      /before ready/,
    )

    await harness.settle()
    expect(client.status().sessionState).toBe(SessionState.Online)
    expect(client.status().ownPlayerId).toBe(playerBefore)
    // The fresh replica is rebuilt from the host: it matches the host's view of this connection.
    harness.assertConverged()
    // And the session works again.
    client.dispatch({ Paint: { pos: { x: 5, y: 5 }, base: 1, resource: 0 } })
    await harness.settle()
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('fatal: server onFatal stops world and closes sockets', async () => {
  const seed = 3702
  let fatal: { tick: number; message: string } | undefined
  const harness = await createNetHarness({
    fixture: await loadFixture('panicky'),
    seed,
    clients: 1,
    hashAll: false,
    onFatal: (f) => {
      fatal = f
    },
  })
  try {
    const client = harness.clients[0]
    if (!client) throw new Error('no client')
    client.setCamera(square(0))
    await harness.advanceTicks(3)
    expect(serverInternals(harness.server).isTicking).toBe(true)
    const upBefore = client.status().linkUpCount

    // Arms a panic in `Game::tick`. It is deterministic, so every recovery (reload, replay) leads
    // straight back to it: after `RECOVERY_LOOP_LIMIT` recoveries the host stops trying (0005 Panic
    // recovery 3-4: the world is wedged under this build). `filesBefore` is read before the last
    // attempt, which is the one that must not write.
    client.dispatch({ ArmTickPanic: { at: harness.hostTick() + 3 } })
    let filesBefore: Record<string, string> = {}
    for (let cycle = 0; cycle < 8 && fatal === undefined; cycle++) {
      let trapped = false
      for (let i = 0; i < 12 && !trapped; i++) {
        try {
          await harness.advanceTicks(1)
        } catch {
          trapped = true
        }
      }
      expect(trapped).toBe(true)
      filesBefore = await dumpStorage(harness.storage)
      await harness.panicServer()
    }

    expect(fatal).toBeDefined()
    expect(fatal?.message.length ?? 0).toBeGreaterThan(0)
    expect(serverInternals(harness.server).isTicking).toBe(false)
    // Sockets close: the client's own link sees the close and redials (the ordinary reconnect policy
    // of 0013 takes it from there, so a fixed deploy is picked up by the version-mismatch path).
    await harness.advanceTicks(3)
    expect(client.status().linkUpCount).toBeGreaterThan(upBefore)
    // No file touched, by `recover()` or by the `stop()` the fatal path calls.
    expect(await dumpStorage(harness.storage)).toEqual(filesBefore)
    await harness.server.stop()
    expect(await dumpStorage(harness.storage)).toEqual(filesBefore)
  } finally {
    await harness.dispose()
  }
})
