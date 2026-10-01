// `pnpm measure:rebuild [--reps N] [--timeout s]`: the 0020 §3 compile budget, "one-line Rust edit ->
// tests starting" (30 s), measured on this machine. For each of two files -- the engine crate's
// innermost module (`hash.rs`) and the reference `sim` crate's (`noise.rs`) -- append a unique comment
// to the first line, run `pnpm test unit` (the cheapest suite; the runner's build phase is what is
// read, from `test-results/build/timings.json`), restore the file, repeat N (default 5) times, print
// the median. Tracked files end byte-identical: restored in a `finally` and on SIGINT/SIGTERM, and
// the script exits non-zero if `git status` is not clean for them afterward. Each target gets one
// unmeasured warm-up run first. The 1-minute load average is printed beside every run: a number taken
// at foreign load is an upper bound (docs/plan/30b-rust-rebuild-quick-wins.md, timing discipline).
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { percentile } from './lib/timings.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d)
const reps = Number(opt('--reps', 5))
const only = opt('--only', '')
const timeoutMs = Number(opt('--timeout', 600)) * 1000

export const targets = [
  { name: 'engine hash.rs', file: 'packages/engine/crates/engine/src/hash.rs' },
  { name: 'reference sim noise.rs', file: 'games/reference/sim/src/noise.rs' },
]

const originals = new Map()
const restore = () => {
  for (const [file, text] of originals) writeFileSync(join(root, file), text)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

/** Fraction of CPU busy over one second: the load average counts this script's own cargo runs too. */
async function busyNow() {
  const snap = () =>
    cpus().reduce(
      (a, c) => [a[0] + c.times.idle, a[1] + Object.values(c.times).reduce((x, y) => x + y, 0)],
      [0, 0],
    )
  const a = snap()
  await new Promise((r) => setTimeout(r, 1000))
  const b = snap()
  return 1 - (b[0] - a[0]) / (b[1] - a[1])
}

/** Runs the cheap suite; resolves the runner's build-phase total and per-step ms. */
function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/test.mjs', 'unit'], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const { steps } = JSON.parse(
          readFileSync(join(root, 'test-results/build/timings.json'), 'utf8'),
        )
        resolve({ code, steps, ms: steps.reduce((n, s) => n + s.ms, 0) })
      } catch {
        resolve({ code, steps: [], ms: Number.NaN })
      }
    })
  })
}

const s = (ms) => `${(ms / 1000).toFixed(1)}s`
const summary = []
let failed = false
try {
  for (const target of targets.filter((t) => t.name.includes(only))) {
    const path = join(root, target.file)
    originals.set(target.file, readFileSync(path, 'utf8'))
    await runBuild() // warm: the previous target's edit, and `target/` itself, are settled
    const runs = []
    for (let i = 1; i <= reps; i++) {
      const text = originals.get(target.file)
      const nl = text.indexOf('\n')
      writeFileSync(path, `${text.slice(0, nl)} // measure-rebuild ${i}${text.slice(nl)}`)
      const load = loadavg()[0]
      const busy = await busyNow()
      const run = await runBuild()
      writeFileSync(path, text)
      runs.push({ ...run, load, busy })
      console.log(
        `${target.name} rep ${i}: build ${s(run.ms)} (${run.steps.map((x) => `${x.name} ${s(x.ms)}`).join(', ')}) exit ${run.code} load ${load.toFixed(1)} busy ${(busy * 100).toFixed(0)}%`,
      )
    }
    const names = runs[0]?.steps.map((x) => x.name) ?? []
    summary.push({
      name: target.name,
      median: percentile(
        runs.map((r) => r.ms),
        50,
      ),
      min: Math.min(...runs.map((r) => r.ms)),
      max: Math.max(...runs.map((r) => r.ms)),
      steps: names.map((n) => [
        n,
        percentile(
          runs.map((r) => r.steps.find((x) => x.name === n)?.ms ?? Number.NaN),
          50,
        ),
      ]),
      load: [Math.min(...runs.map((r) => r.load)), Math.max(...runs.map((r) => r.load))],
    })
  }
} finally {
  restore()
}
await runBuild() // leave `target/` warm for the unmodified tree
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...targets.map((t) => t.file)], {
  cwd: root,
  encoding: 'utf8',
}).trim()
if (dirty) {
  console.log(`tracked files changed:\n${dirty}`)
  failed = true
}
for (const t of summary) {
  const over = t.median > 30_000 ? ' OVER the 30 s compile budget' : ''
  console.log(
    `${t.name}: median ${s(t.median)} (min ${s(t.min)}, max ${s(t.max)}), load ${t.load[0].toFixed(1)}..${t.load[1].toFixed(1)}${over}; steps ${t.steps.map(([n, ms]) => `${n} ${s(ms)}`).join(', ')}`,
  )
}
process.exit(failed ? 1 : 0)
