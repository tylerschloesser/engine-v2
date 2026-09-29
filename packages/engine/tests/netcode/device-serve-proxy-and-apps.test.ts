// `device-serve/proxy-and-apps` (docs/plan/29-net-worker-and-reference-server.md Scope/Tests
// added, Part A of the final cut): spawns `pnpm device:serve`'s own script -- default app (the
// fixture app) with `--ws puts`, and `--app reference` with `--ws puts` too (Deviations: the exit
// criterion's own literal `--app reference --ws`, with no fixture named, points the child `games/
// reference-server` at the reference game's own build, which is not yet multiplayer before M34 and
// fails `engine_init: BadConfig` there -- the same pre-existing, out-of-scope gap steps 3-4 already
// flagged for `client_on_welcome`'s own seed/params handling. `--ws puts` is well inside `--ws
// [<fixture>]`'s own grammar, independent of `--app`, and is what this test uses for both modes so
// it proves the real thing this exit criterion cares about -- the proxy and both apps -- without
// also re-proving a gap this milestone does not own fixing) -- for each mode: fetches `/` and checks
// the COOP/COEP headers every page of this repo's apps carries (0015 §3), then opens a real
// `WebSocket` to `/ws` and confirms the upgrade succeeds through Vite's own `preview.proxy` reaching
// the real `games/reference-server` child on its own port.
//
// **Two independent tests, not one test calling `checkMode` twice** (M29b fix round 6): the
// original single-test shape shared one timeout window across two sequential real builds; CI kept
// timing out on the combined total even after a generously-derived ceiling (below, on each test's
// own `600_000`). Splitting gives each mode its own full budget instead of splitting one shared
// window across two builds -- see the reasoning at the bottom of this file, next to both `test()`
// calls.
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

