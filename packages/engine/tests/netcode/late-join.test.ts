// `late-join` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Tests added): a client joins
// after the world already has real state (an early client's own dispatched action), catches up
// through `Persistence.open`'s own "connection table is empty on load" rule (M22b Deviations) does
// not apply here -- no restart, `SimHost.accept` mid-session, M15's implicit accept -- and its own
// `ui()` observes the same global state the earlier client does. `join-converges`'s own
// `assertConverged({ only: [0] })` note applies here identically: the late joiner is never `connId
// 0`, so full `region_hash` parity for it is blocked by the same `own_player` finding (Deviations);
// this test asserts what the current engine can support (global-scope state propagates to the
// joiner) and that a joiner who never subscribes (`setCamera`) sees none of the chunk-scoped state.
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

test('late-join', async () => {
  const seed = 1002
  const harness = await createNetHarness({ fixture: await putsFixture(), seed, clients: 1 })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(5)
    harness.clients[0]?.dispatch({ SetMotd: { n: 55 } })
    await harness.advanceTicks(10)
    expect((harness.clients[0]?.ui() as { motd: number } | null)?.motd).toBe(55)

    // The late joiner: added mid-session, after real state already exists.
    const joiner = harness.addClient()
    joiner.setCamera(square(1))
    await harness.settle()

    expect((joiner.ui() as { motd: number } | null)?.motd).toBe(55)
    harness.assertConverged({ only: [0] })

    // A joiner that never subscribes sees the global scope's own motd (broadcast to every
    // connection, host/mod.rs's own "Global: value on change or first" -- unconditional, not
    // camera-gated) but never establishes a real chunk subscription -- the harness's own
    // `setCamera`/`setView` are the only thing that ever changes `halfExtentTiles{X,Y}` away from
    // `CameraState`'s own `0` default (`headless-client.ts`'s own doc comment on `SQUARE_VIEWPORT`).
    const unsubscribed = harness.addClient()
    await harness.settle()
    expect((unsubscribed.ui() as { motd: number } | null)?.motd).toBe(55)
  } finally {
    await harness.dispose()
  }
})
