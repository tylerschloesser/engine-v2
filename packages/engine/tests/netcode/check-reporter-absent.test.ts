// `window.__check` (docs/plan/39f-device-auto-runner.md, "The check reporter contract") is page
// instrumentation for the fixture pages only: no production output carries it. The fixture app's own
// build is the positive control (it must), the engine package's output and sources and the reference
// game's release build must not. (The bench/check build of `games/reference` gets its own row when
// delegation 4 gives it a reporter.)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const TEXT = /\.(html|js|mjs|ts|css|json|map)$/

function files(dir: string, skip: (p: string) => boolean = () => false): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (skip(p)) continue
    if (statSync(p).isDirectory()) out.push(...files(p, skip))
    else if (TEXT.test(name)) out.push(p)
  }
  return out
}
const has = (list: string[], needle: string) =>
  list.filter((f) => readFileSync(f, 'utf8').includes(needle))

test('check-reporter: the fixture pages carry window.__check; no production output or source does', () => {
  const fixture = join(root, 'packages/engine/tests/browser/pages/dist')
  expect(existsSync(fixture), 'run pnpm test (pages build)').toBe(true)
  expect(
    has(files(fixture), '__check').length,
    'positive control: device.html reports',
  ).toBeGreaterThan(0)

  const production = [
    ...files(join(root, 'packages/engine/dist')),
    ...files(
      join(root, 'packages/engine/src'),
      (p) => /\.test\.ts$/.test(p) || p.includes('/test/') || p.endsWith('/test'),
    ),
    ...(existsSync(join(root, 'games/reference/dist'))
      ? files(join(root, 'games/reference/dist'))
      : []),
  ]
  expect(production.length).toBeGreaterThan(50)
  for (const needle of ['__check', '__walkDriver', '__walkAgent'])
    expect(has(production, needle), `${needle} in production output`).toEqual([])
})
