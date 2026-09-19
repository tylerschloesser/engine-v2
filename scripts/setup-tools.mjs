// `pnpm setup:tools`: install the binary tools that npm and rustup do not manage, at their pins.
// Never runs implicitly: `pnpm test` only probes and tells you to run this.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolEnv } from './lib/env.mjs'
import { lastLines, readLog, run } from './lib/run.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * One row per tool. `pin: null` means report only. `install: null` means it cannot be installed
 * from here; `hint` says what to do instead. M02 adds Bun, M03 the Playwright browsers.
 */
export const TOOLS = [
  {
    name: 'rustup',
    pin: null,
    probe: { cmd: 'rustup', args: ['--version'], match: /^rustup (\S+)/m },
    install: null,
    hint: 'install rustup from https://rustup.rs (rust-toolchain.toml then installs the pinned toolchain)',
  },
  { name: 'node', pin: null, probe: { cmd: 'node', args: ['--version'], match: /^v(\S+)/m } },
  { name: 'pnpm', pin: null, probe: { cmd: 'pnpm', args: ['--version'], match: /^(\d\S*)/m } },
  {
    name: 'nextest',
    pin: '0.9.145', // cargo-nextest; owner of the pin: docs/decisions/0017 §10
    probe: { cmd: 'cargo', args: ['nextest', '--version'], match: /^cargo-nextest (\S+)/m },
    // A source build into ~/.cargo/bin: a few minutes, once, shared by every worktree.
    install: {
      cmd: 'cargo',
      args: ['install', 'cargo-nextest', '--locked', '--version', '0.9.145'],
    },
  },
]

/** Installed version of `tool`, or null when it is missing. */
export async function probeTool(tool) {
  const log = join(root, 'test-results', 'setup', `${tool.name}.probe.log`)
  const { code } = await run(tool.probe.cmd, tool.probe.args, { log, cwd: root, env: toolEnv() })
  if (code !== 0) return null
  return tool.probe.match.exec(readLog(log))?.[1] ?? null
}

async function main() {
  for (const tool of TOOLS) {
    let found = await probeTool(tool)
    if (found === null && !tool.install) {
      console.log(`${tool.name} missing: ${tool.hint ?? 'install it'}`)
      return 1
    }
    if (tool.pin && found !== tool.pin) {
      console.log(`install ${tool.name} ${tool.pin}`)
      const log = join(root, 'test-results', 'setup', `${tool.name}.install.log`)
      const { code } = await run(tool.install.cmd, tool.install.args, {
        log,
        cwd: root,
        env: toolEnv(),
      })
      found = code === 0 ? await probeTool(tool) : null
      if (found !== tool.pin) {
        console.log(`${tool.name} FAIL install\n${lastLines(readLog(log), 20)}\n${log}`)
        return 1
      }
    }
    console.log(`${tool.name} ${found}`)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main())
