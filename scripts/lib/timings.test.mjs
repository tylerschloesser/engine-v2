import { describe, expect, test } from 'vitest'
import {
  aggregate,
  parseVitestDuration,
  percentile,
  testsFromJunit,
  testsFromPlaywright,
  testsFromVitest,
} from './timings.mjs'

describe('test-timings', () => {
  test('test-timings: aggregates reports', () => {
    const junit = `<testsuites><testsuite name="engine"><testcase name="a::b" classname="engine" time="0.020"/><testcase name="c" classname="engine" time="0.600"/></testsuite></testsuites>`
    expect(testsFromJunit(junit)).toEqual([
      { name: 'engine a::b', ms: 20 },
      { name: 'engine c', ms: 600 },
    ])
    const vitest = JSON.stringify({
      testResults: [
        {
          name: '/x/y/foo.test.ts',
          assertionResults: [
            { fullName: 't1', status: 'passed', duration: 7 },
            { fullName: 't2', status: 'pending' },
          ],
        },
      ],
    })
    expect(testsFromVitest(vitest)).toEqual([{ name: 'foo.test.ts: t1', ms: 7 }])
    const pw = JSON.stringify({
      suites: [
        {
          suites: [
            {
              specs: [
                {
                  title: 's',
                  file: 'f.spec.ts',
                  tests: [{ projectName: 'chromium', results: [{ duration: 5 }, { duration: 9 }] }],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(testsFromPlaywright(pw)).toEqual([{ name: '[chromium] f.spec.ts: s', ms: 9 }])

    const run = (rustMs, load) => ({
      load,
      buildMs: 1000,
      totalMs: 5000,
      suites: [
        {
          suite: 'rust',
          ms: 2000,
          budgetMs: 10_000,
          tests: [
            { name: 'engine c', ms: rustMs },
            { name: 'engine a', ms: 1 },
          ],
        },
      ],
    })
    const runs = Array.from({ length: 10 }, (_, i) => run(i === 9 ? 900 : 100 + i, i))
    const agg = aggregate(runs)
    expect(agg.runs).toBe(10)
    expect(agg.load).toEqual({ min: 0, max: 9 })
    expect(agg.suites[0].tests[0]).toMatchObject({ name: 'engine c', n: 10, p95: 900, max: 900 })
    expect(agg.suites[0].offenders.map((t) => t.name)).toEqual(['engine c'])
    expect(agg.suites[0].wall.p50).toBe(2000)
  })

  test('percentile is nearest-rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([], 50)).toBeNaN()
  })

  test('vitest footer splits test time from overhead', () => {
    const log =
      '   Duration  3.31s (transform 1.20s, setup 0ms, import 2s, tests 500ms, environment 0ms)'
    expect(parseVitestDuration(log)).toMatchObject({
      totalMs: 3310,
      transformMs: 1200,
      testsMs: 500,
      importMs: 2000,
    })
    expect(
      parseVitestDuration('Duration  727ms (transform 71%, import 24%, worker 5%)'),
    ).toMatchObject({ totalMs: 727, transformPct: 71 })
    expect(parseVitestDuration('nothing')).toBeNull()
  })
})
