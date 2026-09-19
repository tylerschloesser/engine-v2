// `pnpm test [suite] [-t pattern]`: build, then run every selected suite in parallel, quietly.
// Output contract: docs/decisions/0020 §2. Suites and build steps: scripts/suites.mjs.
// Exit codes: 0 all pass (warnings allowed); 1 test, suite-budget or build failure; 2 usage or
// missing tool.
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapters } from './lib/adapters.mjs'
import { parseArgs, usage } from './lib/args.mjs'
import { toolEnv } from './lib/env.mjs'
import {
  classifyBudget,
  formatDuration,
  formatFailure,
  formatSuiteLine,
  formatWarning,
} from './lib/report.mjs'
import { lastLines, readLog, run } from './lib/run.mjs'
import { probeTool, TOOLS } from './setup-tools.mjs'
import { buildBudgetMs, buildSteps, suites } from './suites.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const results = join(root, 'test-results')

async function main() {
  const names = suites.map((s) => s.name)
  const opts = parseArgs(process.argv.slice(2), names)
  if (opts.error) {
    console.log(`${opts.error}\n${usage(names)}`)
    return 2
  }

  const selected = suites.filter(
    (s) => s.tiers.includes(opts.tier) && (opts.suite === undefined || s.name === opts.suite),
  )
  if (selected.length === 0) {
    console.log(`${opts.tier}: no suites registered`)
    return 0
  }

  // Phase 0: clear old artefacts, probe pinned tools.
  for (const dir of ['build', ...selected.map((s) => s.name)]) {
    rmSync(join(results, dir), { recursive: true, force: true })
  }
  for (const tool of TOOLS.filter((t) => t.pin)) {
    const found = await probeTool(tool)
    if (found !== tool.pin) {
      console.log(`${tool.name} ${found ?? 'missing'}, need ${tool.pin}: run pnpm setup:tools`)
      return 2
    }
  }

  // Phase 1: build steps, in order.
  let buildMs = 0
  for (const step of buildSteps) {
    const log = join(results, 'build', `${step.name}.log`)
    const { code, ms } = await run(step.cmd, step.args, {
      log,
      cwd: resolve(root, step.cwd ?? '.'),
      env: toolEnv(),
    })
    buildMs += ms
    if (code !== 0) {
      console.log(`build FAIL ${step.name}\n${lastLines(readLog(log), 40)}\n${log}`)
      return 1
    }
  }
  // stderr, never a failure: the runner cannot tell a cold build from a warm one.
  if (classifyBudget(buildMs, buildBudgetMs, opts.scale) !== 'pass') {
    console.error(
      `build WARN ${formatDuration(buildMs)}/${formatDuration(buildBudgetMs * opts.scale)}`,
    )
  }

  // Phase 2: every selected suite at once.
  const outcomes = await Promise.all(selected.map((suite) => runSuite(suite, opts)))

  // Phase 3: one line per suite in registration order, then one block per failure.
  const nameWidth = Math.max(...selected.map((s) => s.name.length))
  let failed = false
  for (const { suite, tests, failures, warnings, ms } of outcomes) {
    const budgetMs = opts.tier === 'fast' ? suite.budgetMs : undefined
    const overBudget = budgetMs !== undefined && classifyBudget(ms, budgetMs, opts.scale) === 'fail'
    failed ||= failures.length > 0 || overBudget
    console.log(
      formatSuiteLine({
        name: suite.name,
        failed: failures.length > 0,
        tests,
        ms,
        budgetMs,
        scale: opts.scale,
        nameWidth,
      }),
    )
    for (const warning of warnings) console.log(formatWarning(warning))
  }
  for (const { suite, failures } of outcomes) {
    for (const failure of failures) console.log(formatFailure({ suite: suite.name, ...failure }))
  }
  return failed ? 1 : 0
}

/** A suite is its own adapter run plus one run per entry of `suite.legs`, reported as one line. */
async function runSuite(suite, opts) {
  const legs = [
    { ...suite, log: 'output.log' },
    ...(suite.legs ?? []).map((leg) => ({ ...leg, log: `${leg.name}.log` })),
  ]
  const start = performance.now()
  const parts = await Promise.all(legs.map((leg) => runLeg(suite, leg, opts)))
  return {
    suite,
    ms: performance.now() - start,
    tests: parts.reduce((n, part) => n + part.tests, 0),
    failures: parts.flatMap((part) => part.failures),
    warnings: parts.flatMap((part) => part.warnings ?? []),
  }
}

async function runLeg(suite, leg, opts) {
  const adapter = adapters[leg.kind]
  const outDir = join('test-results', suite.name)
  const logPath = join(results, suite.name, leg.log)
  const command = adapter.command({
    suite: leg,
    pattern: opts.pattern,
    tier: opts.tier,
    outDir,
  })
  if (command === null) return { tests: 0, failures: [] }
  const { cmd, args, env, reportPath } = command
  const report = reportPath === null ? null : resolve(root, reportPath)
  if (report) rmSync(report, { force: true })
  const { code } = await run(cmd, args, {
    log: logPath,
    cwd: resolve(root, suite.cwd ?? '.'),
    env: {
      ...toolEnv(),
      ...suite.env,
      ...env,
      ...(opts.selfCheckFail ? { RUNNER_SELF_CHECK: 'fail' } : {}),
    },
  })
  return adapter.parse({ tier: opts.tier, reportPath: report, exitCode: code, logPath })
}

process.exit(await main())
