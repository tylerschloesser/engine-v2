import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

const hook = fileURLToPath(new URL('../../.claude/hooks/pre-commit-check.sh', import.meta.url))

// An empty directory outside any repository stands in for the project. The hook's first act after
// deciding "this is a commit" is to look for node_modules/.bin/biome, so here a commit exits 2 with
// `run: pnpm install` and a non-commit exits 0 silently: neither case runs a lint tool.
const emptyDir = mkdtempSync(join(tmpdir(), 'pre-commit-check-'))
afterAll(() => rmSync(emptyDir, { recursive: true, force: true }))

function runHook(stdin) {
  return new Promise((resolve) => {
    const child = spawn('bash', [hook], { env: { ...process.env, CLAUDE_PROJECT_DIR: emptyDir } })
    let output = ''
    child.stdout.on('data', (d) => {
      output += d
    })
    child.stderr.on('data', (d) => {
      output += d
    })
    child.on('close', (code) => resolve({ code, output }))
    child.stdin.end(stdin)
  })
}

const bash = (command) =>
  JSON.stringify({ tool_name: 'Bash', cwd: emptyDir, tool_input: { command } })

describe('pre-commit-check', () => {
  test('exits 0 silently for anything that is not a git commit', async () => {
    const inputs = [
      bash('ls'),
      bash('pnpm test'),
      bash('git status'),
      bash('git log --grep "git commit"'),
      bash('echo git commit'),
      bash('git commit-tree abc'),
      bash('git add -A && git log -1'),
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }),
      'not json',
      '',
    ]
    const outcomes = await Promise.all(inputs.map(runHook))
    expect(outcomes).toEqual(inputs.map(() => ({ code: 0, output: '' })))
  })

  test('recognises a commit in any shell segment', async () => {
    const inputs = [
      'git commit -m x',
      'git add -A && git commit -m x',
      'cd sub; git commit',
      'GIT_AUTHOR_NAME=a FOO=1 git commit -m x',
      'git -C "/some/where else" -c user.name=x commit -m x',
      'echo $(git commit -m x)',
      'pnpm format\ngit commit -am "msg"',
    ].map(bash)
    const outcomes = await Promise.all(inputs.map(runHook))
    expect(outcomes).toEqual(inputs.map(() => ({ code: 2, output: 'run: pnpm install\n' })))
  })
})

// 0021 §6b: with `biome` and `cargo` stubbed (a project directory holding `node_modules/.bin/biome`
// and a `cargo` first on PATH), the hook runs both checks and, on failure, exits 2 printing each
// tool's output and the one fix command.
describe('pre-commit-check: lint failures', () => {
  function project(biomeStatus, cargoStatus) {
    const dir = mkdtempSync(join(tmpdir(), 'pre-commit-check-lint-'))
    const bin = join(dir, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    const stub = (path, status, text) => {
      writeFileSync(path, `#!/bin/sh\necho '${text}'\nexit ${status}\n`)
      chmodSync(path, 0o755)
    }
    stub(join(bin, 'biome'), biomeStatus, 'biome: 1 error')
    const stubs = join(dir, 'stubs')
    mkdirSync(stubs)
    stub(join(stubs, 'cargo'), cargoStatus, 'cargo: diff in src/lib.rs')
    return { dir, stubs }
  }

  function run({ dir, stubs }) {
    return new Promise((resolve) => {
      const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, PATH: `${stubs}:${process.env.PATH}` }
      const child = spawn('bash', [hook], { env })
      let output = ''
      child.stdout.on('data', (d) => {
        output += d
      })
      child.stderr.on('data', (d) => {
        output += d
      })
      child.on('close', (code) => resolve({ code, output }))
      child.stdin.end(
        JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'git commit -m x' } }),
      )
    })
  }

  async function outcome(biomeStatus, cargoStatus) {
    const p = project(biomeStatus, cargoStatus)
    try {
      return await run(p)
    } finally {
      rmSync(p.dir, { recursive: true, force: true })
    }
  }

  test('pre-commit-check: a biome failure exits 2 with the biome fix command only', async () => {
    const { code, output } = await outcome(1, 0)
    expect(code).toBe(2)
    expect(output).toContain('biome: 1 error')
    expect(output).toContain('fix: pnpm exec biome check --write .\n')
    expect(output).not.toContain('fix: cargo fmt')
  })

  test('pre-commit-check: a rustfmt failure exits 2 with the cargo fmt fix command only', async () => {
    const { code, output } = await outcome(0, 1)
    expect(code).toBe(2)
    expect(output).toContain('cargo: diff in src/lib.rs')
    expect(output).toContain('fix: cargo fmt\n')
    expect(output).not.toContain('fix: pnpm exec biome')
  })

  test('pre-commit-check: both failing prints both fix commands, both passing exits 0 silently', async () => {
    const both = await outcome(1, 1)
    expect(both.code).toBe(2)
    expect(both.output).toContain('fix: pnpm exec biome check --write .')
    expect(both.output).toContain('fix: cargo fmt')
    expect(await outcome(0, 0)).toEqual({ code: 0, output: '' })
  })
})
