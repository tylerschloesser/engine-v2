// The dev-server path of `engine()` (docs/plan/02b-vite-plugin.md): headers on every response, the
// wasm route, the virtual module, `server.fs.allow`, and the watch → rebuild → full-reload loop.
// Against the real fixture app (tests/browser/pages), through Vite's JS API, on an ephemeral port.

import { readFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { fixtureBuildDir } from '../support/fixtures.js'

const CONFIG_FILE = fileURLToPath(new URL('../browser/pages/vite.config.ts', import.meta.url))
const LIB_RS = fileURLToPath(new URL('../../fixtures/hash/src/lib.rs', import.meta.url))
const ENGINE_PKG_DIR = resolve(fileURLToPath(new URL('../../', import.meta.url)))

let server: ViteDevServer
let base: string

beforeAll(async () => {
  server = await createServer({
    configFile: CONFIG_FILE,
    server: { port: 0, strictPort: false },
    logLevel: 'silent',
  })
  await server.listen()
  const port = (server.httpServer?.address() as AddressInfo | null)?.port
  if (port === undefined) throw new Error('plugin-dev: dev server has no address')
  base = `http://localhost:${port}`
})

afterAll(async () => {
  await server.close()
})

/** `{ url, buildHash }` from the virtual module's current transformed code. */
async function virtualWasm(): Promise<{ url: string; buildHash: string }> {
  const result = await server.transformRequest('virtual:engine/wasm')
  const match = result ? /export default (\{.*\})/.exec(result.code) : null
  if (!match?.[1]) throw new Error(`virtual:engine/wasm did not transform: ${result?.code}`)
  return JSON.parse(match[1]) as { url: string; buildHash: string }
}

function expectCoiHeaders(res: Response): void {
  expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
}

describe('plugin-dev', () => {
  test('plugin-dev: headers on every response', async () => {
    const { url } = await virtualWasm()
    expectCoiHeaders(await fetch(`${base}/`))
    expectCoiHeaders(await fetch(`${base}/src/wiring.ts`))
    expectCoiHeaders(await fetch(`${base}${url}`))
  })

  test('plugin-dev: wasm served as application/wasm', async () => {
    const { url } = await virtualWasm()
    const res = await fetch(`${base}${url}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/wasm')
    const body = Buffer.from(await res.arrayBuffer())
    const onDisk = readFileSync(resolve(fixtureBuildDir('hash'), 'game.wasm'))
    expect(body.equals(onDisk)).toBe(true)
  })

  test('plugin-dev: virtual module carries url and buildHash', async () => {
    const wasm = await virtualWasm()
    expect(wasm.url).toMatch(/^\/@engine\/game\.wasm\?v=\d+$/)
    const json = JSON.parse(
      readFileSync(resolve(fixtureBuildDir('hash'), 'game.json'), 'utf8'),
    ) as { buildHash: string }
    expect(wasm.buildHash).toBe(json.buildHash)
  })

  test('plugin-dev: fs.allow contains engine dir', () => {
    const allow = server.config.server.fs.allow.map((p) => resolve(p))
    expect(allow).toContain(ENGINE_PKG_DIR)
  })

  test('plugin-dev: touch triggers rebuild and full-reload', async () => {
    const before = await virtualWasm()
    const beforeVersion = Number(/\?v=(\d+)$/.exec(before.url)?.[1])

    const ws = new WebSocket(base.replace('http', 'ws'), 'vite-hmr')
    const fullReload = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for full-reload')), 10_000)
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data as string) as { type: string }
        if (msg.type === 'full-reload') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('vite-hmr socket errored')))
    })

    const now = new Date()
    await utimes(LIB_RS, now, now)
    await fullReload
    ws.close()

    const after = await virtualWasm()
    const afterVersion = Number(/\?v=(\d+)$/.exec(after.url)?.[1])
    expect(afterVersion).toBe(beforeVersion + 1)
  })
})
