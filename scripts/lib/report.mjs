// Pure formatting and report parsing for `pnpm test` (output contract: docs/decisions/0020 §2).
// Nothing here touches the file system or the clock.

// A suite over budget warns; over this multiple of its budget it fails. Owner: 0020 §2.
const FAIL_MULTIPLE = 1.5

const MESSAGE_LINES = 20

/** @returns {'pass' | 'warn' | 'fail'} */
export function classifyBudget(ms, budgetMs, scale = 1) {
  const budget = budgetMs * scale
  if (ms > budget * FAIL_MULTIPLE) return 'fail'
  return ms > budget ? 'warn' : 'pass'
}

/** `1.2s` under ten seconds, whole seconds above; budgets print without a trailing `.0`. */
export function formatDuration(ms) {
  const s = ms / 1000
  if (s >= 10) return `${Math.round(s)}s`
  return `${s.toFixed(1).replace(/\.0$/, '')}s`
}

/**
 * One suite line: `name pass|FAIL <n> tests <duration>/<budget>[ WARN over budget| over budget]`.
 * `budgetMs` undefined (the slow tier) prints the duration alone and is never classified.
 */
export function formatSuiteLine({ name, failed, tests, ms, budgetMs, scale = 1, nameWidth = 0 }) {
  const budget = budgetMs === undefined ? 'pass' : classifyBudget(ms, budgetMs, scale)
  const status = failed || budget === 'fail' ? 'FAIL' : 'pass'
  const count = `${tests} tests`.padEnd(10)
  const time =
    budgetMs === undefined
      ? formatDuration(ms)
      : `${formatDuration(ms)}/${formatDuration(budgetMs * scale)}`
  const note = { pass: '', warn: ' WARN over budget', fail: ' over budget' }[budget]
  return `${name.padEnd(nameWidth)} ${status} ${count} ${time}${note}`
}

/**
 * The `--timings-json` artefact (docs/plan/10-ci-workflow.md, Seams: "writes `{ suite, ms,
 * budgetMs, tests }[]` plus build ms, CPU model and commit"). Recorded, never gating (0020 §10):
 * `budgetMs` is whatever the caller measured it against (the unscaled budget, since CI runs with
 * `--budget-scale` applied only to pass/fail, not to this number) and is `undefined` for a suite
 * run in the slow tier, which carries no budget. Pure: `commit`/`cpu` are read by the caller
 * (`scripts/test.mjs`), not here.
 */
export function buildTimingsReport({ commit, cpu, buildMs, outcomes }) {
  return {
    commit,
    cpu,
    buildMs,
    suites: outcomes.map(({ suite, ms, tests }) => ({
      suite: suite.name,
      ms,
      budgetMs: suite.budgetMs,
      tests,
    })),
  }
}

/** One warning line under a suite's line (an adapter's `warnings`, docs/decisions/0020 §3 extension:
 * M04 uses this for the `Tracing.start` stall). */
export function formatWarning(text) {
  return `  warn ${text}`
}

/** One distinct `adapter.info` line under a suite's line (docs/plan/10-ci-workflow.md, Scope:
 * "adapter class recorded by every GPU test"; `parsePlaywrightJson`'s `adapters`). */
export function formatAdapter(text) {
  return `  adapter ${text}`
}

/** One failure block: name, message capped at `maxLines`, seed, artefact paths. */
export function formatFailure(
  { suite, name, message, seed, artefacts = [] },
  maxLines = MESSAGE_LINES,
) {
  const lines = stripAnsi(message ?? '')
    .trimEnd()
    .split('\n')
  const shown = lines.slice(0, maxLines)
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines`)
  const out = ['', `FAIL ${suite} ${name}`, ...shown.map((l) => `  ${l}`)]
  if (seed !== undefined) out.push(`  seed: ${seed}`)
  for (const path of artefacts) out.push(`  artefact: ${path}`)
  return out.join('\n')
}

/** A seed printed by a failing test as `seed=123`, `seed: 0xabc` or `seed 7`. */
export function findSeed(text) {
  return /\bseed\s*[=:]?\s*(0x[0-9a-f]+|\d+)/i.exec(text)?.[1]
}

/** nextest's JUnit report: totals from `<testsuites>`, failures from `<testcase>` + `<failure>`. */
export function parseJunit(xml) {
  const total = Number(attr(/<testsuites\b[^>]*>/.exec(xml)?.[0] ?? '', 'tests') ?? 0)
  const skipped = Number(attr(/<testsuites\b[^>]*>/.exec(xml)?.[0] ?? '', 'skipped') ?? 0)
  const failures = []
  for (const [, open, body] of xml.matchAll(/(<testcase\b[^>]*[^/])>([\s\S]*?)<\/testcase>/g)) {
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body)
    if (!failure) continue
    const text = unescapeXml(failure[3] ?? '').trim() || (attr(failure[2], 'message') ?? '')
    const message = text
      .split('\n')
      .filter((l) => !l.startsWith('note: run with `RUST_BACKTRACE'))
      .join('\n')
    failures.push({
      name: `${attr(open, 'classname')} ${attr(open, 'name')}`,
      message,
      seed: findSeed(message),
      artefacts: [],
    })
  }
  return { tests: total - skipped, failures }
}