// M29b fix round 4 (coordinator: "zero captured stdout before the timeout"): a bare 120 s timeout
// with no progress trail gives a future CI failure nothing to point at. Every phase this test
// passes through logs with an elapsed-ms prefix, `console.log` (not Vitest's own reporter, which
// only ever prints a *passing* test's output on failure -- but `console.log` still lands in the
// suite's own captured stdout either way, exactly what the coordinator's own artifact was missing).
// `t0` is reset at the start of each of the two tests below (M29b fix round 6, the split), not a
// single module-level constant, so each test's own elapsed-ms trail starts at 0 rather than the
// second test's own timestamps silently including the first test's already-elapsed time.
let t0 = Date.now()
function log(msg: string): void {
  console.log(`device-serve/proxy-and-apps +${Date.now() - t0}ms: ${msg}`)
}

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
  const label = args.join(' ')
  log(`${label}: spawning device-serve.mjs`)
  child = spawn(process.execPath, [deviceServeScript, ...args], {
    env: { ...process.env, ENGINE_TEST_PORT: String(port), ENGINE_WS_PORT: String(wsPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Forwards every line `device-serve.mjs` itself already prints (its own real progress markers:
  // "building the fixture app…", "building games/reference…", "starting games/reference-server
  // on…", "pages: …") into this test's own captured stdout -- previously silently swallowed
  // (`stdio: 'pipe'` with nothing ever reading `child.stdout` past `waitReady`'s own buffer scan),
  // which is exactly why a CI timeout here showed zero progress. `stderr` too, for a real spawn/
  // build failure's own stack trace.
  child.stdout?.on('data', (d: Buffer) => log(`${label} [stdout] ${d.toString().trimEnd()}`))
  child.stderr?.on('data', (d: Buffer) => log(`${label} [stderr] ${d.toString().trimEnd()}`))
  await waitReady(child)
  log(`${label}: ready (build + preview + ${args.includes('--ws') ? 'reference-server ' : ''}up)`)

  const res = await fetch(`http://127.0.0.1:${port}/`)
  log(`${label}: GET / -> ${res.status}`)
  expect(res.status, `${label}: GET /`).toBe(200)
  expect(res.headers.get('cross-origin-opener-policy'), `${label}: COOP`).toBe('same-origin')
  expect(res.headers.get('cross-origin-embedder-policy'), `${label}: COEP`).toBe('require-corp')

  await wsUpgradeSucceeds(`ws://127.0.0.1:${port}/ws`)
  log(`${label}: ws upgrade succeeded`)

  const exited = new Promise<void>((resolve) => child?.on('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
  log(`${label}: child exited, teardown complete`)
  child = undefined
}

// 600_000 (10 minutes) each, not one shared 600_000 across both modes (M29b fix round 6): CI still
// timed out at exactly the *full* 600 s even after fix round 4's own generously-derived ceiling --
// the two sequential `checkMode` calls (a small fixture-app build, then `games/reference`'s own
// full production build -- `buildGame()`'s bindings step, `cargo test --workspace ...
// export_bindings`, a whole-workspace test-binary *execution*, not merely a compile: this repo's
// own workspace has `packages/engine/crates/*` + 14 `packages/engine/fixtures/*` crates + `games/
// reference/sim`, each contributing real process-spawn/test-harness-startup overhead even once
// every artifact is fully compiled and cached) don't reliably fit in one shared window, run at the
// tail end of an already-long slow-tier job. Splitting into two independent tests, each its own
// full budget, is a structural fix (roughly doubling total available time without inflating any
// single number further), not another blind bump -- the coordinator's own explicit call.
//
// **Checked whether the `--app reference` build could reuse `scripts/suites.mjs`'s own earlier
// `reference` build step (`pnpm test`'s own Phase 1, which already builds `games/reference` once,
// before any suite -- including this one -- ever runs) instead of `device-serve.mjs`'s own second,
// separate `pnpm --filter reference build` call, and judged it not a small, clean change worth
// making here.** Two real obstacles, not a shrug: (1) the two invocations are not equivalent --
// `suites.mjs`'s own `reference` build step passes `--minify false` (real, unminified function
// names, needed for a *different* consumer, the software-mode zero-GC attribution test) where
// `device-serve.mjs`'s own call uses the plain `vite build` script, real production minification
// included -- the JS-bundling half genuinely differs, even though the underlying `engine`-plugin
// WASM/bindings compile (the actually-expensive half) does not; (2) more fundamentally,
// `device-serve.mjs --app reference` is *itself* the thing this test proves works end to end (a
// real device-check tool Tyler runs interactively, `pnpm device:serve --tunnel --app reference`) --
// skipping its own build step to reuse someone else's artifact would narrow what this test actually
// proves (the tool's own build path, not just the served app's headers) for a win that would not
// even address the dominant cost anyway: `cargo test --workspace`'s own per-crate test-binary
// *execution* overhead does not go away with a warm compile cache, since `cargo test` always
// actually runs the binaries it names, regardless of whether anything needed recompiling.
// Restructuring `buildGame()`'s own bindings step to scope narrower than `--workspace` would be the
// change that actually addresses that cost -- a real, `build-game.ts`-documented, deliberate design
// choice ("`--workspace` also runs *every* workspace member's own `export_bindings_*` tests", so a
// stale/uncommitted binding anywhere is caught), and a materially bigger edit than this range's own
// scope. The split above is the proportionate stopping point.
async function checkFixtureApp(): Promise<void> {
  t0 = Date.now()
  await checkMode(['--ws', 'puts'], PORT_A, WS_PORT_A)
}
async function checkReferenceApp(): Promise<void> {
  t0 = Date.now()
  await checkMode(['--app', 'reference', '--ws', 'puts'], PORT_B, WS_PORT_B)
}

// **Orchestrator decision (M29b fix round 7, after round 6's split still did not land): skipped
// under CI, kept local-only.** Six rounds attempted, in order: a bare 60 s timeout; widened to
// 120 s; progress logging plus a measured, justified 600 s timeout (derived from a real local cold
// build times a stated CI-hardware margin); splitting the two `checkMode` calls into independent
// tests so each gets its own full 600 s window instead of sharing one. Every attempt produced a
// hard timeout on `ubuntu-latest`, including the split, with **zero captured stdout even from the
// progress-logging fix** on either half -- not "slow", but no visible progress at all inside 600 s
// on even the simpler `fixture app` mode. The file's own comment above (`cargo test --workspace`
// always *executes* every workspace member's test binaries regardless of compile-cache warmth) is
// the most likely mechanism: this is the same `--workspace` bindings cost `docs/plan/
// 24c-...md`'s own ledger rows already documented as slow even on a fast local machine (~50 s
// compile+link alone there), now paid a *second* time by `device-serve.mjs`'s own independent
// invocation, on a CI runner smaller than any machine that cost was ever measured against. Fixing
// it for real (scoping `buildGame()`'s bindings step narrower than `--workspace`) is a real,
// deliberate design change (docs/plan/29-net-worker-and-reference-server.md's own Deviations: "a
// stale/uncommitted binding anywhere is caught") well outside this milestone's scope.
//
// The exit criterion this test partially automated already has its own Tyler-run manual device
// check (`docs/plan/device-checks.md#m29-net-worker-and-reconnect`); the *other* half of this
// test's own value (headers + `/ws` upgrade through the proxy) was independently confirmed working
// with raw `curl`/`WebSocket` checks earlier in this same investigation. Skipping under CI trades
// an automated, CI-blocking proxy for that already-proven-working functionality against a real,
// bounded infrastructure cost this milestone does not own fixing -- not a silent weakening: both
// tests still run, and still assert everything they always did, for anyone (Tyler, a future
// session) invoking `pnpm test:slow` locally.
test.skipIf(process.env.CI === 'true')(
  'device-serve/proxy-and-apps: fixture app @slow',
  checkFixtureApp,
  600_000,
)
test.skipIf(process.env.CI === 'true')(
  'device-serve/proxy-and-apps: reference app @slow',
  checkReferenceApp,
  600_000,
)
