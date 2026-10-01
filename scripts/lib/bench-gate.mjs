// The wall-clock benchmark gate (docs/decisions/0020 §9, §10; docs/plan/36-slow-tier-and-
// benchmarks.md step 5). One helper for every benchmark that has a checked-in baseline in
// `packages/engine/baselines/<name>.json`:
//
//   gate(name, sample, { warnOnly?, suite? })   a sample is `{ metric: number }`, lower is better
//
// The 25 % rule applies only when the machine fingerprint (`os.cpus()[0].model` + `os.arch()`)
// equals the baseline's: then a *gated* metric more than 25 % over its baseline, or over its
// absolute `limits` figure (the desktop proxies of 0010 and 0018 §9), fails (throws), unless
// `warnOnly` (the record-only Node twin), which prints a `warn:` line instead. Under any other
// fingerprint nothing fails (CI never matches: "timings are recorded, never gating"). Every call
// records `test-results/<suite>/bench/<name>.json` (default suite `bench`); `pnpm bench:baseline
// [name]` promotes the most recent such record taken on this machine to the baseline, an explicit
// command whose diff is reviewed.
//
// From Rust or a shell: `node scripts/lib/bench-gate.mjs check <name> <suite>` reads the sample JSON
// on stdin. A browser bench imports `gate` directly.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 0020 §9. */
export const TOLERANCE = 0.25

const root = fileURLToPath(new URL('../..', import.meta.url))
const baselinesDir = join(root, 'packages/engine/baselines')

/**
 * What a baseline starts from: which metrics gate (the others only warn), and the absolute proxy
 * (`limits`, in the metric's own unit) of the ADR that owns it. Used when `bench:baseline` writes a
 * baseline that does not exist yet; afterwards the baseline file's own copy rules.
 */
export const BENCHES = {
  // 0010 "Tick CPU budget": median <= 3 ms on Tyler's Mac, native, on the standard large save.
  tick: { gated: ['medianMs'], limits: { medianMs: 3 } },
  // 0018 §9 desktop proxies of the reference game on the large save (main rAF callback, client worker).
  'frame-reference': { gated: ['mainP50Ms', 'workerP50Ms'], limits: {} },
  // The record-only Node twin of `tick` (`.wasm` through `createWorldServer`): warn-only at its call site.
  'tick-node': { gated: ['medianMs'], limits: {} },
  // M17b's synthetic worst-case DrawList.
  frame: { gated: ['mainP50Ms', 'workerP50Ms'], limits: {} },
  // 0008 §6: ms per generated chunk of the reference game, release, native.
  worldgen: { gated: ['medianMsPerChunk'], limits: {} },
}

/** Where this machine stands: no environment variable to forget. */
export function fingerprint() {
  return { cpu: cpus()[0]?.model ?? 'unknown', arch: arch() }
}

export function sameMachine(a, b) {
  return Boolean(a && b) && a.cpu === b.cpu && a.arch === b.arch
}

/**
 * Pure: what the gate says about `sample` against `baseline` on a machine with `fp`.
 * `{ matched, failures, warnings }`; `failures` is empty unless the fingerprints match.
 */
export function decide({ baseline, sample, fp, warnOnly = false }) {
  const out = { matched: sameMachine(baseline?.fingerprint, fp), failures: [], warnings: [] }
  if (!baseline) return out
  const gated = new Set(baseline.gated ?? [])
  const limits = baseline.limits ?? {}
  for (const [metric, base] of Object.entries(baseline.metrics ?? {})) {
    const value = sample[metric]
    if (typeof value !== 'number') continue
    const over = value > base * (1 + TOLERANCE)
    const limit = limits[metric]
    const overLimit = typeof limit === 'number' && value > limit
    const messages = []
    if (over) {
      messages.push(
        `${metric} ${fmt(value)} is ${((value / base - 1) * 100).toFixed(0)}% over its baseline ${fmt(base)} (limit ${TOLERANCE * 100}%)`,
      )
    }
    if (overLimit) messages.push(`${metric} ${fmt(value)} exceeds the desktop proxy ${fmt(limit)}`)
    for (const m of messages) {
      // Not gated, or another machine, or warn-only: a warning at most, and only on a match.
      if (!out.matched) continue
      if (gated.has(metric) && !warnOnly) out.failures.push(m)
      else out.warnings.push(m)
    }
  }
  return out
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(3)
}

