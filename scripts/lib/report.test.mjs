import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  classifyBudget,
  findSeed,
  formatFailure,
  formatSuiteLine,
  parseJunit,
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
