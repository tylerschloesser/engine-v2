// One adapter per test runner. An adapter is two pure functions: `command` says what to spawn and
// where the child writes its machine-readable report; `parse` turns that report into counts and
// failures. The runner (scripts/test.mjs) deletes `reportPath` before spawning and hands the same
// path back to `parse`, so a stale report is never read. M03 adds `playwright`.
import { existsSync, readFileSync } from 'node:fs'
import { parseJunit, parsePlaywrightJson, parseVitestJson } from './report.mjs'
import { lastLines, readLog } from './run.mjs'

/**
 * Shared `parse`: exit 0 with no report file means 0 tests, pass; a non-zero exit that the report
 * does not explain becomes one failure holding the tail of the log. The failure's own name says
 * which of those two happened (docs/plan/10-ci-workflow.md, Deviations: a run whose `wasm` step
 * exited 1 with a report that parsed cleanly and showed 0 failures was still reported as "without a
 * parseable report" -- true of neither the report nor the exit, and it cost a session real time to
 * find that out from the artefact instead of the message) -- a report present but the run still
 * exiting non-zero points at a process-level problem (an unhandled rejection outside any test, a
 * worker crash) the JSON reporter's own summary does not capture, not a missing/corrupt report.
 */
function fromReport(parseReport) {
  return ({ reportPath, exitCode, logPath }) => {
    let result = { tests: 0, failures: [] }
    let parsed = false
    if (reportPath && existsSync(reportPath)) {
      try {
        result = parseReport(readFileSync(reportPath, 'utf8'))
        parsed = true
      } catch {
        // An unreadable report is handled like a missing one.
      }
    }
    if (exitCode !== 0 && result.failures.length === 0) {
      const name = parsed
        ? `runner exited ${exitCode} after a parseable report showed 0 failures`
        : `runner exited ${exitCode} without a parseable report`
      result.failures.push({ name, message: lastLines(readLog(logPath), 20), artefacts: [logPath] })
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
        // Without --passWithNoTests a project with no test files exits 1. `--reporter=default`
        // alongside `--reporter=json` (docs/plan/17d-fast-tier-wall-time.md step 0): the `json`
        // reporter's own summary has no field for an error the JSON schema doesn't model -- an
        // "Unhandled Rejection"/"Unhandled Error" Vitest catches outside any running test, which
        // still fails the run (exit 1) while the summary shows 0 failures (a real CI occurrence,
        // `docs/plan/10-ci-workflow.md` Deviations). `default`'s own "⎯ Unhandled Errors ⎯" block
        // (with the offending stack) prints to this same log either way -- the log is only ever
        // excerpted into console output on a non-zero exit (`run.mjs`), so a passing run stays
        // exactly as quiet as before. Vitest accepts one bare `--outputFile=` with two reporters
        // named (only `json` writes a file; `default` has none), so no dot-notation is needed.
        args: [
          'exec',
          'vitest',
          'run',
          '--project',
          suite.name,
          '--passWithNoTests',
          '--reporter=default',
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

  // `browser` (docs/decisions/0020 §1, §3, §4): Playwright Test against `packages/engine/
  // playwright.config.ts`. `--grep` composes the `@slow` tag with `pattern` the same way the
  // `vitest` adapter's `-t` does. `suite.args` (from scripts/suites.mjs) picks projects: the
  // `browser` suite itself runs `chromium`+`gc` in every tier; a `legs` entry runs `webkit`+
  // `firefox` only in the slow tier (`onlyTier`, gate round 3: docs/plan/09-renderer-terrain.md,
  // Deviations "Gate round 3") -- WebKit/Firefox carry no `@slow` title tag (their own
  // `@engines`/`@webkit-gpu` project-level `grep` already scopes them), so that leg's own grep is
  // `noSlowTag`: plain `pattern`, no `@slow` composition. A `pnpm gc` mode (GC_MODE=software,
  // GC_CDP=flat, --repeat-each) is a separate, local-only invocation of the same `gc` project
  // (docs/plan/04-zero-gc-harness.md, Seams).
  playwright: {
    command({ suite, pattern, tier }) {
      if (suite.onlyTier && suite.onlyTier !== tier) return null
      const reportPath = `${suite.name}/report.json`
      // `^` matters only for the fast tier: Playwright's `--grep` tests this pattern unanchored
      // (any substring position), so an un-anchored `(?!.*@slow)` "succeeds" trivially once the
      // scan position moves past the literal "@slow" text in the title -- found by docs/plan/
      // 09-renderer-terrain.md's own `@webkit-gpu @slow` test still running under `pnpm test`
      // (fast tier). The `vitest` adapter right below already anchors both of its own tags this
      // way; this brings `playwright` in line with it. The slow tier's `(?=.*@slow)` needs no `^`:
      // a positive lookahead that can match starting at position 0 needs no anchor to be correct.
      const grep = suite.noSlowTag
        ? (pattern ?? '.*')
        : `${tier === 'slow' ? '(?=.*@slow)' : '^(?!.*@slow)'}.*${pattern ?? ''}`
      return {
        cmd: 'pnpm',
        args: [
          'exec',
          'playwright',
          'test',
          '--config',
          'packages/engine/playwright.config.ts',
          '--grep',
          grep,
          ...(suite.args ?? []),
        ],
        env: {
          PLAYWRIGHT_JSON_OUTPUT_FILE: `test-results/${reportPath}`,
          ...(suite.port ? { ENGINE_TEST_PORT: String(suite.port) } : {}),
        },
        reportPath: `test-results/${reportPath}`,
      }
    },
    // Not `fromReport`: unlike nextest's `--no-tests=pass`/vitest's `--passWithNoTests`, Playwright
    // has no flag to make an empty `--grep` match exit 0, and it does now happen legitimately (the
    // `engines` leg above, gate round 3, under a narrow `-t` pattern that matches only the main
    // leg's own tests) -- a successfully parsed, empty report (`suites: []`, top-level `errors:
    // [{message: "Error: No tests found"}]`) is zero tests, not a failure, *and* Playwright still
    // exits 1 for it (measured directly: `--grep` matching nothing exits 1 with exactly that
    // message, same as every other empty-grep case) -- so exit code cannot tell this apart from a
    // real crash before any test ran.
    //
    // Gate round 1 fix (docs/plan/20-reference-game-v0.md): the previous version of this function
    // treated *any* parsed, empty (`tests: 0, failures: []`) report as this legitimate case, exit
    // code unchecked -- but a `webServer` that fails to start produces the exact same shape (a
    // crash before any spec runs still lets the JSON reporter finalize a valid, empty report), so it
    // was silently reported as a pass too (found live: the `engines` leg's own `webServer` port
    // collision -- `browser pass`, `test-results/engines/report.json` showed `expected: 0`, and
    // WebKit/Firefox coverage vanished with no failure anywhere). The two cases share `tests`/
    // `failures`/exit code; what differs is `errors` (`parsePlaywrightJson`'s new field, top-level
    // `report.errors`, previously unread): the intentional case's only entry is always exactly
    // "Error: No tests found"; a `webServer` crash's is a *different* message (measured: "Error:
    // Process from config.webServer was not able to start. Exit code: 1"). Anything in `errors`
    // other than "No tests found" is therefore a real failure, reported with that message.
    parse({ reportPath, exitCode, logPath }) {
      let result = { tests: 0, failures: [], errors: [] }
      let parsed = false
      if (reportPath && existsSync(reportPath)) {
        try {
          result = parsePlaywrightJson(readFileSync(reportPath, 'utf8'))
          parsed = true
        } catch {
          // An unreadable report is handled like a missing one.
        }
      }
      const realErrors = (result.errors ?? []).filter((m) => !m.includes('No tests found'))
      if (parsed && result.tests === 0 && result.failures.length === 0 && realErrors.length === 0) {
        return result
      }
      if ((exitCode !== 0 || realErrors.length > 0) && result.failures.length === 0) {
        const name = parsed
          ? `runner exited ${exitCode} after a parseable report showed 0 failures`
          : `runner exited ${exitCode} without a parseable report`
        result.failures.push({
          name,
          message: realErrors.length > 0 ? realErrors.join('\n') : lastLines(readLog(logPath), 20),
          artefacts: [logPath],
        })
      }
      return result
    },
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
