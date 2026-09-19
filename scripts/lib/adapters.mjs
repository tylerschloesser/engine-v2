// One adapter per test runner. An adapter is two pure functions: `command` says what to spawn and
// where the child writes its machine-readable report; `parse` turns that report into counts and
// failures. The runner (scripts/test.mjs) deletes `reportPath` before spawning and hands the same
// path back to `parse`, so a stale report is never read. M02 adds `script`, M03 adds `playwright`.
import { existsSync, readFileSync } from 'node:fs'
import { parseJunit, parseVitestJson } from './report.mjs'
import { lastLines, readLog } from './run.mjs'

/**
 * Shared `parse`: exit 0 with no report file means 0 tests, pass; a non-zero exit that the report
 * does not explain becomes one failure holding the tail of the log.
 */
function fromReport(parseReport) {
  return ({ reportPath, exitCode, logPath }) => {
    let result = { tests: 0, failures: [] }
    if (reportPath && existsSync(reportPath)) {
      try {
        result = parseReport(readFileSync(reportPath, 'utf8'))
      } catch {
        // An unreadable report is handled like a missing one.
      }
    }
    if (exitCode !== 0 && result.failures.length === 0) {
      result.failures.push({
        name: `runner exited ${exitCode} without a parseable report`,
        message: lastLines(readLog(logPath), 20),
        artefacts: [logPath],
      })
    }
    return result
  }
}

export const adapters = {
  nextest: {
    command({ suite, pattern, tier }) {
      const profile = tier === 'slow' ? 'slow' : 'default'
      return {
        cmd: 'cargo',
        // Without --no-tests=pass a filter that matches nothing exits 4.
        args: [
          'nextest',
          'run',
          '--workspace',
          '--no-tests=pass',
          ...(tier === 'slow' ? ['-P', 'slow'] : []),
          ...(suite.args ?? []),
          ...(pattern ? [pattern] : []),
        ],
        reportPath: `target/nextest/${profile}/junit.xml`,
      }
    },
    parse: fromReport(parseJunit),
  },

  vitest: {
    command({ suite, pattern, tier, outDir }) {
      const reportPath = `${outDir}/report.json`
      // The slow tag is `@slow` in the test title (0020 §4); `pattern` is a plain substring.
      const tag = tier === 'slow' ? '^(?=.*@slow)' : '^(?!.*@slow)'
      return {
        cmd: 'pnpm',
        // Without --passWithNoTests a project with no test files exits 1.
        args: [
          'exec',
          'vitest',
          'run',
          '--project',
          suite.name,
          '--passWithNoTests',
          '--reporter=json',
          `--outputFile=${reportPath}`,
          '-t',
          `${tag}.*${pattern ?? ''}`,
          ...(suite.args ?? []),
        ],
        reportPath,
      }
    },
    parse: fromReport(parseVitestJson),
  },
}
