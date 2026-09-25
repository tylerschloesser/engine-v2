import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  buildStepsReport,
  buildTimingsReport,
  classifyBudget,
  findSeed,
  formatAdapter,
  formatBuildWarning,
  formatFailure,
  formatSuiteLine,
  formatWarning,
  parseJunit,
  parsePlaywrightJson,
  parseVitestJson,
} from './report.mjs'

// Reports captured from the pinned nextest and Vitest running the negative controls.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('classifyBudget', () => {
  test('passes up to the budget, warns above it, fails above the failure multiple', () => {
    expect(classifyBudget(10_000, 10_000)).toBe('pass')
    expect(classifyBudget(10_001, 10_000)).toBe('warn')
    expect(classifyBudget(15_000, 10_000)).toBe('warn')
    expect(classifyBudget(15_001, 10_000)).toBe('fail')
  })

  test('scale multiplies the budget', () => {
    expect(classifyBudget(15_001, 10_000, 2)).toBe('pass')
    expect(classifyBudget(1, 10_000, 0.000001)).toBe('fail')
  })
})

describe('formatSuiteLine', () => {
  const base = { name: 'rust', failed: false, tests: 12, ms: 1234, budgetMs: 10_000, nameWidth: 7 }

  test('pads the name and count columns', () => {
    expect(formatSuiteLine(base)).toBe('rust    pass 12 tests   1.2s/10s')
  })

  test('a failed suite says FAIL', () => {
    expect(formatSuiteLine({ ...base, failed: true })).toBe('rust    FAIL 12 tests   1.2s/10s')
  })

  test('over budget warns; over the failure multiple fails', () => {
    expect(formatSuiteLine({ ...base, ms: 12_000 })).toBe(
      'rust    pass 12 tests   12s/10s WARN over budget',
    )
    expect(formatSuiteLine({ ...base, ms: 16_000 })).toBe(
      'rust    FAIL 12 tests   16s/10s over budget',
    )
  })

  test('scale shows in the printed budget', () => {
    expect(formatSuiteLine({ ...base, scale: 3 })).toBe('rust    pass 12 tests   1.2s/30s')
  })

  test('no budget (slow tier): duration alone, never classified', () => {
    expect(formatSuiteLine({ ...base, ms: 99_000, budgetMs: undefined })).toBe(
      'rust    pass 12 tests   99s',
    )
  })
})

describe('parseJunit', () => {
  test('passing report', () => {
    expect(parseJunit(fixture('junit-pass.xml'))).toEqual({ tests: 1, failures: [] })
  })

  test('failing report: entities unescaped, multi-line message, backtrace note dropped', () => {
    const { tests, failures } = parseJunit(fixture('junit-fail.xml'))
    expect(tests).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].name).toBe('engine::runner_control runner_negative_control')
    const lines = failures[0].message.split('\n')
    expect(lines[0]).toMatch(/^thread 'runner_negative_control' \(\d+\) panicked at /)
    expect(lines[1]).toBe('runner self-check: deliberate failure')
    expect(lines).toHaveLength(2)
  })

  test('a self-closing passing case before a failing one does not swallow it', () => {
    const xml = `<testsuites tests="3" skipped="1" failures="1" errors="0">
      <testsuite name="a"><testcase name="ok" classname="a"/>
      <testcase name="bad" classname="a"><failure message="1 &lt; 2 &amp;&amp; x"/></testcase>
      </testsuite></testsuites>`
    expect(parseJunit(xml)).toEqual({
      tests: 2,
      failures: [{ name: 'a bad', message: '1 < 2 && x', seed: undefined, artefacts: [] }],
    })
  })

  test('an empty run has zero tests', () => {
    expect(
      parseJunit('<testsuites name="nextest-run" tests="0" skipped="0">\n</testsuites>'),
    ).toEqual({ tests: 0, failures: [] })
  })
})

describe('parseVitestJson', () => {
  test('passing report', () => {
    expect(parseVitestJson(fixture('vitest-pass.json'))).toEqual({ tests: 1, failures: [] })
  })

  test('failing report: message plus the first frame outside node_modules', () => {
    const { tests, failures } = parseVitestJson(fixture('vitest-fail.json'))
    expect(tests).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].name).toBe('runner_negative_control')
    expect(failures[0].message.split('\n')).toEqual([
      expect.stringMatching(/^AssertionError: runner self-check: deliberate failure/),
      '    at /repo/scripts/lib/runner-control.test.mjs:6:86',
    ])
  })

  test('every test filtered out: zero tests, no failure', () => {
    expect(parseVitestJson(fixture('vitest-none.json'))).toEqual({ tests: 0, failures: [] })
  })

  test('a file that fails to load is a failure named after the file', () => {
    const report = {
      numPassedTests: 0,
      numFailedTests: 0,
      testResults: [
        {
          name: '/repo/x.test.mjs',
          status: 'failed',
          message: 'SyntaxError',
          assertionResults: [],
        },
      ],
    }
    expect(parseVitestJson(JSON.stringify(report)).failures).toEqual([
      { name: '/repo/x.test.mjs', message: 'SyntaxError', artefacts: [] },
    ])
  })
})

