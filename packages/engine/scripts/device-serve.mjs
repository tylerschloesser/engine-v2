// `pnpm device:serve [--tunnel]` (docs/plan/03-browser-harness.md, Planning decisions "Determinism
// on a physical phone"). Builds the fixture app (dev profile, same build as `pnpm test`'s `pages`
// step) and serves it statically with `vite preview` on `127.0.0.1:4173` (no HMR socket; the
// engine plugin's COOP/COEP headers land on every response the same as under `vite preview` in the
// suite). `--tunnel` additionally runs a Cloudflare quick tunnel (`cloudflared tunnel --url
// http://127.0.0.1:4173`: HTTPS, no account; Tyler approved it, Q7) and prints the
// `https://….trycloudflare.com/determinism.html` URL. Never run by `pnpm test`.
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { toolEnv } from '../../../scripts/lib/env.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const configPath = 'packages/engine/tests/browser/pages/vite.config.ts'
const port = 4173
const tunnel = process.argv.includes('--tunnel')

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    )
  })
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

console.log('building the fixture app (dev profile)…')
await run('pnpm', ['exec', 'vite', 'build', '--config', configPath], { env: toolEnv() })

const previewEnv = {
  ...toolEnv(),
  ENGINE_TEST_PORT: String(port), // the app config's port/allowedHosts read this (Seams)
  ...(tunnel ? { ENGINE_DEVICE: '1' } : {}),
}
const preview = spawn(
  'pnpm',
  ['exec', 'vite', 'preview', '--config', configPath, '--host', '127.0.0.1'],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: previewEnv },
)
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
      console.log(`\n${match[0]}/determinism.html`)
    }
  }
  cloudflared.stdout.on('data', onChunk)
  cloudflared.stderr.on('data', onChunk)
} else {
  console.log(`http://127.0.0.1:${port}/determinism.html`)
}

const shutdown = () => {
  preview.kill()
  cloudflared?.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
