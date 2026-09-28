// `device-serve/proxy-and-apps` (docs/plan/29-net-worker-and-reference-server.md Scope/Tests
// added, Part A of the final cut): spawns `pnpm device:serve`'s own script twice -- default app
// (the fixture app) with `--ws puts`, then `--app reference` with `--ws puts` too (Deviations: the
// exit criterion's own literal `--app reference --ws`, with no fixture named, points the child
// `games/reference-server` at the reference game's own build, which is not yet multiplayer before
// M34 and fails `engine_init: BadConfig` there -- the same pre-existing, out-of-scope gap steps 3-4
// already flagged for `client_on_welcome`'s own seed/params handling. `--ws puts` is well inside
// `--ws [<fixture>]`'s own grammar, independent of `--app`, and is what this test uses for both
// modes so it proves the real thing this exit criterion cares about -- the proxy and both apps --
// without also re-proving a gap this milestone does not own fixing) -- for each mode: fetches `/`
// and checks the COOP/COEP headers every page of this repo's apps carries (0015 §3), then opens a
// real `WebSocket` to `/ws` and confirms the upgrade succeeds through Vite's own `preview.proxy`
// reaching the real `games/reference-server` child on its own port.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const deviceServeScript = fileURLToPath(new URL('../../scripts/device-serve.mjs', import.meta.url))

// Distinct from the real `pnpm device:serve` defaults (4173/4174, `device-serve.mjs`'s own doc
// comment): this test must never collide with a real interactive session on Tyler's machine
// (`shared-machine-foreign-e2e` memory note) or with a concurrent `pnpm test` worker.
const PORT = 14273
const WS_PORT = 14274

let child: ReturnType<typeof spawn> | undefined

afterEach(async () => {
  if (!child) return
  const exited = new Promise<void>((resolve) => child?.on('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
  child = undefined
})

/** Waits for the script's own `pages: ...` line (printed only after `vite preview` -- and, when
 * `--ws` is set, the `games/reference-server` child's own `listening:` line -- have both already
 * been confirmed up). */
function waitReady(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = ''
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      if (/^pages: /m.test(buf)) resolve()
    })
    proc.on('error', reject)
    proc.on('exit', (code) => reject(new Error(`device-serve.mjs exited ${code} before ready`)))
  })
}

/** Real WebSocket upgrade through Vite's own `preview.proxy['/ws']` to the real `games/
 * reference-server` child -- `onopen` firing is proof the HTTP Upgrade (and hence the proxy target
 * being a live, accepting socket) succeeded; this never needs the world itself to finish loading
 * (0024 §5: a connection is queued before `ready`, not refused). */
function wsUpgradeSucceeds(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`${url}: no 'open' within 5s`))
    }, 5000)
    ws.onopen = () => {
      clearTimeout(timer)
      ws.close()
      resolve()
    }
    ws.onerror = () => {
      // A real close/error still follows; let the timeout or onclose path report it.
    }
  })
}

async function checkMode(args: string[]): Promise<void> {
  child = spawn(process.execPath, [deviceServeScript, ...args], {
    env: { ...process.env, ENGINE_TEST_PORT: String(PORT), ENGINE_WS_PORT: String(WS_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitReady(child)

  const res = await fetch(`http://127.0.0.1:${PORT}/`)
  expect(res.status, `${args.join(' ')}: GET /`).toBe(200)
  expect(res.headers.get('cross-origin-opener-policy'), `${args.join(' ')}: COOP`).toBe(
    'same-origin',
  )
  expect(res.headers.get('cross-origin-embedder-policy'), `${args.join(' ')}: COEP`).toBe(
    'require-corp',
  )

  await wsUpgradeSucceeds(`ws://127.0.0.1:${PORT}/ws`)

  const exited = new Promise<void>((resolve) => child?.on('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
  child = undefined
}

test('device-serve/proxy-and-apps @slow', async () => {
  await checkMode(['--ws', 'puts'])
  await checkMode(['--app', 'reference', '--ws', 'puts'])
}, 60_000)
