import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
