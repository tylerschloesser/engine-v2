// The build/preview path of `engine()` and its profile default (docs/plan/02b-vite-plugin.md):
// `vite build` into a temp outDir, then `vite preview` of that output. Vite's JS API, ephemeral
// ports.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin, type PreviewServer, preview, resolveConfig } from 'vite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { type EnginePluginApi, engine } from '../../src/vite.js'
import { fixtureBytes, fixtureDir } from '../support/fixtures.js'

const CONFIG_FILE = fileURLToPath(new URL('../browser/pages/vite.config.ts', import.meta.url))

function apiOf(plugins: readonly Plugin[]): EnginePluginApi {
  const plugin = plugins.find((p) => p.name === 'engine:vite')
  if (!plugin) throw new Error('resolved config has no engine:vite plugin')
  return plugin.api as EnginePluginApi
}

test('plugin: default profile follows the Vite command', async () => {
  // No `profile` option and no cargo call: resolveConfig alone never runs `buildStart`.
  const dev = await resolveConfig(
    { configFile: false, plugins: [engine({ crate: fixtureDir('hash') })], logLevel: 'silent' },
    'serve',
  )
  expect(apiOf(dev.plugins).profile).toBe('dev')

  const built = await resolveConfig(
    { configFile: false, plugins: [engine({ crate: fixtureDir('hash') })], logLevel: 'silent' },
    'build',
  )
  expect(apiOf(built.plugins).profile).toBe('release')
})

describe('plugin-build', () => {
  let outDir: string
  let server: PreviewServer
  let base: string

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'engine-plugin-build-'))
    await build({
      configFile: CONFIG_FILE,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    })

    server = await preview({
      configFile: CONFIG_FILE,
      build: { outDir },
      preview: { port: 0, strictPort: false },
      logLevel: 'silent',
    })
    const port = (server.httpServer?.address() as AddressInfo | null)?.port
    if (port === undefined) throw new Error('plugin-build: preview server has no address')
    base = `http://localhost:${port}`
  })

  afterAll(async () => {
    await server.close()
    await rm(outDir, { recursive: true, force: true })
  })

  test('plugin-build: hashed non-inlined wasm asset', async () => {
    const assets = await readdir(join(outDir, 'assets'))
    const wasmFiles = assets.filter((f) => f.endsWith('.wasm'))
    expect(wasmFiles).toHaveLength(1)
    const wasmFile = wasmFiles[0]
    if (!wasmFile) throw new Error('unreachable: length asserted above')
    // Hashed (not the bare `game.wasm` fixturesPlugin() copies alongside it).
    expect(wasmFile).toMatch(/^game-[\w-]+\.wasm$/)

    const bytes = await readFile(join(outDir, 'assets', wasmFile))
    expect(bytes.equals(fixtureBytes('hash'))).toBe(true)

    for (const file of assets.filter((f) => f.endsWith('.js'))) {
      const code = await readFile(join(outDir, 'assets', file), 'utf8')
      expect(code).not.toContain('data:application/wasm')
    }

    const copied = await readFile(join(outDir, 'fixtures', 'hash', 'game.wasm'))
    expect(copied.equals(fixtureBytes('hash'))).toBe(true)
  })

  test('plugin-build: preview sends COOP/COEP', async () => {
    const htmlRes = await fetch(`${base}/wiring.html`)
    expect(htmlRes.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(htmlRes.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
    const html = await htmlRes.text()

    const jsSrc = /src="([^"]+\.js)"/.exec(html)?.[1]
    if (!jsSrc) throw new Error(`wiring.html has no module script: ${html}`)
    const jsRes = await fetch(`${base}${jsSrc}`)
    expect(jsRes.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(jsRes.headers.get('cross-origin-embedder-policy')).toBe('require-corp')

    const wasmFile = (await readdir(join(outDir, 'assets'))).find((f) => f.endsWith('.wasm'))
    if (!wasmFile) throw new Error('unreachable: asserted by the other test')
    const wasmRes = await fetch(`${base}/assets/${wasmFile}`)
    expect(wasmRes.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(wasmRes.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
    expect(wasmRes.headers.get('content-type')).toBe('application/wasm')
  })
})
