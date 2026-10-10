// `pnpm device:walk` serve-time mount (M39f step 2), against real `vite
// preview` processes of the fixture app's own build output (`pnpm test`'s `pages` step builds it):
//  - with `ENGINE_WALK_PORT` every HTML page carries the agent tag (COOP/COEP headers intact), and
//    `/__walk` -- http and WebSocket -- reaches the phone API through the preview's own proxy;
//  - without it the page is served exactly as built and `/__walk` reaches nothing;
//  - no release build output (`games/reference/dist`, the fixture app's `dist`) contains `__walk`.
import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { WebSocket } from 'ws'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const pagesDir = join(root, 'packages/engine/tests/browser/pages')
const viteBin = join(root, 'node_modules/vite/bin/vite.js')
const phoneApiUrl = new URL('../../../../scripts/lib/device-walk/phone-api.mjs', import.meta.url)
  .href

type PhoneApi = {
  listen(port?: number): Promise<number>
  allowHost(host: string): void
  close(): Promise<void>
}
const children: ChildProcess[] = []
const apis: PhoneApi[] = []

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null) return resolve()
          c.once('exit', () => resolve())
          c.kill('SIGTERM')
          setTimeout(() => c.kill('SIGKILL'), 5000).unref()
        }),
    ),
  )
  for (const a of apis.splice(0)) await a.close()
})

const referenceDir = join(root, 'games/reference')

/** `vite preview` of `games/reference` (its own config, release output), no walk port. */
function previewReference(port: number): ChildProcess {
  const child = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1'], {
    cwd: referenceDir,
    stdio: 'ignore',
    env: { ...process.env, ENGINE_TEST_PORT: String(port), ENGINE_WALK_PORT: '' },
  })
  children.push(child)
  return child
}

function preview(port: number, walkPort?: number): ChildProcess {
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--config', join(pagesDir, 'vite.config.ts'), '--host', '127.0.0.1'],
    {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        ENGINE_TEST_PORT: String(port),
        ENGINE_WALK_PORT: walkPort === undefined ? '' : String(walkPort),
      },
    },
  )
  children.push(child)
  return child
}

async function up(port: number, path = '/determinism.html'): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}${path}`)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`vite preview on ${port} never came up`)
}

function textFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...textFiles(p))
    else if (/\.(html|js|mjs|css|json|map)$/.test(name)) out.push(p)
  }
  return out
}

test('walk-preview: ENGINE_WALK_PORT injects the agent tag and proxies /__walk; unset serves the build untouched', async () => {
  expect(existsSync(join(pagesDir, 'dist/determinism.html')), 'run pnpm test (pages build)').toBe(
    true,
  )
  const { createPhoneApi } = (await import(phoneApiUrl)) as {
    createPhoneApi: (o: Record<string, unknown>) => PhoneApi
  }
  const dir = mkdtempSync(join(tmpdir(), 'walk-preview-'))
  writeFileSync(join(dir, 'agent.js'), '// the agent')
  const token = 'f'.repeat(32)
  const api = createPhoneApi({
    file: join(dir, 'r.jsonl'),
    round: 'r',
    token,
    agentPath: join(dir, 'agent.js'),
  })
  apis.push(api)
  const walkPort = await api.listen(0)
  const [portA, portB] = [14391, 14392]
  api.allowHost(`127.0.0.1:${portA}`)
  preview(portA, walkPort)
  preview(portB)
  await Promise.all([up(portA), up(portB)])

  // With the variable: tag injected right after <head>, before the page's own scripts, headers intact.
  const a = await fetch(`http://127.0.0.1:${portA}/determinism.html`)
  const html = await a.text()
  expect(html).toContain('<script src="/__walk/agent.js"></script>')
  expect(html.indexOf('/__walk/agent.js')).toBeLessThan(html.indexOf('type="module"'))
  expect(a.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(a.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
  const agent = await fetch(`http://127.0.0.1:${portA}/__walk/agent.js`)
  expect([agent.status, await agent.text()]).toEqual([200, '// the agent'])
  // The proxy carries the gates through: no token, no page.
  expect((await fetch(`http://127.0.0.1:${portA}/__walk/runner.html`)).status).toBe(403)
  // WebSocket through the preview's own proxy reaches the phone API and is acked.
  const ack = await new Promise<{ type: string; seq: number }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${portA}/__walk/ws?walk=${token}`, {
      headers: { origin: `http://127.0.0.1:${portA}` },
    })
    ws.on('open', () =>
      ws.send(JSON.stringify({ run: 'r', tab: 't', seq: 1, t: 1, type: 'visibility' })),
    )
    ws.on('message', (d) => {
      resolve(JSON.parse(String(d)))
      ws.close()
    })
    ws.on('error', reject)
  })
  expect(ack).toMatchObject({ type: 'ack', seq: 1 })

  // A `..` path cannot reach an HTML file outside the build output (the source page is one level up).
  const escaped = await new Promise<string>((resolve, reject) => {
    const r = request(
      { host: '127.0.0.1', port: portA, path: '/%2e%2e/determinism.html' },
      (res) => {
        let body = ''
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => resolve(body))
      },
    )
    r.on('error', reject)
    r.end()
  })
  expect(escaped).not.toContain('/__walk/agent.js')

  // Without the variable: as built, and /__walk reaches no phone API.
  const b = await fetch(`http://127.0.0.1:${portB}/determinism.html`)
  expect(await b.text()).not.toContain('__walk')
  const none = await fetch(`http://127.0.0.1:${portB}/__walk/agent.js`)
  expect(await none.text()).not.toBe('// the agent')
}, 60_000)

test('walk-preview: no release build output contains the agent, its tag or the /__walk path', () => {
  const dirs = [
    join(pagesDir, 'dist'),
    join(root, 'games/reference/dist'),
    join(root, 'games/reference/dist-bench'),
  ].filter(existsSync)
  expect(dirs.length, 'built output exists (pnpm test builds it)').toBeGreaterThanOrEqual(2)
  for (const d of dirs)
    for (const f of textFiles(d)) expect(readFileSync(f, 'utf8'), f).not.toContain('__walk')
})

// The bare 304 of `vite preview` lacked COOP/COEP, and WebKit then refused the worker of a page loaded a
// second time (found by walk-auto; the browser spec `preview-revalidation` is the WebKit proof). The fix is
// every serve, so both apps, and neither is started with a walk port here.
test('walk-preview: a revalidation (304) keeps COOP/COEP and every response is no-store, in both apps, without --walk', async () => {
  expect(existsSync(join(root, 'games/reference/dist/index.html')), 'run pnpm test').toBe(true)
  const [portF, portR] = [14393, 14394]
  preview(portF)
  previewReference(portR)
  await Promise.all([up(portF), up(portR, '/')])
  for (const [base, path] of [
    [`http://127.0.0.1:${portF}`, '/determinism.html'],
    [`http://127.0.0.1:${portR}`, '/index.html'],
  ] as const) {
    const first = await fetch(base + path)
    const etag = first.headers.get('etag')
    expect(etag, `${base} sends an ETag to revalidate against`).toBeTruthy()
    const again = await fetch(base + path, { headers: { 'if-none-match': etag as string } })
    expect([base, again.status]).toEqual([base, 304])
    for (const r of [first, again]) {
      expect(r.headers.get('cross-origin-opener-policy'), `${base} ${r.status}`).toBe('same-origin')
      expect(r.headers.get('cross-origin-embedder-policy'), `${base} ${r.status}`).toBe(
        'require-corp',
      )
      expect(r.headers.get('cache-control'), `${base} ${r.status}`).toBe('no-store')
    }
  }
}, 60_000)
