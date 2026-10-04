// The reference game's bench build (`vite build --mode bench`, `games/reference/dist-bench/`, the check
// build of `pnpm device:walk`) for the specs that serve it with `device-serve --no-build` (`walk-ref`).
// `pnpm test` builds `dist/` (its `reference` step) but never `dist-bench/`: this builds it when it is
// missing or older than the sources it is made from, under a lock directory so the chromium and webkit
// projects (separate processes) never run two cargo builds at once (they share the cargo target dir).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const out = join(root, 'games/reference/dist-bench/index.html')
const wasm = join(root, 'games/reference/sim/target/engine/release+bench/game.wasm')
const LOCK = join(tmpdir(), 'walk-ref-bench-build.lock')

function newest(dir: string): number {
  let t = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'target' || e.name === 'node_modules' || e.name === 'bindings') continue
    const p = join(dir, e.name)
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return t
}

const stale = (): boolean =>
  !existsSync(out) ||
  !existsSync(wasm) ||
  [
    'games/reference/src',
    'games/reference/sim/src',
    'games/reference/index.html',
    'games/reference/vite.config.ts',
    'packages/engine/dist',
  ].some((p) => {
    const abs = join(root, p)
    const t = statSync(abs).isDirectory() ? newest(abs) : statSync(abs).mtimeMs
    return t > statSync(out).mtimeMs
  })

/** Builds `dist-bench/` (and the `release+bench` module its server runs) if it is stale. */
export async function ensureBenchBuild(): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (!stale()) return
    try {
      mkdirSync(LOCK)
    } catch {
      if (Date.now() - t0 > 600_000) throw new Error('timed out waiting for the bench build lock')
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    try {
      if (stale()) {
        const r = spawnSync('pnpm', ['--filter', 'reference', 'build', '--mode', 'bench'], {
          cwd: root,
          stdio: 'inherit',
          timeout: 540_000,
        })
        if (r.status !== 0)
          throw new Error(`pnpm --filter reference build --mode bench exited ${r.status}`)
      }
    } finally {
      rmSync(LOCK, { recursive: true, force: true })
    }
    return
  }
}
