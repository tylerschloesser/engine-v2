// `pnpm device:serve [--tunnel] [--ws [<fixture>]] [--app reference [--bench]]` (docs/plan/03-browser-
// harness.md, Planning decisions "Determinism on a physical phone"; docs/plan/
// 29-net-worker-and-reference-server.md Scope). Builds an app and serves it statically with `vite
// preview` on `127.0.0.1:4173` (no HMR socket; the engine plugin's COOP/COEP headers land on every
// response the same as under `vite preview` in the suite). `--tunnel` additionally runs a
// Cloudflare quick tunnel (`cloudflared tunnel --url http://127.0.0.1:4173`: HTTPS, no account;
// Tyler approved it, Q7) and prints every served page's own tunnelled URL. Never run by `pnpm test`.
//
// `--ws [<fixture>]`: spawns `node games/reference-server` as a child on `127.0.0.1:4174`, its own
// real-time timer (not `startTestServer`'s manual one) -- `--game` is the named fixture's dev-profile
// build output, default the reference game's own release build (`index.mjs`'s own default), `--data`
// a fresh temp dir. The served app's own `vite.config.ts` gets `preview.proxy['/ws']` pointed at it
// (`ENGINE_WS_PROXY_PORT`, read by both `tests/browser/pages/vite.config.ts` and `games/reference/
// vite.config.ts`), so an `https` tunnel page (which cannot open a plain `ws://`) reaches it through
// `wsUrl(location)` on its own origin. The child is killed (and confirmed exited) on shutdown.
//
// `--app reference`: builds and previews `games/reference` (its own Vite config, release profile)
// instead of the fixture app, on the same port/tunnel/proxy. Before M34 the reference game ignores
// the socket and this still serves it single-player.
//
// `--bench` (only with `--app reference`; M39 acceptance, "From M36" note 2): builds with `vite build
// --mode bench` (cargo feature `bench`, `__BENCH__` true, output `games/reference/dist-bench/`) and
// previews that build with `vite preview --mode bench`, so `?bench=large-save` and its `#bench-hud`
// exist on the phone. The bench build is the production page alone (no `test.html`/`gc.html`).
// `--tunnel` and `--ws` combine with it unchanged.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolEnv } from '../../../scripts/lib/env.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const fixtureConfigPath = 'packages/engine/tests/browser/pages/vite.config.ts'
const fixturePagesDir = fileURLToPath(new URL('../tests/browser/pages/', import.meta.url))
const referenceDir = fileURLToPath(new URL('../../../games/reference/', import.meta.url))
const referenceServerEntry = fileURLToPath(
  new URL('../../../games/reference-server', import.meta.url),
)
const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))
const referenceReleaseGameDir = fileURLToPath(
  new URL('../../../games/reference/sim/target/engine/release', import.meta.url),
)

const port = Number(process.env.ENGINE_TEST_PORT ?? 4173)
const wsPort = Number(process.env.ENGINE_WS_PORT ?? 4174)

const argv = process.argv.slice(2)
const tunnel = argv.includes('--tunnel')
const appIndex = argv.indexOf('--app')
const app = appIndex >= 0 ? argv[appIndex + 1] : undefined
if (app !== undefined && app !== 'reference') {
  console.error(`device-serve: unknown --app '${app}' (only 'reference' is supported)`)
  process.exit(1)
}
const bench = argv.includes('--bench')
if (bench && app !== 'reference') {
  console.error('device-serve: --bench is only valid with --app reference')
  process.exit(1)
}
const wsIndex = argv.indexOf('--ws')
const ws = wsIndex >= 0
const wsFixtureArg = argv[wsIndex + 1]
const wsFixture = ws && wsFixtureArg && !wsFixtureArg.startsWith('--') ? wsFixtureArg : undefined

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    )
  })
}

/** Every `*.html` page an app's own dev/build root serves, so `mp.html`/`gc.html`/etc. are listed
 * without hand-maintaining a second list here (exit criterion: "`pnpm device:serve --ws puts`
 * lists `mp.html`"). */
function htmlPages(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => e.name)
    .sort()
}

if (tunnel) {
  const probe = spawnSync('cloudflared', ['--version'], { env: toolEnv() })
  if (probe.error || probe.status !== 0) {
    console.log(
      'cloudflared not found: install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then re-run pnpm device:serve --tunnel',
    )
    process.exit(1)
  }
}

// --- `--ws`: the real `games/reference-server` child, real-time timer ---------------------------
let wsChild
let wsDataDir
if (ws) {
  const gameDir = wsFixture
    ? join(fixturesRoot, wsFixture, 'target', 'engine', 'dev')
    : referenceReleaseGameDir
  if (!existsSync(gameDir)) {
    console.error(
      `device-serve --ws: no built game at ${gameDir} (build it first: ` +
        `${wsFixture ? `it is a fixture, built by 'pnpm test' or 'pnpm test unit -t fixtures'` : `'pnpm --filter reference build'`})`,
    )
    process.exit(1)
  }
  wsDataDir = await mkdtemp(join(tmpdir(), 'device-serve-ws-'))
  console.log(`starting games/reference-server on 127.0.0.1:${wsPort} (--game ${gameDir})…`)
  wsChild = spawn(
    process.execPath,
    [referenceServerEntry, '--game', gameDir, '--data', wsDataDir],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, PORT: String(wsPort) },
    },
  )
  wsChild.stdout.on('data', (d) => process.stdout.write(`[reference-server] ${d}`))
  await new Promise((resolve, reject) => {
    wsChild.stdout.on('data', function onData(d) {
      if (String(d).includes('listening:')) {
        wsChild.stdout.off('data', onData)
        resolve()
      }
    })
    wsChild.on('error', reject)
    wsChild.on('close', (code) => reject(new Error(`games/reference-server exited ${code}`)))
  })
}

