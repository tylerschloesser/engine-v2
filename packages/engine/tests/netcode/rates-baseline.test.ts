// `rates/baseline-*` (docs/plan/31-rates-and-integrity.md step 1): M27's own scenarios, replayed
// with `assertBudget`, so the numbers M31's pacing changes must not silently move are recorded in
// `budgets.json` (`counters.net.baseline*`). Seeds and flows mirror `counters-exact`, `join-converges`
// and `late-join`.
import { expect, test } from 'vitest'
import { assertBudget } from '../../src/test/budget.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { putsFixture, square } from './support.js'

test('rates/baseline-counters-exact', async () => {
  // M31b R1: hash-all off, this test pins the baseline byte counts exactly (hash bytes are `integrity/`'s).
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 4001,
    clients: 1,
    hashAll: false,
  })
  try {
    harness.clients[0]?.setCamera({ x: 0, y: 0, tilesAcross: 20 })
    await harness.advanceTicks(3)
    harness.clients[0]?.dispatch({ SetMotd: { n: 1 } })
    await harness.advanceTicks(2)
    const c = harness.counters(0)
    assertBudget(c, 'net.baselineCountersExactBytesDown')
    assertBudget(c, 'net.baselineCountersExactChunkEnters')
  } finally {
    await harness.dispose()
  }
})

test('rates/baseline-join-converges', async () => {
  // M31b R1: hash-all off, this test's ceilings are byte budgets (hash bytes are `integrity/`'s).
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 1001,
    clients: 4,
    hashAll: false,
  })
  try {
    harness.clients.forEach((c, i) => {
      c.setCamera(square(i))
    })
    await harness.advanceTicks(10)
    harness.clients[0]?.dispatch({ Paint: { pos: { x: 2, y: 2 }, base: 1, resource: 0 } })
    harness.clients[1]?.dispatch({ Spawn: { at: { x: -3, y: 8 }, kind: 1 } })
    harness.clients[2]?.dispatch({ SetMotd: { n: 99 } })
    harness.clients[3]?.dispatch('Roll')
    await harness.settle()
    const c = harness.counters(0)
    assertBudget(c, 'net.baselineJoinConvergesBytesDown')
    assertBudget(c, 'net.baselineJoinConvergesWorstSecondBytesDown')
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('rates/baseline-late-join', async () => {
  // M31b R1: hash-all off, this test's ceilings are byte budgets (hash bytes are `integrity/`'s).
  const harness = await createNetHarness({
    fixture: await putsFixture(),
    seed: 1002,
    clients: 1,
    hashAll: false,
  })
  try {
    harness.clients[0]?.setCamera(square(0))
    await harness.advanceTicks(5)
    harness.clients[0]?.dispatch({ SetMotd: { n: 55 } })
    await harness.advanceTicks(10)
    const joiner = harness.addClient()
    joiner.setCamera(square(1))
    await harness.settle()
    const c = harness.counters(1)
    assertBudget(c, 'net.baselineLateJoinBytesDown')
    assertBudget(c, 'net.baselineLateJoinWorstSecondBytesDown')
    harness.assertConverged()
  } finally {
    await harness.dispose()
  }
})

test('rates/assert-budget-names-the-row', () => {
  const counters = { bytesDown: 113 }
  expect(() => assertBudget(counters, 'net.baselineCountersExactBytesDown')).toThrow(
    /net\.baselineCountersExactBytesDown.*113.*112/,
  )
  expect(() => assertBudget({ bytesDown: 999 }, 'net.baselineCountersExactBytesDown')).toThrow(
    /exceeds ceiling 124/,
  )
  expect(() => assertBudget({}, 'net.nope')).toThrow(/net\.nope/)
})
