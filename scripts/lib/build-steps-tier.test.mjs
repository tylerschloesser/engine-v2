// The slow-tier-only `reference-bench` build step (M39f, Deviations):
// the walk browser specs serve `games/reference/dist-bench/`, and the fast tier must never build it.
import { describe, expect, it } from 'vitest'
import { buildSteps, buildStepsFor } from '../suites.mjs'

describe('build steps by tier', () => {
  it('the fast tier does not build the bench build; the slow tier does, after the reference build', () => {
    const fast = buildStepsFor('fast').map((s) => s.name)
    const slow = buildStepsFor('slow').map((s) => s.name)
    expect(fast).not.toContain('reference-bench')
    expect(slow).toContain('reference-bench')
    expect(slow.indexOf('reference-bench')).toBeGreaterThan(slow.indexOf('reference'))
  })

  it('every other step runs in both tiers', () => {
    const rest = buildSteps.filter((s) => s.name !== 'reference-bench').map((s) => s.name)
    expect(buildStepsFor('fast').map((s) => s.name)).toEqual(rest)
    expect(buildStepsFor('slow').map((s) => s.name)).toEqual([...rest, 'reference-bench'])
  })
})