// --- The app itself (fixture, default, or `--app reference`) -----------------------------------
const configPath = app === 'reference' ? undefined : fixtureConfigPath
const previewCwd = app === 'reference' ? referenceDir : root
const pagesDir = app === 'reference' ? referenceDir : fixturePagesDir

console.log(
  app === 'reference'
    ? bench
      ? 'building games/reference (bench build, dist-bench/)…'
      : 'building games/reference (release profile)…'
    : 'building the fixture app (dev profile)…',
)
if (app === 'reference') {
  await run('pnpm', ['--filter', 'reference', 'build', ...(bench ? ['--mode', 'bench'] : [])], {
    env: toolEnv(),
  })
} else {
  await run('pnpm', ['exec', 'vite', 'build', '--config', configPath], { env: toolEnv() })
}

const previewEnv = {
  ...toolEnv(),
  ENGINE_TEST_PORT: String(port), // both apps' own configs read this for port/allowedHosts (Seams)
  ...(tunnel ? { ENGINE_DEVICE: '1' } : {}),
  ...(ws ? { ENGINE_WS_PROXY_PORT: String(wsPort) } : {}),
}
const previewArgs =
  app === 'reference'
    ? ['exec', 'vite', 'preview', '--host', '127.0.0.1', ...(bench ? ['--mode', 'bench'] : [])]
    : ['exec', 'vite', 'preview', '--config', configPath, '--host', '127.0.0.1']
// `detached: true` (M29b fix round 2): `preview` is `pnpm exec vite preview`, and the real HTTP
// listener -- the port a subsequent run actually needs released -- lives in `vite`, a *grandchild*
// of this process (pnpm's own child), not `preview` itself. A plain `preview.kill()` only signals
// the `pnpm` wrapper; whether that forwards to `vite` is pnpm's own implementation detail, not a
// contract this script can rely on. `detached` makes `preview` its own process-group leader, so
// `shutdown` below can kill the *whole group* (`process.kill(-preview.pid, ...)`) -- `pnpm` and
// `vite` both, regardless of whether pnpm forwards anything itself.
const preview = spawn('pnpm', previewArgs, {
  cwd: previewCwd,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: previewEnv,
  detached: true,
})
preview.stdout.on('data', (d) => process.stdout.write(d))

await new Promise((resolve, reject) => {
  preview.stdout.on('data', function onData(d) {
    if (String(d).includes(`:${port}`)) {
      preview.stdout.off('data', onData)
      resolve()
    }
  })
  preview.on('error', reject)
  preview.on('close', (code) => reject(new Error(`vite preview exited ${code}`)))
})

// The bench build is the production page alone, so only `index.html` exists in `dist-bench/`.
const pages = bench ? ['index.html'] : htmlPages(pagesDir)
console.log(`pages: ${pages.join(', ')}`)
// Machine-readable lines for `pnpm device:walk` (M39e): the loopback origin, then (with --tunnel) the
// tunnel origin once cloudflared prints it.
console.log(`DEVICE_SERVE_URL=http://127.0.0.1:${port}`)

let cloudflared
if (tunnel) {
  console.log('starting the Cloudflare quick tunnel…')
  cloudflared = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: toolEnv(),
  })
  const printed = new Set()
  const onChunk = (d) => {
    const text = String(d)
    process.stderr.write(text) // cloudflared's own progress lines
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)
    if (match && !printed.has(match[0])) {
      printed.add(match[0])
      console.log(`DEVICE_SERVE_TUNNEL_URL=${match[0]}`)
      for (const page of pages) console.log(`${match[0]}/${page}`)
    }
  }
  cloudflared.stdout.on('data', onChunk)
  cloudflared.stderr.on('data', onChunk)
} else {
  for (const page of pages) console.log(`http://127.0.0.1:${port}/${page}`)
}

// Waits for `proc` to actually exit (its own port genuinely released, not merely signalled) before
// resolving -- a plain `.kill()` only requests the exit; `process.exit(0)` right after it, with no
// wait, was a real bug (M29b fix round 2: found reading `checkMode`'s own teardown-ordering question
// against this file, `device-serve-proxy-and-apps.test.ts`'s own two sequential `checkMode` calls
// share one port pair, so the *next* mode's own `vite preview --strictPort`/`WebSocketServer` bind
// races whatever's left of the *previous* mode's own child here). A dead process resolves
// immediately (`proc.exitCode !== null`); `SIGKILL` after 5 s is the same bounded-wait-then-force
// shape `net-harness.ts`/`test-server.ts` already use for a real HTTP/WS server's own accepted
// sockets, applied here to a whole child *process* instead.
function waitExit(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const shutdown = async () => {
  // `-preview.pid` (the process-group form of `kill(2)`): `preview` was spawned `detached: true`
  // for exactly this (its own doc comment) -- signals `pnpm` and its own `vite` child together.
  try {
    process.kill(-preview.pid, 'SIGTERM')
  } catch {
    preview.kill() // the group is already gone (e.g. `pnpm` already exited on its own)
  }
  cloudflared?.kill()
  if (wsChild) wsChild.kill()
  await Promise.all([
    waitExit(preview),
    cloudflared ? waitExit(cloudflared) : undefined,
    wsChild ? waitExit(wsChild) : undefined,
  ])
  if (wsDataDir) await rm(wsDataDir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
