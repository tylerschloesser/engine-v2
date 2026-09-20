import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { adapters } from './adapters.mjs'

const leg = { cmd: 'bun', args: ['leg.mjs'], tests: ['determinism: bun matches golden'] }

function logWith(text) {
  const logPath = join(mkdtempSync(join(tmpdir(), 'adapters-')), 'leg.log')
  writeFileSync(logPath, text)
  return logPath
}

describe('playwright adapter', () => {
  const browserSuite = { name: 'browser', args: ['--project', 'chromium', '--project', 'gc'] }

  test('command: fast tier excludes @slow, slow tier requires it, pattern composes', () => {
    const { command } = adapters.playwright
    expect(command({ suite: browserSuite, tier: 'fast' })).toEqual({
      cmd: 'pnpm',
      args: [
        'exec',
        'playwright',
        'test',
        '--config',
        'packages/engine/playwright.config.ts',
        '--grep',
        '^(?!.*@slow).*',
        '--project',
        'chromium',
        '--project',
        'gc',
      ],
      env: { PLAYWRIGHT_JSON_OUTPUT_FILE: 'test-results/browser/report.json' },
      reportPath: 'test-results/browser/report.json',
    })
    expect(command({ suite: browserSuite, tier: 'slow', pattern: 'determinism' }).args).toContain(
      '(?=.*@slow).*determinism',
    )
  })

  // docs/plan/09-renderer-terrain.md, Deviations "Steps 5-7": an *unanchored* `(?!.*@slow)` still
  // matches a title containing "@slow" once Playwright's (or here, a plain `RegExp.test`) scan
  // position moves past the literal text -- `.test()` tries every start position, and at the
  // position right after "@slow" the lookahead trivially succeeds. `^` forces the lookahead to be
  // evaluated only at position 0, where the title's own "@slow" is still ahead of it.
  test('fast-tier grep actually excludes a title with @slow anywhere in it', () => {
    const { command } = adapters.playwright
    const args = command({ suite: browserSuite, tier: 'fast' }).args
    const grepSource = args[args.indexOf('--grep') + 1]
    const re = new RegExp(grepSource)
    expect(re.test('terrain: probe tile colours webkit @webkit-gpu @slow')).toBe(false)
    expect(re.test('terrain: probe tile colours')).toBe(true)
  })

  // Gate round 3 (docs/plan/09-renderer-terrain.md, Deviations): WebKit/Firefox repeats are a
  // separate leg, gated to the slow tier alone (`onlyTier`) and running with no `@slow` composition
  // (`noSlowTag`) since their own titles carry `@engines`/`@webkit-gpu`, never `@slow`.
  test('command: a leg with onlyTier only runs in that tier', () => {
    const { command } = adapters.playwright
    const engines = { name: 'engines', onlyTier: 'slow', noSlowTag: true, port: 4518 }
    expect(command({ suite: engines, tier: 'fast' })).toBeNull()
    const slow = command({ suite: engines, tier: 'slow', pattern: 'determinism' })
    expect(slow.args).toContain('determinism')
    // `noSlowTag`: no `(?=.*@slow)`/`(?!.*@slow)` lookahead composed into the grep at all.
    expect(slow.args.some((a) => a.includes('@slow'))).toBe(false)
    expect(slow.env).toEqual({
      PLAYWRIGHT_JSON_OUTPUT_FILE: 'test-results/engines/report.json',
      ENGINE_TEST_PORT: '4518',
    })
  })
})

describe('script adapter', () => {
  test('script adapter: -t skips a script none of whose tests match', () => {
    const { command } = adapters.script
    expect(command({ suite: leg, tier: 'fast' })).toEqual({
      cmd: 'bun',
      args: ['leg.mjs'],
      reportPath: null,
    })
    expect(command({ suite: leg, pattern: 'bun matches', tier: 'fast' })).not.toBeNull()
    expect(command({ suite: leg, pattern: 'import allowlist', tier: 'fast' })).toBeNull()
    expect(command({ suite: leg, tier: 'slow' })).toBeNull()
  })

  test('script adapter: the last line is the result', () => {
    const logPath = logWith(
      'noise\n{"tests":[{"name":"a","ok":true},{"name":"b","ok":false,"message":"m"}]}\n',
    )
    expect(adapters.script.parse({ exitCode: 1, logPath })).toEqual({
      tests: 2,
      failures: [{ name: 'b', message: 'm', artefacts: [logPath] }],
    })
  })

  test('script adapter: a crash or a silent non-zero exit is a failure', () => {
    const crashed = adapters.script.parse({ exitCode: 1, logPath: logWith('TypeError: boom\n') })
    expect(crashed.failures).toHaveLength(1)
    expect(crashed.failures[0].message).toContain('TypeError: boom')
    const silent = adapters.script.parse({
      exitCode: 3,
      logPath: logWith('{"tests":[{"name":"a","ok":true}]}\n'),
    })
    expect(silent.failures[0].name).toBe('script exited 3 but reported no failure')
  })
})
