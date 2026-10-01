// `pnpm test:timings [--runs K] [--timeout s] [--fresh] [--aggregate-only] [--dir d]`: K warm runs of
// the fast tier (`node scripts/test.mjs`, stdout untouched, 0020 §2), each reduced to a small JSON
// record under test-results/timings/, then aggregated: p95 per test, per-suite wall time against
// budget, build time, and the tests over the 0020 §4 p95 limits. Runs accumulate across calls (a Bash
// call is capped at 10 minutes): `--runs 4` three times gives twelve records; `--fresh` clears them.
// Each run records the 1-minute load average before it starts: a p95 taken under load is not evidence.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregate,
  parseVitestDuration,
  testsFromJunit,
  testsFromPlaywright,
  testsFromVitest,
} from './lib/timings.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d)
const dir = resolve(root, opt('--dir', 'test-results/timings'))
const runs = Number(opt('--runs', 10))
const timeoutMs = Number(opt('--timeout', 240)) * 1000

const results = join(root, 'test-results')
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

function collect(tmp, load, totalMs, exitCode) {
  const timing = JSON.parse(read(tmp))
  const suites = timing.suites.map((s) => {
    let tests = []
    let overhead = null
    if (s.suite === 'rust') {
      const xml = read(join(root, 'target/nextest/default/junit.xml'))
      tests = xml ? testsFromJunit(xml) : []
    } else if (s.suite === 'browser') {
      for (const f of ['report.json']) {
        const json = read(join(results, 'browser', f))
        if (json) tests.push(...testsFromPlaywright(json))
      }
    } else {
      const json = read(join(results, s.suite, 'report.json'))
      tests = json ? testsFromVitest(json) : []
      overhead = parseVitestDuration(read(join(results, s.suite, 'output.log')) ?? '')
    }
    return { ...s, tests, overhead }
  })
  return {
    load,
    totalMs,
    exitCode,
    buildMs: timing.buildMs,
    steps: JSON.parse(read(join(results, 'build', 'timings.json'))).steps,
    suites,
  }
}

function runOnce(i) {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.raw-${i}.json`)
  const load = loadavg()[0]
  return new Promise((done) => {
    const start = performance.now()
    const child = spawn(process.execPath, ['scripts/test.mjs', '--timings-json', tmp], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      const totalMs = performance.now() - start
      let record = null
      try {
        record = collect(tmp, load, totalMs, code)
      } catch (e) {
        console.log(`run ${i}: no usable report (${e.message})\n${out.slice(-600)}`)
      }
      rmSync(tmp, { force: true })
      if (record) {
        record.stdout = out
          .trim()
          .split('\n')
          .filter((l) => /^(rust|unit|wasm|netcode|browser|build)\b/.test(l))
        writeFileSync(join(dir, `run-${i}.json`), `${JSON.stringify(record)}\n`)
        console.log(
          `run ${i} exit ${code} load ${load.toFixed(1)} wall ${(totalMs / 1000).toFixed(1)}s | ${record.stdout.join(' | ')}`,
        )
      }
      done()
    })
  })
}

if (flag('--fresh')) rmSync(dir, { recursive: true, force: true })
const existing = () =>
  existsSync(dir) ? readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f)) : []
if (!flag('--aggregate-only')) {
  let next = existing().length + 1
  for (let k = 0; k < runs; k++) await runOnce(next++)
}

const records = existing().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
if (records.length === 0) {
  console.log('no runs recorded')
  process.exit(1)
}
const summary = aggregate(records)
writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
const s = (ms) => `${(ms / 1000).toFixed(2)}s`
console.log(
  `\n${summary.runs} runs, load ${summary.load.min.toFixed(1)}..${summary.load.max.toFixed(1)}; build p50 ${s(summary.build.p50)} p95 ${s(summary.build.p95)} max ${s(summary.build.max)}; whole \`pnpm test\` p50 ${s(summary.totalMs.p50)} max ${s(summary.totalMs.max)}`,
)
for (const suite of summary.suites) {
  const over = suite.budgetMs !== undefined && suite.wall.p95 > suite.budgetMs ? ' OVER' : ''
  console.log(
    `${suite.suite.padEnd(8)} wall p50 ${s(suite.wall.p50)} p95 ${s(suite.wall.p95)} max ${s(suite.wall.max)} / budget ${s(suite.budgetMs ?? 0)}${over}; test-time sum p50 ${s(suite.testSumMs.p50)}; ${suite.tests.length} tests; p95 limit ${suite.limitMs}ms: ${suite.offenders.length} over`,
  )
  for (const t of suite.offenders)
    console.log(`  OVER ${t.p95.toFixed(0)}ms (max ${t.max.toFixed(0)}) ${t.name}`)
  for (const t of suite.tests.slice(0, 5)) console.log(`  top ${t.p95.toFixed(0)}ms ${t.name}`)
}
const unit = records.map((r) => r.suites.find((x) => x.suite === 'unit')?.overhead).filter(Boolean)
if (unit.length > 0) console.log(`unit vitest footer (last run): ${JSON.stringify(unit.at(-1))}`)
