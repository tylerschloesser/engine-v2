// `epoch`/`resync` (M28b step 2, Tests added): coverage for the
// mechanism steps 1-2 land -- `SimHost.epoch`/`bumpEpoch()`/`resyncAll()`, `ManifestV1.epoch`
// load/write-back on a real restart (`harness.restartServer()`), and the client side of a second
// `Welcome` on an already-`Online` connection (`session_state` cycling through `Resyncing`, the
// replica surviving intact). The full reconnect scenarios (`reconnect/host-restart-epoch`,
// `reconnect/panic-recovery-resync`, pending-action resend, `Lost`) are steps 3-4's own Tests added
// (Non-scope here) -- these two only prove the seams this cut actually builds.
import { expect, test } from 'vitest'
import { SessionState } from '../../src/clock-block.js'
import { serverInternals, worldServerTestHandle } from '../../src/server.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

test('epoch/host-restart-bumps-epoch', async () => {
  const seed = 2001
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(5)

    expect(worldServerTestHandle(harness.server).epoch).toBe(0)
    expect(serverInternals(harness.server).isTicking).toBe(true)

    // A clean restart: `server.stop()` (snapshot + flush) then a fresh `createWorldServer` over the
    // same storage -- 0013 "`epoch` increments at every host start" for anything but a brand-new
    // world, so loading this now-existing manifest back bumps it once.
    await harness.restartServer()
    expect(worldServerTestHandle(harness.server).epoch).toBe(1)
    expect(serverInternals(harness.server).isTicking).toBe(true)

    // A second restart, this time simulating a crash (no clean `stop()`, a `crashClone`d storage):
    // still exactly one bump, the same "every host start" rule, not "every clean one".
    await harness.restartServer({ crash: true })
    expect(worldServerTestHandle(harness.server).epoch).toBe(2)
  } finally {
    await harness.dispose()
  }
})

test('resync/resyncAll-cycles-session-state-and-replica-still-converges', async () => {
  const seed = 2002
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(5)
    harness.clients[0]?.dispatch({ Paint: { pos: { x: 2, y: 2 }, base: 1, resource: 0 } })
    await harness.settle()
    harness.assertConverged()

    const simHost = worldServerTestHandle(harness.server)
    // What a successful `SimHost.recover()`/an upgrade bump does on its own (`onRecovered`'s own
    // default wiring, `server.ts`): bump the epoch, then resync every open connection with it.
    simHost.bumpEpoch()
    simHost.resyncAll()
    expect(simHost.epoch).toBe(1)

    // One pump is enough for a `HeadlessClient` to see the second `Welcome`, apply it (dropping and
    // then, over the next ticks, rebuilding its held-chunk set) and land back on `Online`.
    harness.clients[0]?.pump()
    await harness.settle()

    const status = harness.clients[0]?.status()
    expect(status?.live).toBe(true)
    expect(status?.sessionState).toBe(SessionState.Online)
    // The real proof the replica was rebuilt correctly, not merely left stale: it still matches the
    // host's own live `region_hash` at this (now later, `Global.day` having kept advancing) tick --
    // `reset_for_resync` dropped every held chunk, and the ordinary re-enter/snapshot path (the
    // host's own `resync()` having reset that connection's subscription bookkeeping too) rebuilt
    // them from scratch.
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})
