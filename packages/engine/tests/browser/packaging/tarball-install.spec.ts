// `tarball-install @slow` (docs/decisions/0017 §8; docs/plan/35-packaging-and-adapters.md Tests
// added): the engine, packed with `pnpm pack` and installed with `--ignore-workspace` into a Vite
// game under `<tmpdir>/engine-tarball-test/` (outside both workspaces, no lockfile), whose
// `sim/Cargo.toml` path-depends on `node_modules/engine/crates/engine`. Four tarball cells (`vite
// dev` and `vite build` + `preview`, each with worker pattern A and B), one `link:` cell (0017 §3's
// `fs.allow` case), and the server leg (`engine/server/node` and `/bun`, one in-process join).
//
// Every page load asserts: one action round trip, `content-type: application/wasm`,
// `crossOriginIsolated`, a hashed non-inlined `/assets/*.wasm` (build cells) and the 0014 §3 import
// allowlist (on the built bytes). Each page is loaded twice: a local world (client, sim and gen
// workers) and a joined one (client, gen and net workers) against a server on the same build; under
// pattern B the page records the kind of every worker its `createWorker` built, so all four kinds
// are seen. A failing cell names its cell.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  createScratchApp,
  type ScratchApp,
  type ScratchOptions,
} from '../../support/scratch-app.js'
import { startTestServer } from '../support/test-server.js'

/** 0014 §3: the only imports a game module may have (`tests/wasm/allowlist.test.ts` owns the rule). */
const ALLOWED_IMPORTS = ['engine.panic', 'engine.log']

type PageResult = {
  pattern: 'A' | 'B'
  host: 'local' | 'remote'
  crossOriginIsolated: boolean
  wasmUrl: string
  buildHash: string
  contentType: string | null
  imports: string[]
  kinds: string[]
  verdict?: unknown
  error?: string
}

const apps = new Map<string, Promise<ScratchApp>>()
function app(opts: ScratchOptions): Promise<ScratchApp> {
  const key = `${opts.install}-${opts.pattern}`
  let made = apps.get(key)
  if (!made) {
    made = createScratchApp(opts)
    apps.set(key, made)
  }
  return made
}

const built = new Map<string, Promise<string>>()
function ensureBuilt(a: ScratchApp): Promise<string> {
  let b = built.get(a.dir)
  if (!b) {
    b = a.build()
    built.set(a.dir, b)
  }
  return b
}

/** Loads `path` and returns what `main.ts` published, failing on any page or console error. */
async function load(
  page: Page,
  url: string,
  diagnostics: () => string[] = () => [],
): Promise<PageResult> {
  const problems: string[] = []
  const trace: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    trace.push(`${m.type()}: ${m.text()}`)
    if (m.type() === 'error') problems.push(`console.error: ${m.text()} (${m.location().url})`)
  })
  page.on('websocket', (w) => trace.push(`websocket ${w.url()}`))
  page.on('worker', (w) => trace.push(`worker ${w.url()}`))
  page.on('response', (r) => {
    if (r.status() >= 400) trace.push(`${r.status()} ${r.url()}`)
  })
  await page.goto(url)
  const deadline = Date.now() + 60_000
  for (;;) {
    let r: PageResult | undefined
    try {
      r = (await page.evaluate(() => (window as unknown as { __result?: unknown }).__result)) as
        | PageResult
        | undefined
    } catch {
      // Vite's first dev load re-optimises dependencies and reloads: the context goes away once.
    }
    if (r) {
      expect(problems, `${url}: page problems`).toEqual([])
      return r
    }
    if (Date.now() > deadline) {
      const state = await page
        .evaluate(
          () =>
            `${(window as unknown as { __stage?: string }).__stage} links=${JSON.stringify((window as unknown as { __links?: string[] }).__links)}`,
        )
        .catch((e) => String(e))
      throw new Error(
        `${url}: no __result after 60 s (stage ${state})\n${trace.join('\n')}\n${diagnostics().join('\n')}`,
      )
    }
    await page.waitForTimeout(50)
  }
}

async function builtWasm(a: ScratchApp): Promise<{ file: string; bytes: Buffer }> {
  const assets = join(a.dir, 'dist/assets')
  const file = (await readdir(assets)).find((f) => f.endsWith('.wasm'))
  if (!file) throw new Error(`${a.dir}: vite build emitted no .wasm`)
  return { file, bytes: await readFile(join(assets, file)) }
}

