// Repository configuration that an ADR fixed and no behavioural test would notice changing: one
// `test(...)` per decision (docs/plan/39c-acceptance-gap-tests.md). Each asserts the literal value
// the ADR states, read from the file that carries it, so a loosened value fails here.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { buildBudgetMs, suites } from '../suites.mjs'
import { p95LimitMs } from './timings.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')

/** The lines of one `[section]` of a TOML file, up to the next `[header]`. */
function tomlSection(text, header) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === `[${header}]`)
  if (start < 0) throw new Error(`no [${header}] section`)
  const out = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break
    if (line.trim() !== '' && !line.trim().startsWith('#')) out.push(line.trim())
  }
  return out
}

describe('repo-config', () => {
  test('repo-config: Cargo.lock is tracked by git and not ignored (0002 Consequences)', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'Cargo.lock'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    expect(tracked).toBe('Cargo.lock')
    expect(
      read('.gitignore')
        .split('\n')
        .map((l) => l.trim()),
    ).not.toContain('Cargo.lock')
    expect(read('Cargo.lock')).toMatch(/^name = "engine"$/m)
  })

  test('repo-config: engine crate runtime dependencies are serde, postcard, serde_json and ts-rs, alloc-only (0003, 0017 §7)', () => {
    const deps = tomlSection(read('packages/engine/crates/engine/Cargo.toml'), 'dependencies')
    const byName = Object.fromEntries(deps.map((l) => [l.split(/\s*=/)[0], l]))
    expect(Object.keys(byName).sort()).toEqual(['postcard', 'serde', 'serde_json', 'ts-rs'])
    expect(byName.serde_json).toBe(
      'serde_json = { version = "1", default-features = false, features = ["alloc"] }',
    )
    expect(byName.postcard).toBe(
      'postcard = { version = "1", default-features = false, features = ["alloc"] }',
    )
    expect(byName.serde).toMatch(/^serde = \{ version = "1", default-features = false,/)
  })

  // Spec testing R5: all tests run in under a minute. `pnpm test` runs the `first` suite alone, then
  // every other fast-tier suite concurrently, so its budgeted length is the first suite's budget plus
  // the longest of the rest (the build steps carry their own 10 s warning budget, apart). The literal
  // budgets are those of 0020 §3 as amended (0033, 0036 §1): a loosened one fails here.
  test('repo-config: the fast tier is budgeted under one minute', () => {
    const fast = suites.filter((s) => s.tiers.includes('fast'))
    expect(Object.fromEntries(fast.map((s) => [s.name, s.budgetMs]))).toEqual({
      rust: 10_000,
      unit: 3_000,
      wasm: 7_000,
      tools: 4_000,
      netcode: 10_000,
      browser: 48_000,
    })
    const alone = fast.filter((s) => s.first).reduce((n, s) => n + s.budgetMs, 0)
    const concurrent = Math.max(...fast.filter((s) => !s.first).map((s) => s.budgetMs))
    expect(alone + concurrent).toBe(51_000)
    expect(alone + concurrent).toBeLessThan(60_000)
    expect(buildBudgetMs).toBeLessThanOrEqual(10_000)
  })

  // Spec testing R8 / 0020 §10: CI is GitHub Actions on Linux with a software WebGPU adapter; both
  // tiers run on every push; timings are recorded and never gate (`--budget-scale 1000`).
  test('repo-config: CI runs both tiers on ubuntu-latest with SwiftShader and never gates on time (0020 §10)', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:/m)
    expect(ci).toMatch(/^ {4}runs-on: ubuntu-latest$/m)
    expect(ci.match(/runs-on:/g)).toHaveLength(1)
    const step = (name) => {
      const at = ci.indexOf(`- name: ${name}\n`)
      expect(at, `step ${name}`).toBeGreaterThan(-1)
      const next = ci.indexOf('\n      - name:', at + 1)
      return ci.slice(at, next < 0 ? undefined : next)
    }
    const fast = step('pnpm test')
    const slow = step('pnpm test:slow')
    expect(fast).toContain('ENGINE_GPU: swiftshader')
    expect(slow).toContain('ENGINE_GPU: swiftshader')
    expect(fast).toContain(
      'run: pnpm test --budget-scale 1000 --timings-json test-results/timings.json',
    )
    expect(slow).toContain(
      'run: pnpm test:slow --budget-scale 1000 --timings-json test-results/timings-slow.json',
    )
  })

  // 0020 §6 (spike B): the software adapter is a branch of the Playwright config.
  test('repo-config: the SwiftShader branch of playwright.config.ts picks the headless shell and the five software-adapter flags', () => {
    const config = read('packages/engine/playwright.config.ts')
    expect(config).toContain(
      "process.env.ENGINE_GPU === 'swiftshader' ? 'chromium-headless-shell' : 'chromium'",
    )
    const block =
      /const swiftshaderArgs =\s*process\.env\.ENGINE_GPU === 'swiftshader'\s*\? \[([^\]]*)\]\s*: \[\]/.exec(
        config,
      )
    expect(block, 'the swiftshaderArgs branch').not.toBeNull()
    const flags = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(flags).toEqual([
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader',
      '--disable-vulkan-surface',
    ])
    expect(config).toContain(
      "launchOptions: { args: ['--enable-unsafe-webgpu', ...swiftshaderArgs] }",
    )
  })

  // 0031 §1: five workers, measured faster than three; shared by `chromium`, `gc` and `engines`.
  test('repo-config: playwright.config.ts runs five workers (0031 §1)', () => {
    const config = read('packages/engine/playwright.config.ts')
    expect([...config.matchAll(/^\s*workers:\s*(\d+),/gm)].map((m) => m[1])).toEqual(['5'])
  })

  // 0033 §1: the build-step warning budget is 10 s (it was 30 s).
  test('repo-config: buildBudgetMs is 10000 (0033 §1)', () => {
    expect(buildBudgetMs).toBe(10_000)
  })

  // 0033 §2 as amended by 0048 §2: `unit` is the one suite that runs alone before the others start.
  test('repo-config: unit alone runs first, before the concurrent suites (0033 §2)', () => {
    expect(suites.filter((s) => s.first === true).map((s) => s.name)).toEqual(['unit'])
    const runner = read('scripts/test.mjs')
    const firstRun = runner.indexOf(
      'for (const suite of first) outcomes.push(await runSuite(suite, opts))',
    )
    const concurrentRun = runner.indexOf('await Promise.all(concurrent.map(')
    expect(firstRun, 'the first-suite loop').toBeGreaterThan(-1)
    expect(concurrentRun, 'the concurrent run').toBeGreaterThan(firstRun)
    expect(runner).toContain(
      'const concurrent = selected.filter((s) => !isSolo(s) && !first.includes(s))',
    )
  })

  // 0036 §2: the 0020 §4 per-test p95 limits. `pnpm test:timings` only reports against them, so the
  // literals are pinned here.
  test('repo-config: per-test p95 limits are 500 ms for Rust and Node and 3 s for the browser (0036 §2)', () => {
    expect(p95LimitMs).toEqual({ rust: 500, unit: 500, wasm: 500, netcode: 500, browser: 3_000 })
  })

  // 0045 §1: the shipped profile trades compile time for size and speed.
  test('repo-config: [profile.release] is opt-level 3, fat LTO, one codegen unit, abort, stripped (0045 §1)', () => {
    expect(tomlSection(read('Cargo.toml'), 'profile.release')).toEqual([
      'opt-level = 3',
      'lto = "fat"',
      'codegen-units = 1',
      'panic = "abort"',
      'strip = true',
    ])
  })

  // 0045 §3 (line tables only) and 0048 §3 (packed debuginfo, amends 0045 §3).
  test('repo-config: [profile.dev] keeps line-tables-only debug and packed split-debuginfo (0045 §3, 0048 §3)', () => {
    const dev = tomlSection(read('Cargo.toml'), 'profile.dev')
    expect(dev).toContain('debug = "line-tables-only"')
    expect(dev).toContain('split-debuginfo = "packed"')
  })

  // 0017 §10: exact pins. The Rust channel is a full release, and no devDependency carries a range.
  test('repo-config: toolchain pins are exact: Rust 1.93.0, Node >= 22.18, pnpm 11.x, no ranges in devDependencies (0017 §10)', () => {
    const toolchain = tomlSection(read('rust-toolchain.toml'), 'toolchain')
    expect(toolchain.find((l) => l.startsWith('channel'))).toMatch(/^channel = "1\.93\.0"/)
    const rootPkg = JSON.parse(read('package.json'))
    expect(rootPkg.engines.node).toBe('>=22.18')
    expect(rootPkg.packageManager).toMatch(/^pnpm@11\.\d+\.\d+$/)
    const manifests = [
      'package.json',
      'packages/engine/package.json',
      'games/reference/package.json',
      'games/reference-server/package.json',
    ]
    let checked = 0
    for (const rel of manifests) {
      const dev = JSON.parse(read(rel)).devDependencies ?? {}
      for (const [name, version] of Object.entries(dev)) {
        checked++
        expect(version, `${rel} devDependencies.${name}`).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
      }
    }
    expect(checked).toBeGreaterThan(5)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toMatch(/^lockfileVersion:/m)
  })

  describe('repo-config: vite plugin runtime imports (0017 §1, spec R9)', () => {
    const entry = join(root, 'packages/engine/src/vite.ts')
    const pkg = JSON.parse(read('packages/engine/package.json'))

    /** Every module reachable from `file` by relative imports, with its non-type specifiers. */
    function closure(file, seen = new Map()) {
      if (seen.has(file)) return seen
      const text = readFileSync(file, 'utf8')
      const runtime = []
      for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+'([^']+)'/gms)) {
        runtime.push(m[1])
      }
      for (const m of text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) runtime.push(m[1])
      for (const m of text.matchAll(/^import\s+'([^']+)'/gm)) runtime.push(m[1])
      seen.set(file, runtime)
      for (const spec of runtime) {
        if (spec.startsWith('.'))
          closure(resolve(dirname(file), spec.replace(/\.js$/, '.ts')), seen)
      }
      return seen
    }

    test('repo-config: vite plugin runtime imports are node: built-ins, relative files, or vite as the host', () => {
      const graph = closure(entry)
      expect(graph.size).toBeGreaterThan(1)
      const bad = []
      for (const [file, specs] of graph) {
        for (const spec of specs) {
          if (spec.startsWith('node:') || spec.startsWith('.')) continue
          // The one allowed non-built-in: the dynamic `import('vite')` in `fsAllow`, guarded by try/catch.
          if (spec === 'vite' && file === entry) continue
          bad.push(`${file.slice(root.length)}: ${spec}`)
        }
      }
      expect(bad, 'src/vite.ts must reach nothing but Node built-ins at run time').toEqual([])
      const viteRuntime = [...graph].filter(([, specs]) => specs.includes('vite'))
      expect(viteRuntime.map(([f]) => f)).toEqual([entry])
      expect(readFileSync(entry, 'utf8')).toMatch(/^import type \{[^}]*\} from 'vite'$/m)
    })

    test('repo-config: engine package has no dependencies and vite is an optional peer', () => {
      expect(pkg.dependencies).toEqual({})
      expect(pkg.peerDependencies).toEqual({ vite: '^8.0.0' })
      expect(pkg.peerDependenciesMeta).toEqual({ vite: { optional: true } })
    })
  })
})
