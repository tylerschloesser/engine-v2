// `previewHeaders` (`packages/engine/scripts/preview-headers.ts`), against real `vite preview` processes of
// the fixture pages' and the reference game's own build output (`pnpm test` builds both).
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const pagesDir = join(root, 'packages/engine/tests/browser/pages')
const viteBin = join(root, 'node_modules/vite/bin/vite.js')
const children: ChildProcess[] = []

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
})

/** `vite preview` of `games/reference` (its own config, release output). */
function previewReference(port: number): ChildProcess {
  const child = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1'], {
    cwd: join(root, 'games/reference'),
    stdio: 'ignore',
    env: { ...process.env, ENGINE_TEST_PORT: String(port) },
  })
  children.push(child)
  return child
}

/** `vite preview` of the fixture pages. */
function preview(port: number): ChildProcess {
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--config', join(pagesDir, 'vite.config.ts'), '--host', '127.0.0.1'],
    { cwd: root, stdio: 'ignore', env: { ...process.env, ENGINE_TEST_PORT: String(port) } },
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

// The bare 304 of `vite preview` lacked COOP/COEP, and WebKit then refused the worker of a page loaded a
// second time (the browser spec `preview-revalidation` is the WebKit proof). The fix is
// every serve, so both apps.
test('preview-headers: a revalidation (304) keeps COOP/COEP and every response is no-store, in both apps', async () => {
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
