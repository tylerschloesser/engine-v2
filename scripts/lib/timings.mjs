// Pure half of `pnpm test:timings` (M36b: turn the reports
// `pnpm test` already writes into per-test durations, and K runs of those into percentiles. No I/O.
import { parseVitestDuration } from './timings-vitest.mjs'

export { parseVitestDuration }

/** 0020 §4 p95 limits for a fast-tier test: Rust and Node 0.5 s, browser 3 s. */
export const p95LimitMs = { rust: 500, unit: 500, wasm: 500, netcode: 500, browser: 3_000 }

/** Nearest-rank percentile of a numeric array (`p` in 0..100); NaN for an empty one. */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

/** nextest JUnit: `[{ name: '<binary> <test>', ms }]`. */
export function testsFromJunit(xml) {
  const out = []
  for (const [tag] of xml.matchAll(/<testcase\b[^>]*>/g)) {
    out.push({
      name: `${attr(tag, 'classname')} ${attr(tag, 'name')}`,
      ms: Number(attr(tag, 'time')) * 1000,
    })
  }
  return out
}

/** Vitest `--reporter=json`: one entry per test, named `<file basename>: <fullName>`. */
export function testsFromVitest(json) {
  const out = []
  for (const file of JSON.parse(json).testResults ?? []) {
    const base = file.name.split('/').slice(-1)[0]
    for (const a of file.assertionResults ?? []) {
      if (a.status === 'passed' || a.status === 'failed') {
        out.push({ name: `${base}: ${a.fullName}`, ms: a.duration ?? 0 })
      }
    }
  }
  return out
}

/** Playwright JSON: one entry per spec x project, the last attempt's duration. */
export function testsFromPlaywright(json) {
  const out = []
  const walkSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1)
        if (last)
          out.push({ name: `[${t.projectName}] ${spec.file}: ${spec.title}`, ms: last.duration })
      }
    }
    for (const child of suite.suites ?? []) walkSuite(child)
  }
  for (const suite of JSON.parse(json).suites ?? []) walkSuite(suite)
  return out
}

/**
 * One run's record: `suites` is `[{ suite, ms, budgetMs, tests: [{ name, ms }], overhead? }]`.
 * `aggregate(runs)`: per-suite wall p50/p95/max, per-test p95/max over the runs it appears in, build
 * ms, and the offenders (a test whose p95 is over its suite's `p95LimitMs`).
 */
export function aggregate(runs) {
  const build = runs.map((r) => r.buildMs)
  const names = [...new Set(runs.flatMap((r) => r.suites.map((s) => s.suite)))]
  const suites = names.map((name) => {
    const seen = runs.flatMap((r) => r.suites.filter((s) => s.suite === name))
    const byTest = new Map()
    for (const s of seen) {
      for (const t of s.tests) {
        if (!byTest.has(t.name)) byTest.set(t.name, [])
        byTest.get(t.name).push(t.ms)
      }
    }
    const tests = [...byTest].map(([testName, ms]) => ({
      name: testName,
      n: ms.length,
      p95: percentile(ms, 95),
      max: Math.max(...ms),
    }))
    tests.sort((a, b) => b.p95 - a.p95)
    const limit = p95LimitMs[name]
    const wall = seen.map((s) => s.ms)
    const testSum = seen.map((s) => s.tests.reduce((n, t) => n + t.ms, 0))
    return {
      suite: name,
      budgetMs: seen[0]?.budgetMs,
      wall: { p50: percentile(wall, 50), p95: percentile(wall, 95), max: Math.max(...wall) },
      testSumMs: { p50: percentile(testSum, 50) },
      tests,
      limitMs: limit,
      offenders: limit === undefined ? [] : tests.filter((t) => t.p95 > limit),
    }
  })
  return {
    runs: runs.length,
    load: { min: Math.min(...runs.map((r) => r.load)), max: Math.max(...runs.map((r) => r.load)) },
    build: { p50: percentile(build, 50), p95: percentile(build, 95), max: Math.max(...build) },
    totalMs: {
      p50: percentile(runs.map((r) => r.totalMs).filter(Number.isFinite), 50),
      max: Math.max(...runs.map((r) => r.totalMs).filter(Number.isFinite)),
    },
    suites,
  }
}
