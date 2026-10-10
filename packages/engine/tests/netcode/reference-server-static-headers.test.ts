// `reference-server/static-headers` (M38, Tests added): the real
// `games/reference-server --static <dir>` process. Both isolation headers, exact values (0015 §3),
// on every response including a 404, a traversal refusal and a wrong method; `.wasm` is served as
// `application/wasm`; `/assets/*` is immutable; `/ws` still upgrades and a `/ws`-less upgrade does not.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { fixtureBuildDir } from '../support/fixtures.js'
import { type RunningServer, spawnReferenceServer } from '../support/reference-server.js'

let server: RunningServer | undefined
let tmp: string | undefined

afterEach(async () => {
  server?.proc.kill()
  await server?.exited
  server = undefined
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = undefined
})

const COOP = 'same-origin'
const COEP = 'require-corp'

test('reference-server/static-headers', async () => {
  tmp = await mkdtemp(join(tmpdir(), 'reference-server-static-'))
  const site = join(tmp, 'site')
  await mkdir(join(site, 'assets'), { recursive: true })
  await writeFile(join(site, 'index.html'), '<!doctype html><title>x</title>')
  await writeFile(join(site, 'assets', 'app-1.js'), 'export {}')
  await writeFile(join(site, 'assets', 'g.wasm'), new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
  await writeFile(join(tmp, 'secret.txt'), 'outside the static dir')

  server = await spawnReferenceServer([
    '--game',
    fixtureBuildDir('puts'),
    '--data',
    join(tmp, 'data'),
    '--static',
    site,
  ])
  const base = `http://127.0.0.1:${server.port}`

  const get = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init)
    const body = await res.arrayBuffer()
    return { res, body }
  }
  const isolated = (res: Response, what: string) => {
    expect(res.headers.get('cross-origin-opener-policy'), `${what} COOP`).toBe(COOP)
    expect(res.headers.get('cross-origin-embedder-policy'), `${what} COEP`).toBe(COEP)
  }

  const index = await get('/')
  expect(index.res.status).toBe(200)
  expect(index.res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  isolated(index.res, '/')

  const js = await get('/assets/app-1.js')
  expect(js.res.status).toBe(200)
  expect(js.res.headers.get('content-type')).toContain('text/javascript')
  expect(js.res.headers.get('cache-control')).toContain('immutable')
  isolated(js.res, 'a .js')

  const wasm = await get('/assets/g.wasm')
  expect(wasm.res.headers.get('content-type')).toBe('application/wasm')
  expect(wasm.body.byteLength).toBe(8)
  isolated(wasm.res, 'a .wasm')

  const missing = await get('/nope.png')
  expect(missing.res.status).toBe(404)
  isolated(missing.res, 'a 404')

  // `..` must be sent raw: `fetch` would normalise it away, so use a raw socket request path.
  // (`/..%2f` survives URL normalisation and decodes to a real `..`: the 403 branch.)
  for (const path of [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/assets/../../secret.txt',
    '/..%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
  ]) {
    const r = await rawGet(server.port, path)
    expect(r.status, `traversal ${path}`).not.toBe(200)
    if (path.includes('%2f')) expect(r.status, `traversal ${path}`).toBe(403)
    expect(r.body).not.toContain('outside the static dir')
    expect(r.coop, path).toBe(COOP)
    expect(r.coep, path).toBe(COEP)
  }

  const post = await get('/', { method: 'POST' })
  expect(post.res.status).toBe(405)
  isolated(post.res, 'a 405')

  // `/ws` still upgrades (a real handshake), any other path does not.
  await expect(wsOpens(`ws://127.0.0.1:${server.port}/ws`)).resolves.toBe(true)
  await expect(wsOpens(`ws://127.0.0.1:${server.port}/elsewhere`)).resolves.toBe(false)
}, 20_000)

/** One raw HTTP/1.1 request, so the path reaches the server byte for byte. */
async function rawGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string; coop: string | undefined; coep: string | undefined }> {
  const { connect } = await import('node:net')
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1')
    let data = ''
    sock.on('connect', () =>
      sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`),
    )
    sock.on('data', (d) => {
      data += d.toString()
    })
    sock.on('error', reject)
    sock.on('close', () => {
      const [head = '', ...rest] = data.split('\r\n\r\n')
      const header = (n: string) => new RegExp(`^${n}: (.*)$`, 'im').exec(head)?.[1]?.trim()
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]),
        body: rest.join('\r\n\r\n'),
        coop: header('cross-origin-opener-policy'),
        coep: header('cross-origin-embedder-policy'),
      })
    })
  })
}

function wsOpens(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.onopen = () => {
      ws.close()
      resolve(true)
    }
    ws.onerror = () => resolve(false)
  })
}