/** One cell: both hosts, every assertion above. `mode` picks the profile the server must match. */
async function checkCell(page: Page, a: ScratchApp, mode: 'dev' | 'build', baseUrl: string) {
  const profile = mode === 'dev' ? 'dev' : 'release'
  const cell = `${a.install} ${a.pattern} ${mode}`
  const gameJson = JSON.parse(await readFile(join(a.buildDir(profile), 'game.json'), 'utf8')) as {
    buildHash: string
  }
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined
  let ticker: NodeJS.Timeout | undefined
  try {
    for (const host of ['local', 'remote'] as const) {
      const where = `${cell} (${host})`
      if (host === 'remote') {
        const started = await startTestServer({ fixture: a.buildDir(profile), manualTimer: true })
        server = started
        // `manualTimer: false` is the helper's unused path; the manual one is what every `mp` spec drives.
        ticker = setInterval(() => started.stepTick(1), 50)
      }
      const query =
        host === 'local'
          ? '?host=local'
          : `?host=remote&server=${encodeURIComponent(server?.url ?? '')}`
      const r = await load(page, `${baseUrl}/${query}`, () => server?.diagnostics() ?? [])
      expect(r.error, `${where}: page error`).toBeUndefined()
      expect(r.verdict, `${where}: action round trip`).toBe('Confirmed')
      expect(r.crossOriginIsolated, `${where}: crossOriginIsolated`).toBe(true)
      expect(r.contentType, `${where}: content-type`).toBe('application/wasm')
      expect(r.buildHash, `${where}: page buildHash is game.json's`).toBe(gameJson.buildHash)
      expect(
        r.imports.filter((i) => !ALLOWED_IMPORTS.includes(i)),
        `${where}: imports`,
      ).toEqual([])
      if (mode === 'build') {
        expect(r.wasmUrl, `${where}: hashed, non-inlined asset`).toMatch(
          /^\/assets\/[\w.-]+-[\w-]{8,}\.wasm$/,
        )
      } else {
        expect(r.wasmUrl, `${where}: dev route`).toMatch(/^\/@engine\/game\.wasm\?v=\d+$/)
      }
      if (a.pattern === 'B') {
        // Pattern B: the game's own `worker.ts` built every worker; these are the kinds it saw.
        const expected = host === 'local' ? ['client', 'gen', 'sim'] : ['client', 'gen', 'net']
        expect(r.kinds, `${where}: worker kinds built by createWorker`).toEqual(expected)
      } else {
        expect(r.kinds, `${where}: pattern A builds no worker in the game`).toEqual([])
      }
      expect(page.workers().length, `${where}: workers running`).toBeGreaterThanOrEqual(3)
    }
  } finally {
    clearInterval(ticker)
    await server?.stop()
  }
}

async function buildCell(page: Page, opts: ScratchOptions) {
  const a = await app(opts)
  await ensureBuilt(a)
  const { file, bytes } = await builtWasm(a)
  // The built module itself, on the allowlist (the page checks the same bytes it fetched).
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(new Uint8Array(bytes))).map(
    (i) => `${i.module}.${i.name}`,
  )
  expect(
    imports.filter((i) => !ALLOWED_IMPORTS.includes(i)),
    `${file}: imports`,
  ).toEqual([])
  const hash = createHash('sha256').update(bytes).digest('hex')
  const gameJson = JSON.parse(await readFile(join(a.buildDir('release'), 'game.json'), 'utf8')) as {
    buildHash: string
  }
  expect(hash, 'dist asset bytes are the buildHash').toBe(gameJson.buildHash)
  const preview = await a.preview()
  try {
    await checkCell(page, a, 'build', preview.url)
  } finally {
    await preview.stop()
  }
}

async function devCell(page: Page, opts: ScratchOptions) {
  const a = await app(opts)
  const dev = await a.dev()
  try {
    await checkCell(page, a, 'dev', dev.url)
  } finally {
    await dev.stop()
  }
}

test.describe.configure({ mode: 'serial' })
// A cold dependency build (serde, ts-rs, the engine crate in release) is the first cell's cost.
test.setTimeout(900_000)

test('tarball-install @slow: tarball, pattern A, vite dev', async ({ page }) => {
  await devCell(page, { pattern: 'A', install: 'tarball' })
})

test('tarball-install @slow: tarball, pattern A, vite build + preview', async ({ page }) => {
  await buildCell(page, { pattern: 'A', install: 'tarball' })
})

test('tarball-install @slow: tarball, pattern B, vite dev', async ({ page }) => {
  await devCell(page, { pattern: 'B', install: 'tarball' })
})

test('tarball-install @slow: tarball, pattern B, vite build + preview', async ({ page }) => {
  await buildCell(page, { pattern: 'B', install: 'tarball' })
})

// 0017 §3's one deterministic pattern-A failure (`link:` with no workspace-root marker above both
// packages: the worker URL falls outside `server.fs.allow`). The plugin's appended `fs.allow` entry
// is what makes it pass; `vite dev` only, as in the spike.
test('tarball-install @slow: link, pattern A, vite dev (fs.allow)', async ({ page }) => {
  await devCell(page, { pattern: 'A', install: 'link' })
})

for (const runtime of ['node', 'bun'] as const) {
  test(`tarball-install @slow: server leg, ${runtime}`, async ({ page }) => {
    const a = await app({ pattern: 'B', install: 'tarball' })
    await ensureBuilt(a)
    const preview = await a.preview()
    let browserHash: string
    try {
      browserHash = (await load(page, `${preview.url}/?host=local`)).buildHash
    } finally {
      await preview.stop()
    }
    const releaseDir = a.buildDir('release')
    expect(existsSync(join(releaseDir, 'game.wasm'))).toBe(true)
    if (runtime === 'bun') {
      // The pin has one owner (`scripts/setup-tools.mjs`); a variable specifier keeps `tsc` off the .mjs.
      const toolsFile = '../../../../../scripts/setup-tools.mjs'
      const { TOOLS } = (await import(toolsFile)) as {
        TOOLS: { name: string; pin: string | null }[]
      }
      const pin = TOOLS.find((t) => t.name === 'bun')?.pin
      const { stdout } = await a.exec('bun', ['--version'])
      expect(stdout.trim(), 'bun is the pinned version (0044)').toBe(pin)
    }
    const { stdout } = await a.exec(runtime, ['server-leg.mjs', runtime, releaseDir])
    const result = JSON.parse(stdout.trim().split('\n').at(-1) as string) as {
      runtime: string
      buildHash: string
      live: boolean
      hostHash: string
      replicaHash: string
    }
    expect(result.live).toBe(true)
    expect(result.buildHash, `${runtime} host buildHash is the browser's`).toBe(browserHash)
    expect(result.replicaHash, `${runtime}: replica hash equals host hash`).toBe(result.hostHash)
    expect(result.runtime).toMatch(runtime === 'bun' ? /^bun 1\.4\.2$/ : /^node \d+/)
  })
}
