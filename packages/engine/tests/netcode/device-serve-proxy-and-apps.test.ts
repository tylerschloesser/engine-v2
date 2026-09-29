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
// (`shared-machine-foreign-e2e` memory note) or with a concurrent `pnpm test` worker. Two distinct
// pairs, one per `checkMode` call (M29b fix round 2): `device-serve.mjs`'s own `shutdown` now
// properly awaits its children's real exit before returning (the teardown-ordering bug this file's
// own read surfaced), but reusing one port pair across two sequential real server spawns still made
// the second mode's own bind depend on the first mode's own teardown finishing in time regardless --
// distinct ports remove that dependency structurally, not just make it faster.
const PORT_A = 14273
const WS_PORT_A = 14274
const PORT_B = 14275
const WS_PORT_B = 14276

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

async function checkMode(args: string[], port: number, wsPort: number): Promise<void> {
  child = spawn(process.execPath, [deviceServeScript, ...args], {
    env: { ...process.env, ENGINE_TEST_PORT: String(port), ENGINE_WS_PORT: String(wsPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitReady(child)

  const res = await fetch(`http://127.0.0.1:${port}/`)
  expect(res.status, `${args.join(' ')}: GET /`).toBe(200)
  expect(res.headers.get('cross-origin-opener-policy'), `${args.join(' ')}: COOP`).toBe(
    'same-origin',
  )
  expect(res.headers.get('cross-origin-embedder-policy'), `${args.join(' ')}: COEP`).toBe(
    'require-corp',
  )

  await wsUpgradeSucceeds(`ws://127.0.0.1:${port}/ws`)

  const exited = new Promise<void>((resolve) => child?.on('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
  child = undefined
}

// 120_000, not 60_000 (M29b fix round 1): two real `vite build`+`preview` cycles (`--app reference`
// builds `games/reference` fresh) plus two real child-process spawns, measured locally at ~3-18 s
// total on a 14-core machine -- CI's own slow tier found this timing out at 60 s on its first run,
// alongside *other*, unrelated slow-tier tests also newly timing out (`docs/plan/
// 29-net-worker-and-reference-server.md`'s own Deviations), the signature of a CPU-starved CI
// runner rather than a defect in this test's own logic. `netcode` is now `soloTiers: ['slow']`
// (`scripts/suites.mjs`), which removes contention from the concurrently-running `browser` suite;
// this margin is the remaining defense for `netcode`'s own internal concurrency (several test files
// in this same suite run at once) on CI's weaker-than-this-dev-machine hardware. **Still timed out
// at 120 s on CI (M29b fix round 2)** -- traced two real, independent contributors, both fixed: (1)
// `device-serve.mjs`'s own `shutdown` fired `.kill()` on its children and called `process.exit(0)`
// immediately, with no wait -- a real teardown-ordering bug (fixed there, its own doc comment); (2)
// `netcode`'s slow tier still runs its own five test files concurrently *within itself* even once
// `soloTiers` removed the `browser` suite's own external contention -- `reference-server/smoke`'s
// real server spawn, the `ws/*` tests' real sockets, and this test's own two real `vite build`
// cycles all still compete for CI's own real (and apparently scarce) CPU at the same time (fixed in
// `scripts/suites.mjs`: `netcode` now runs its own slow-tier test files one at a time, not
// `soloTiers`-adjacent contention but the next layer down). This test's own two `checkMode` calls
// also moved to distinct port pairs (below), removing any dependency on teardown timing between them
// regardless of either fix above.
test('device-serve/proxy-and-apps @slow', async () => {
  await checkMode(['--ws', 'puts'], PORT_A, WS_PORT_A)
  await checkMode(['--app', 'reference', '--ws', 'puts'], PORT_B, WS_PORT_B)
}, 120_000)