describe('parsePlaywrightJson', () => {
  test('passing report: one test per spec x project', () => {
    expect(parsePlaywrightJson(fixture('playwright-pass.json'))).toEqual({
      tests: 1,
      failures: [],
      warnings: [],
      adapters: [],
      errors: [],
    })
  })

  test('top-level errors (a webServer that failed to start) are surfaced, not dropped', () => {
    const report = {
      suites: [],
      errors: [
        { message: 'Error: Process from config.webServer was not able to start. Exit code: 1' },
      ],
    }
    expect(parsePlaywrightJson(JSON.stringify(report)).errors).toEqual([
      'Error: Process from config.webServer was not able to start. Exit code: 1',
    ])
  })

  test('adapter.info annotations: deduped, in first-seen order', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: 'a',
              tests: [
                {
                  projectName: 'chromium',
                  annotations: [{ type: 'adapter.info', description: '{"vendor":"apple"}' }],
                  results: [{ status: 'passed' }],
                },
              ],
            },
            {
              title: 'b',
              tests: [
                {
                  projectName: 'gc',
                  annotations: [{ type: 'adapter.info', description: '{"vendor":"apple"}' }],
                  results: [{ status: 'passed' }],
                },
                {
                  projectName: 'gc',
                  annotations: [{ type: 'adapter.info', description: 'null' }],
                  results: [{ status: 'failed', errors: [{ message: 'no adapter' }] }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(parsePlaywrightJson(JSON.stringify(report)).adapters).toEqual([
      '{"vendor":"apple"}',
      'null',
    ])
  })

  test('failing report: name carries the project, message from results.errors, trace as an artefact', () => {
    const { tests, failures, warnings } = parsePlaywrightJson(fixture('playwright-fail.json'))
    expect(tests).toBe(2)
    expect(failures).toEqual([
      {
        name: '[webkit] determinism: golden reproduced @engines',
        message: 'checkpoint 0: got aaa, golden has bbb',
        seed: undefined,
        artefacts: ['test-results/webkit/trace.zip'],
      },
    ])
    expect(warnings).toEqual([
      '[chromium] determinism: golden reproduced @engines: Tracing.start took 1.2s',
    ])
  })
})

describe('formatWarning', () => {
  test('indented warn line', () => {
    expect(formatWarning('slow: Tracing.start')).toBe('  warn slow: Tracing.start')
  })
})

describe('formatAdapter', () => {
  test('indented adapter line', () => {
    expect(formatAdapter('{"vendor":"apple"}')).toBe('  adapter {"vendor":"apple"}')
  })
})

describe('formatFailure', () => {
  test('name, indented message, seed, artefacts', () => {
    const block = formatFailure({
      suite: 'netcode',
      name: 'late join',
      message: 'hash mismatch\nseed=42',
      seed: '42',
      artefacts: ['test-results/netcode/late-join.log'],
    })
    expect(block).toBe(
      [
        '',
        'FAIL netcode late join',
        '  hash mismatch',
        '  seed=42',
        '  seed: 42',
        '  artefact: test-results/netcode/late-join.log',
      ].join('\n'),
    )
  })

  test('caps the message at 20 lines and strips ANSI colour', () => {
    const message = Array.from({ length: 25 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`).join('\n')
    const lines = formatFailure({ suite: 'unit', name: 'long', message }).split('\n')
    expect(lines).toHaveLength(2 + 20 + 1)
    expect(lines[2]).toBe('  line 0')
    expect(lines.at(-1)).toBe('  … 5 more lines')
  })
})

describe('findSeed', () => {
  test('finds decimal and hex seeds, else undefined', () => {
    expect(findSeed('replay diverged, seed=1234')).toBe('1234')
    expect(findSeed('Seed: 0xBEEF at tick 3')).toBe('0xBEEF')
    expect(findSeed('no such thing')).toBeUndefined()
  })
})

test('runner: timings json shape', () => {
  const outcomes = [
    { suite: { name: 'rust', budgetMs: 10_000 }, ms: 412.3, tests: 145 },
    // The slow tier's suite line carries no budget (formatSuiteLine's own "undefined" case).
    { suite: { name: 'browser', budgetMs: undefined }, ms: 21_004.7, tests: 90 },
  ]
  expect(
    buildTimingsReport({ commit: 'abc123', cpu: 'AMD EPYC 7763', buildMs: 5_000, outcomes }),
  ).toEqual({
    commit: 'abc123',
    cpu: 'AMD EPYC 7763',
    buildMs: 5_000,
    suites: [
      { suite: 'rust', ms: 412.3, budgetMs: 10_000, tests: 145 },
      { suite: 'browser', ms: 21_004.7, budgetMs: undefined, tests: 90 },
    ],
  })
})

describe('buildStepsReport', () => {
  test('one entry per build step, in the order given', () => {
    const steps = [
      { name: 'tsc', ms: 512.4 },
      { name: 'fixtures', ms: 15_876.2 },
    ]
    expect(buildStepsReport(steps)).toEqual({
      steps: [
        { name: 'tsc', ms: 512.4 },
        { name: 'fixtures', ms: 15_876.2 },
      ],
    })
  })
})

describe('formatBuildWarning', () => {
  const steps = [
    { name: 'tsc', ms: 512 },
    { name: 'fixtures', ms: 15_876 },
    { name: 'cargo-tests', ms: 15_902 },
    { name: 'doctests', ms: 5_700 },
    { name: 'pages', ms: 600 },
  ]

  test('names the three slowest steps, slowest first', () => {
    expect(formatBuildWarning(38_590, 30_000, 1, steps)).toBe(
      'build WARN 39s/30s (slowest: cargo-tests 16s, fixtures 16s, doctests 5.7s)',
    )
  })

  test('scale multiplies the printed budget, `top` changes how many steps are named', () => {
    expect(formatBuildWarning(38_590, 15_000, 2, steps, 1)).toBe(
      'build WARN 39s/30s (slowest: cargo-tests 16s)',
    )
  })
})
