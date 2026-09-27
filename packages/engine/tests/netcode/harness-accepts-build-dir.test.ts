// `harness-accepts-build-dir` (docs/plan/27-server-entrypoint-and-netcode-harness.md, Tests added):
// `fixture` given as a `buildGame()` output directory path (`net-harness.ts`'s own `resolveFixture`
// -- a plain string goes through `engine/server/node`'s `loadGame`), not the already-resolved
// `{ wasm, buildHash }` object every other scenario passes.
import { expect, test } from 'vitest'
import { createNetHarness } from '../../src/test/net-harness.js'
import { fixtureBuildDir } from '../support/fixtures.js'
import { square } from './support.js'

test('harness-accepts-build-dir: fixture as a raw buildGame() output directory path', async () => {
  const harness = await createNetHarness({
    fixture: fixtureBuildDir('puts'),
    seed: 6001,
    clients: 1,
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(5)
    harness.clients[0]?.dispatch({ SetMotd: { n: 11 } })
    await harness.settle()
    expect((harness.clients[0]?.ui() as { motd: number } | null)?.motd).toBe(11)
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})
