// `pnpm test [suite] [-t pattern]`: build, then run every selected suite in parallel, quietly.
// Output contract: docs/decisions/0020 §2. Suites and build steps: scripts/suites.mjs.
// Exit codes: 0 all pass (warnings allowed); 1 test, suite-budget or build failure; 2 usage or
// missing tool.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapters } from './lib/adapters.mjs'
import { parseArgs, usage } from './lib/args.mjs'
import { toolEnv } from './lib/env.mjs'
import {
  buildStepsReport,
  buildTimingsReport,
  classifyBudget,
  formatAdapter,
  formatBuildWarning,
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
  const stepTimings = []
  for (const step of buildSteps) {
    const log = join(results, 'build', `${step.name}.log`)
    const { code, ms } = await run(step.cmd, step.args, {
      log,
      cwd: resolve(root, step.cwd ?? '.'),
      env: toolEnv(),
    })
    buildMs += ms
    stepTimings.push({ name: step.name, ms })
    if (code !== 0) {
      console.log(`build FAIL ${step.name}\n${lastLines(readLog(log), 40)}\n${log}`)
      return 1
    }
  }
  // Every run, pass or WARN: a step's own wall time, so a slow build is attributable without
  // re-running under a stopwatch (docs/plan/17d-fast-tier-wall-time.md step 1).
  mkdirSync(join(results, 'build'), { recursive: true })
  writeFileSync(
    join(results, 'build', 'timings.json'),
    `${JSON.stringify(buildStepsReport(stepTimings), null, 2)}\n`,
  )
  // stderr, never a failure: the runner cannot tell a cold build from a warm one.
  if (classifyBudget(buildMs, buildBudgetMs, opts.scale) !== 'pass') {
    console.error(formatBuildWarning(buildMs, buildBudgetMs, opts.scale, stepTimings))
  }

  // Phase 2: every selected suite at once, except a `solo: true` suite (docs/plan/
  // 17b-sprites-and-frame-budget.md, Fix round 2: a frame-time gate cannot share the machine with a
  // parallel Playwright worker pool) -- those run one at a time, afterward, each with every other
  // suite's own process already finished. `selected`'s own registration order is preserved either
  // way (`suites.mjs` lists every `solo` suite after the ones it must not race), so this changes
  // scheduling, not the reported order.
  const concurrent = selected.filter((s) => !s.solo)
  const solo = selected.filter((s) => s.solo)
  const outcomes = await Promise.all(concurrent.map((suite) => runSuite(suite, opts)))
  for (const suite of solo) {
    outcomes.push(await runSuite(suite, opts))
  }

  // Phase 3: one line per suite in registration order, then one block per failure.
  const nameWidth = Math.max(...selected.map((s) => s.name.length))
  let failed = false
  for (const { suite, tests, failures, warnings, adapters, ms } of outcomes) {
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
    for (const adapter of adapters ?? []) console.log(formatAdapter(adapter))
  }
  for (const { suite, failures } of outcomes) {
    for (const failure of failures) console.log(formatFailure({ suite: suite.name, ...failure }))
  }

  if (opts.timingsJson) writeTimingsJson(opts.timingsJson, { buildMs, outcomes })

  return failed ? 1 : 0
}

/** `--timings-json <path>`: recorded, never gating (docs/decisions/0020 §10). Written whether or
 * not the run passed, so a failing CI run still uploads its timings. */
function writeTimingsJson(path, { buildMs, outcomes }) {
  const report = buildTimingsReport({ commit: gitCommit(), cpu: cpuModel(), buildMs, outcomes })
  const out = resolve(root, path)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function cpuModel() {
  return cpus()[0]?.model ?? null
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
    // Deduped again across legs (docs/plan/10-ci-workflow.md): the `chromium` and `gc` legs of the
    // `browser` suite typically see the same adapter.
    adapters: [...new Set(parts.flatMap((part) => part.adapters ?? []))],
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
  const result = adapter.parse({ tier: opts.tier, reportPath: report, exitCode: code, logPath })
  // Gate round 1 fix (docs/plan/20-reference-game-v0.md): a failure's own `name` (what
  // `formatFailure` prints as `FAIL <suite> <name>`) never otherwise says *which leg* of a
  // multi-leg suite it came from -- `suite` there is always the top-level suite name (`runSuite`'s
  // own `suite.name`), the same for every leg. Tag it here, once, for every leg with its own name
  // distinct from the suite's (an extra `legs` entry, e.g. `engines`/`bun`; the suite's own main
  // leg needs no tag, it already reads as `browser: ...`).
  if (leg.name !== suite.name && result.failures.length > 0) {
    result.failures = result.failures.map((f) => ({ ...f, name: `${leg.name}: ${f.name}` }))
  }
  return result
}

process.exit(await main())
