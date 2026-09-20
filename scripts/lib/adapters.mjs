// One adapter per test runner. An adapter is two pure functions: `command` says what to spawn and
// where the child writes its machine-readable report; `parse` turns that report into counts and
// failures. The runner (scripts/test.mjs) deletes `reportPath` before spawning and hands the same
// path back to `parse`, so a stale report is never read. M03 adds `playwright`.
import { existsSync, readFileSync } from 'node:fs'
import { parseJunit, parsePlaywrightJson, parseVitestJson } from './report.mjs'
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

  // `browser` (docs/decisions/0020 §1, §3): Playwright Test against `packages/engine/playwright.config.ts`.
  // `--grep` composes the `@slow` tag with `pattern` the same way the `vitest` adapter's `-t` does.
  // All configured projects run (chromium, webkit/firefox grepped to @engines, and M04's `gc`); a
  // `pnpm gc` mode (GC_MODE=software, GC_CDP=flat, --repeat-each) is a separate, local-only
  // invocation of the same `gc` project (docs/plan/04-zero-gc-harness.md, Seams).
  playwright: {
    command({ suite, pattern, tier }) {
      const reportPath = `${suite.name}/report.json`
      // `^` matters only for the fast tier: Playwright's `--grep` tests this pattern unanchored
      // (any substring position), so an un-anchored `(?!.*@slow)` "succeeds" trivially once the
      // scan position moves past the literal "@slow" text in the title -- found by docs/plan/
      // 09-renderer-terrain.md's own `@webkit-gpu @slow` test still running under `pnpm test`
      // (fast tier). The `vitest` adapter right below already anchors both of its own tags this
      // way; this brings `playwright` in line with it. The slow tier's `(?=.*@slow)` needs no `^`:
      // a positive lookahead that can match starting at position 0 needs no anchor to be correct.
      const tag = tier === 'slow' ? '(?=.*@slow)' : '^(?!.*@slow)'
      return {
        cmd: 'pnpm',
        args: [
          'exec',
          'playwright',
          'test',
          '--config',
          'packages/engine/playwright.config.ts',
          '--grep',
          `${tag}.*${pattern ?? ''}`,
          ...(suite.args ?? []),
        ],
        env: { PLAYWRIGHT_JSON_OUTPUT_FILE: `test-results/${reportPath}` },
        reportPath: `test-results/${reportPath}`,
      }
    },
    parse: fromReport(parsePlaywrightJson),
  },

  // A plain script in any runtime (the Bun leg of `wasm`). `suite` is `{ cmd, args, tests }`:
  // `tests` names what the script reports, so `-t` can skip a script none of whose tests match.
  // The script prints one JSON line last, `{ tests: [{ name, ok, message? }] }`, and exits non-zero
  // when any test failed. It has no slow tier.
  script: {
    command({ suite, pattern, tier }) {
      const wanted = tier === 'fast' && suite.tests.some((name) => name.includes(pattern ?? ''))
      return wanted ? { cmd: suite.cmd, args: suite.args, reportPath: null } : null
    },
    parse({ exitCode, logPath }) {
      const log = readLog(logPath)
      let reported
      try {
        reported = JSON.parse(lastLines(log, 1)).tests
      } catch {
        // Handled below: no parseable last line.
      }
      if (!Array.isArray(reported)) {
        const name = `script exited ${exitCode} without a JSON result line`
        return { tests: 0, failures: [{ name, message: lastLines(log, 20), artefacts: [logPath] }] }
      }
      const failures = reported
        .filter((t) => !t.ok)
        .map((t) => ({ name: t.name, message: t.message ?? 'failed', artefacts: [logPath] }))
      if (exitCode !== 0 && failures.length === 0) {
        const name = `script exited ${exitCode} but reported no failure`
        failures.push({ name, message: lastLines(log, 20), artefacts: [logPath] })
      }
      return { tests: reported.length, failures }
    },
  },
}
