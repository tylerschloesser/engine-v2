// `pnpm lint`: the four check rows of the command table in docs/decisions/0017 §10, in parallel,
// quiet on success (0020 §2). No budgets: clippy and tsc compile.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolEnv } from './lib/env.mjs'
import { formatDuration, stripAnsi } from './lib/report.mjs'
import { firstLines, readLog, run } from './lib/run.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'test-results', 'lint')

/** `fix` is the command of the same table that repairs the failure, where one exists. */
export const CHECKS = [
  {
    name: 'biome',
    cmd: 'pnpm',
    args: ['exec', 'biome', 'check', '.'],
    fix: 'pnpm exec biome check --write .',
  },
  { name: 'rustfmt', cmd: 'cargo', args: ['fmt', '--check'], fix: 'cargo fmt' },
  {
    name: 'clippy',
    cmd: 'cargo',
    args: ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
  },
  // A package opts in to type-checking by having a `typecheck` script.
  { name: 'tsc', cmd: 'pnpm', args: ['-r', 'run', 'typecheck'] },
]

async function main() {
  rmSync(outDir, { recursive: true, force: true })
  const outcomes = await Promise.all(
    CHECKS.map(async (check) => {
      const log = join(outDir, `${check.name}.log`)
      const { code, ms } = await run(check.cmd, check.args, { log, cwd: root, env: toolEnv() })
      return { check, code, ms, log }
    }),
  )
  const width = Math.max(...CHECKS.map((c) => c.name.length))
  for (const { check, code, ms } of outcomes) {
    console.log(`${check.name.padEnd(width)} ${code === 0 ? 'pass' : 'FAIL'} ${formatDuration(ms)}`)
  }
  for (const { check, code, log } of outcomes) {
    if (code === 0) continue
    const body = firstLines(stripAnsi(readLog(log)), 40).replaceAll(/^/gm, '  ')
    console.log(`\nFAIL ${check.name}\n${body}\n  log: ${log}`)
    if (check.fix) console.log(`  fix: ${check.fix}`)
  }
  return outcomes.some((o) => o.code !== 0) ? 1 : 0
}

process.exit(await main())
