import { describe, expect, test } from 'vitest'
import { parseArgs } from './args.mjs'

const names = ['rust', 'unit']

describe('parseArgs', () => {
  test('defaults', () => {
    expect(parseArgs([], names)).toEqual({
      suite: undefined,
      pattern: undefined,
      tier: 'fast',
      selfCheckFail: false,
      scale: 1,
    })
  })

  test('suite, pattern, tier and flags in any order', () => {
    const argv = [
      '-t',
      'hash',
      'rust',
      '--tier',
      'slow',
      '--budget-scale',
      '2.5',
      '--self-check-fail',
    ]
    expect(parseArgs(argv, names)).toEqual({
      suite: 'rust',
      pattern: 'hash',
      tier: 'slow',
      selfCheckFail: true,
      scale: 2.5,
    })
  })

  test('--timings-json takes a path', () => {
    expect(parseArgs(['--timings-json', 'test-results/timings.json'], names)).toEqual({
      suite: undefined,
      pattern: undefined,
      tier: 'fast',
      selfCheckFail: false,
      scale: 1,
      timingsJson: 'test-results/timings.json',
    })
    expect(parseArgs(['--timings-json'], names).error).toMatch(/--timings-json needs a path/)
  })

  test('errors: unknown suite or flag, missing or bad values, two suites', () => {
    expect(parseArgs(['nosuch'], names).error).toMatch(/unknown suite nosuch/)
    expect(parseArgs(['--nope'], names).error).toMatch(/unknown flag --nope/)
    expect(parseArgs(['-t'], names).error).toBeDefined()
    expect(parseArgs(['--tier', 'medium'], names).error).toBeDefined()
    expect(parseArgs(['--budget-scale', '0'], names).error).toBeDefined()
    expect(parseArgs(['rust', 'unit'], names).error).toBeDefined()
  })
})
