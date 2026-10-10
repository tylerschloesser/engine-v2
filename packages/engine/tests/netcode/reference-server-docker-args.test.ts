// `reference-server/docker-args` (M38, Tests added): the Dockerfile and
// `fly.toml` agree with each other and with the server's own CLI on the port, the data directory and
// the static directory. A parse test: no Docker, no Fly.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { referenceServerDir } from '../support/reference-server.js'

const read = (f: string) => readFileSync(join(referenceServerDir, f), 'utf8')

test('reference-server/docker-args', () => {
  const dockerfile = read('Dockerfile')
  const fly = read('fly.toml')
  const server = read('index.mjs')

  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)?.[1] ?? 'null') as string[]
  expect(cmd.slice(0, 2)).toEqual(['node', 'games/reference-server/index.mjs'])
  const flags = cmd.filter((a) => a.startsWith('--')).map((a) => a.slice(2))
  // Every flag the image passes is one the server parses.
  const parsed = [
    ...(/options: \{([\s\S]*?)\n {2}\},/.exec(server)?.[1] ?? '').matchAll(
      /^\s+'?([a-z-]+)'?: \{/gm,
    ),
  ]
  const known = parsed.map((m) => m[1])
  for (const f of flags) expect(known, `--${f} is a server option`).toContain(f)
  const arg = (name: string) => cmd[cmd.indexOf(`--${name}`) + 1]

  // The volume is the data dir.
  const mount = /\[\[mounts\]\][\s\S]*?destination = '([^']+)'/.exec(fly)?.[1]
  expect(arg('data')).toBe(mount)

  // The built client is copied to the static dir (`COPY .stage/ /app/`, stage-image.mjs puts it at `client`).
  expect(dockerfile).toMatch(/^COPY \.stage\/ \/app\/$/m)
  expect(read('scripts/stage-image.mjs')).toContain("'client'")
  expect(arg('static')).toBe('/app/client')

  // Port: the env the server reads, the image's EXPOSE and the proxy's internal port are one number.
  const envPort = /^ENV PORT=(\d+)$/m.exec(dockerfile)?.[1]
  expect(/^EXPOSE (\d+)$/m.exec(dockerfile)?.[1]).toBe(envPort)
  expect(/internal_port = (\d+)/.exec(fly)?.[1]).toBe(envPort)
  expect(/\[env\][\s\S]*?PORT = '(\d+)'/.exec(fly)?.[1]).toBe(envPort)
  // Reachable from the proxy: bound on all interfaces, which `index.mjs` reads from `HOST`.
  expect(server).toContain('process.env.HOST')
  expect(dockerfile).toMatch(/^ENV HOST=0\.0\.0\.0$/m)
  expect(fly).toMatch(/HOST = '0\.0\.0\.0'/)

  // Idle stop: the process exits on idle and the proxy autostops/autostarts with no minimum.
  expect(flags).toContain('exit-on-idle')
  expect(fly).toMatch(/auto_stop_machines = 'stop'/)
  expect(fly).toMatch(/auto_start_machines = true/)
  expect(fly).toMatch(/min_machines_running = 0/)
  // 0005 Cadence: the snapshot on the shutdown signal needs the signal and time.
  expect(fly).toMatch(/kill_signal = 'SIGTERM'/)
  expect(Number(/kill_timeout = (\d+)/.exec(fly)?.[1])).toBeGreaterThanOrEqual(10)
})
