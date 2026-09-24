// `watchCrate`'s own regression (docs/plan/17d-fast-tier-wall-time.md, CI round 1): the paths it
// passes to `fs.watch` must never let a recursive watch descend into `target/` (cargo's own scratch
// dir, whose churn crashed the recursive JS watcher on Linux -- see `watchCrate`'s doc comment in
// `vite.ts`). Inspects the real arguments through a `node:fs` mock rather than exercising the actual
// watcher: deterministic, no real filesystem events, and fails against the old whole-crate-recursive
// implementation (proved below by reverting `watchCrate` to it).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

interface WatchCall {
  path: string
  options: { recursive?: boolean }
}

const watchCalls: WatchCall[] = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: vi.fn((path: string, options: { recursive?: boolean }) => {
      watchCalls.push({ path, options })
      return { close: vi.fn() }
    }),
  }
})

const { watchCrate } = await import('./vite.js')

let crateDir: string

beforeEach(() => {
  watchCalls.length = 0
  crateDir = mkdtempSync(join(tmpdir(), 'engine-watch-crate-'))
  mkdirSync(join(crateDir, 'src'), { recursive: true })
  mkdirSync(join(crateDir, 'target', 'wasm32-unknown-unknown', 'debug', 'deps'), {
    recursive: true,
  })
  writeFileSync(join(crateDir, 'Cargo.toml'), '[package]\nname = "fx-test"\n')
  writeFileSync(join(crateDir, 'src', 'lib.rs'), '')
})

afterEach(() => {
  rmSync(crateDir, { recursive: true, force: true })
})

test('watchCrate: no recursive watch ever reaches target/', () => {
  const watcher = watchCrate(crateDir, () => {})
  expect(watcher).toBeDefined()

  const targetDir = join(crateDir, 'target')
  const recursivePaths = watchCalls.filter((c) => c.options.recursive === true).map((c) => c.path)

  // The old, buggy implementation made one call: `watch(crateDir, { recursive: true }, cb)`,
  // which is an ancestor of `target/` -- this line alone fails against it.
  expect(recursivePaths).not.toContain(crateDir)

  // No recursively-watched path is `target/` itself or an ancestor of it.
  for (const p of recursivePaths) {
    expect(p === targetDir || targetDir.startsWith(p + sep)).toBe(false)
  }

  // `target/` itself is never even a direct watch target (recursive or not).
  expect(watchCalls.map((c) => c.path)).not.toContain(targetDir)

  // Still watches `src/` recursively, so a new `.rs` file in a new subdirectory is seen.
  expect(recursivePaths).toContain(join(crateDir, 'src'))

  watcher?.close()
})
