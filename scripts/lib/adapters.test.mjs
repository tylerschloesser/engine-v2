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
  test('command: fast tier excludes @slow, slow tier requires it, pattern composes', () => {
    const { command } = adapters.playwright
    expect(command({ suite: { name: 'browser' }, tier: 'fast' })).toEqual({
      cmd: 'pnpm',
      args: [
        'exec',
        'playwright',
        'test',
        '--config',
        'packages/engine/playwright.config.ts',
        '--grep',
        '(?!.*@slow).*',
      ],
      env: { PLAYWRIGHT_JSON_OUTPUT_FILE: 'test-results/browser/report.json' },
      reportPath: 'test-results/browser/report.json',
    })
    expect(
      command({ suite: { name: 'browser' }, tier: 'slow', pattern: 'determinism' }).args,
    ).toContain('(?=.*@slow).*determinism')
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