export function baselinePath(name) {
  return join(baselinesDir, `${name}.json`)
}

export function readBaseline(name) {
  const path = baselinePath(name)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

/**
 * Records `sample` and applies the gate. Throws `Error` listing the failures; otherwise returns
 * `{ matched, failures: [], warnings }` and prints each warning as a `warn:` line.
 */
export function gate(name, sample, { warnOnly = false, suite = 'bench' } = {}) {
  const fp = fingerprint()
  const baseline = readBaseline(name)
  const verdict = decide({ baseline, sample, fp, warnOnly })
  const dir = join(root, 'test-results', suite, 'bench')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify(
      {
        name,
        fingerprint: fp,
        measuredAt: new Date().toISOString(),
        metrics: sample,
        gate: verdict,
      },
      null,
      2,
    )}\n`,
  )
  const how = !baseline
    ? 'no baseline: recorded'
    : verdict.matched
      ? `gated against baselines/${name}.json`
      : `recorded only (this machine is not the baseline's: ${fp.cpu} ${fp.arch})`
  console.log(`bench ${name}: ${JSON.stringify(sample)} (${how})`)
  for (const w of verdict.warnings) console.log(`warn: bench ${name}: ${w}`)
  if (verdict.failures.length > 0) {
    throw new Error(`bench ${name}: ${verdict.failures.join('; ')}`)
  }
  return verdict
}

/** The newest `test-results/<suite>/bench/<name>.json`, or null. */
export function latestRecord(name) {
  let best = null
  const results = join(root, 'test-results')
  if (!existsSync(results)) return null
  for (const suite of readdirSync(results)) {
    const path = join(results, suite, 'bench', `${name}.json`)
    if (!existsSync(path)) continue
    const mtime = statSync(path).mtimeMs
    if (!best || mtime > best.mtime) best = { path, mtime }
  }
  return best ? { path: best.path, ...JSON.parse(readFileSync(best.path, 'utf8')) } : null
}

/**
 * `pnpm bench:baseline [name]`: rewrite `baselines/<name>.json` from the most recent record of that
 * benchmark, which must have been taken on this machine. `gated`, `limits` and `conditions` carry
 * over from the existing baseline (or `BENCHES`); the metrics, fingerprint and date are replaced.
 */
export function promote(name) {
  const record = latestRecord(name)
  if (!record)
    throw new Error(
      `bench:baseline ${name}: no record under test-results/*/bench/; run the benchmark first`,
    )
  const fp = fingerprint()
  if (!sameMachine(record.fingerprint, fp)) {
    throw new Error(
      `bench:baseline ${name}: the latest record (${record.path}) was taken on another machine`,
    )
  }
  const old = readBaseline(name)
  const defaults = BENCHES[name] ?? { gated: [], limits: {} }
  const next = {
    name,
    fingerprint: fp,
    measuredAt: record.measuredAt,
    conditions: old?.conditions ?? '',
    gated: old?.gated ?? defaults.gated,
    limits: old?.limits ?? defaults.limits,
    ...Object.fromEntries(
      Object.entries(old ?? {}).filter(
        ([k]) =>
          ![
            'name',
            'fingerprint',
            'measuredAt',
            'conditions',
            'gated',
            'limits',
            'metrics',
          ].includes(k),
      ),
    ),
    metrics: record.metrics,
  }
  mkdirSync(baselinesDir, { recursive: true })
  writeFileSync(baselinePath(name), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

async function main(argv) {
  const [cmd, name, suite] = argv
  if (cmd === 'check') {
    const text = readFileSync(0, 'utf8')
    try {
      gate(name, JSON.parse(text), {
        suite: suite ?? 'bench',
        warnOnly: process.env.BENCH_WARN_ONLY === '1',
      })
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e))
      return 1
    }
    return 0
  }
  if (cmd === 'baseline') {
    const names = name ? [name] : Object.keys(BENCHES).filter((n) => latestRecord(n))
    if (names.length === 0)
      throw new Error('bench:baseline: no benchmark records found; run a benchmark first')
    for (const n of names) {
      const next = promote(n)
      console.log(
        `baselines/${n}.json: ${JSON.stringify(next.metrics)} on ${next.fingerprint.cpu} ${next.fingerprint.arch}`,
      )
    }
    return 0
  }
  console.error(
    'usage: bench-gate.mjs check <name> [suite] < sample.json | bench-gate.mjs baseline [name]',
  )
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)))
}
