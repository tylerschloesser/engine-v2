// `pnpm gc [software|flat|reliability] [-t pattern]` (docs/plan/04-zero-gc-harness.md, Seams): local
// invocations of the `gc` Playwright project that `pnpm test` never runs itself. With no mode: the
// `gc` project once, hardware/tunnel (the default `measure()` uses), for local iteration. `software`
// sets `GC_MODE=software` (the software-adapter arithmetic of 0016 caveat b). `flat` sets
// `GC_CDP=flat` (the flattened-session transport, Planning decisions "CDP transport"). `reliability`
// runs `--repeat-each`: clean x50, every negative control x15, on 4 workers (Order of work step 6) --
// long-running, never part of `pnpm test`. A plain wrapper (not `scripts/test.mjs`'s quiet
// contract): output streams straight from `playwright test`.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { toolEnv } from './lib/env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const configPath = 'packages/engine/playwright.config.ts'
const MODES = ['software', 'flat', 'reliability']

function parseArgs(argv) {
  const opts = { mode: undefined, pattern: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-t') {
      opts.pattern = argv[++i]
      if (opts.pattern === undefined) return { error: '-t needs a pattern' }
    } else if (arg.startsWith('-')) {
      return { error: `unknown flag ${arg}` }
    } else if (opts.mode !== undefined) {
      return { error: `one mode at a time (got ${opts.mode} and ${arg})` }
    } else if (!MODES.includes(arg)) {
      return { error: `unknown mode '${arg}' (expected one of ${MODES.join(', ')})` }
    } else {
      opts.mode = arg
    }
  }
  return opts
}

function usage() {
  return 'usage: pnpm gc [software|flat|reliability] [-t pattern]'
}

/** @returns {Promise<number>} exit code */
function runPlaywright(args, env) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'playwright', 'test', '--config', configPath, ...args], {
      cwd: root,
      stdio: 'inherit',
      env: { ...toolEnv(), ...env },
    })
    child.on('error', () => resolve(127))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) {
    console.log(`${opts.error}\n${usage()}`)
    return 2
  }

  if (opts.mode === 'reliability') {
    // `--repeat-each` is uniform per invocation and clean/negative counts differ, so this is two
    // passes; `-t` narrows within each (default: every gc-loop test of both kinds).
    const grepFor = (base) => (opts.pattern ? `(?=.*${base})(?=.*${opts.pattern})` : base)
    const cleanCode = await runPlaywright(
      ['--project', 'gc', '--grep', grepFor('clean'), '--repeat-each', '50', '--workers', '4'],
      {},
    )
    const negCode = await runPlaywright(
      ['--project', 'gc', '--grep', grepFor('neg '), '--repeat-each', '15', '--workers', '4'],
      {},
    )
    return cleanCode === 0 && negCode === 0 ? 0 : 1
  }

  const env = {}
  if (opts.mode === 'software') env.GC_MODE = 'software'
  if (opts.mode === 'flat') env.GC_CDP = 'flat'
  const args = ['--project', 'gc']
  if (opts.pattern) args.push('--grep', opts.pattern)
  return runPlaywright(args, env)
}

process.exit(await main())