/** Vitest's `--reporter=json` output. The test count is passed + failed (filtered-out tests are pending). */
export function parseVitestJson(json) {
  const report = JSON.parse(json)
  const failures = []
  for (const file of report.testResults ?? []) {
    const failed = file.assertionResults.filter((a) => a.status === 'failed')
    for (const a of failed) {
      const message = a.failureMessages.map(trimStack).join('\n')
      failures.push({ name: a.fullName, message, seed: findSeed(message), artefacts: [] })
    }
    // A file that fails to load has no assertion results, only a message.
    if (file.status === 'failed' && failed.length === 0) {
      failures.push({ name: file.name, message: trimStack(file.message ?? ''), artefacts: [] })
    }
  }
  return { tests: (report.numPassedTests ?? 0) + (report.numFailedTests ?? 0), failures }
}

const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted'])

/**
 * Playwright's `--reporter=json` report (docs/decisions/0020 §1, §3, §5, §6; a `playwright`
 * adapter entry of `scripts/lib/adapters.mjs`). `tests` counts one entry per spec x project (a
 * `@engines` spec run in three browsers is three tests); `warnings` comes from annotations of type
 * `warning` (M04's `Tracing.start` stall). `adapters`: the distinct `adapter.info` strings recorded
 * by `tests/browser/support/gpu.ts`'s `expectAdapter` (docs/plan/10-ci-workflow.md, Scope: "adapter
 * class recorded by every GPU test") -- deduped, since every GPU test on one run typically shares
 * the same adapter, so the runner's quiet-by-default log (0020 §2) still gets the string onto CI's
 * own log without one line per test.
 */
export function parsePlaywrightJson(json) {
  const report = JSON.parse(json)
  let tests = 0
  const failures = []
  const warnings = []
  const adapters = new Set()

  const walkSpec = (spec) => {
    for (const t of spec.tests ?? []) {
      tests++
      const project = t.projectName ? `[${t.projectName}] ` : ''
      const name = `${project}${spec.title}`
      const last = t.results?.at(-1)
      if (last && FAILED_STATUSES.has(last.status)) {
        const message =
          (last.errors ?? []).map((e) => e.message ?? String(e)).join('\n') || last.status
        const artefacts = (last.attachments ?? []).map((a) => a.path).filter(Boolean)
        failures.push({ name, message, seed: findSeed(message), artefacts })
      }
      for (const a of t.annotations ?? []) {
        if (a.type === 'warning') warnings.push(`${name}: ${a.description ?? ''}`)
        else if (a.type === 'adapter.info') adapters.add(a.description ?? '')
      }
    }
  }
  const walkSuite = (suite) => {
    for (const spec of suite.specs ?? []) walkSpec(spec)
    for (const child of suite.suites ?? []) walkSuite(child)
  }
  for (const suite of report.suites ?? []) walkSuite(suite)

  return { tests, failures, warnings, adapters: [...adapters] }
}

/** The message lines, then the first stack frame outside node_modules (where the test failed). */
function trimStack(message) {
  const lines = message.split('\n')
  const isFrame = (l) => /^\s+at /.test(l)
  const first = lines.findIndex(isFrame)
  if (first === -1) return message
  const own = lines.slice(first).find((l) => isFrame(l) && !l.includes('node_modules'))
  return [...lines.slice(0, first), ...(own ? [own] : [])].join('\n')
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : undefined
}

function unescapeXml(s) {
  return s
    .replaceAll(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replaceAll(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

export function stripAnsi(s) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  return s.replaceAll(/\x1b\[[0-9;]*m|\x0f/g, '')
}
