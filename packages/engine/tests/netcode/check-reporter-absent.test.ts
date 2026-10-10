// `window.__check` (M39f, "The check reporter contract") is page
// instrumentation for the fixture pages only: no production output carries it. The fixture app's own
// build is the positive control (it must), the engine package's output and sources and the reference
// game's release build must not. The bench build of `games/reference` (`dist-bench/`, never ships) is the
// reference game's check build and carries `__check` by design (M39f step 11), but never the agent: that
// is injected at serve time by `vite preview`, in neither `dist/` nor `dist-bench/`.
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
  for (const needle of [
    '__check',
    '__walkDriver',
    '__walkAgent',
    '__walkKit',
    'collect-life',
    'collect-ref',
  ])
    expect(has(production, needle), `${needle} in production output`).toEqual([])
})

// M39f steps 7-9: every fixture page that reports installs the reporter under its own name (the positive
// control per page: a page that lost its `installCheck` would pass the absence half above for the wrong
// reason), and none of the collectors' own globals is in a page bundle either (they are served by the phone
// API, never built in).
test('check-reporter: each reporting fixture page installs window.__check under its own name', () => {
  const assets = join(root, 'packages/engine/tests/browser/pages/dist/assets')
  expect(existsSync(assets), 'run pnpm test (pages build)').toBe(true)
  const all = files(assets)
  for (const page of ['device', 'slice', 'world', 'mp']) {
    const chunk = all.filter((f) => new RegExp(`/${page}-[\\w-]+\\.js$`).test(f))
    expect(chunk.length, `a ${page} chunk`).toBeGreaterThan(0)
    expect(
      has(chunk, `installCheck("${page}")`).length + has(chunk, `installCheck('${page}')`).length,
      `${page} installs the reporter`,
    ).toBeGreaterThan(0)
  }
  for (const needle of ['__walkKit', '__walkDriver', '__walkAgent'])
    expect(has(all, needle), `${needle} in the fixture build`).toEqual([])
})

// The reference game's bench build is built by the bench specs (`vite build --mode bench`), not by
// `pnpm test`'s steps: when it is there it is checked, and the `walk-ref` spec builds it before it serves it.
test('check-reporter: the reference bench build (dist-bench) never carries the agent or a collector', () => {
  const dir = join(root, 'games/reference/dist-bench')
  if (!existsSync(dir)) return // not built in this checkout; `walk-ref` builds and checks it
  const built = files(dir)
  expect(built.length).toBeGreaterThan(3)
  // Positive control: it is the check build, so `window.__check` (and not the agent) is in it.
  expect(has(built, '__check').length, 'dist-bench carries window.__check').toBeGreaterThan(0)
  for (const needle of [
    '__walkDriver',
    '__walkAgent',
    '__walkKit',
    'collect-life',
    'collect-ref',
    '/__walk/',
  ])
    expect(has(built, needle), `${needle} in dist-bench`).toEqual([])
})
