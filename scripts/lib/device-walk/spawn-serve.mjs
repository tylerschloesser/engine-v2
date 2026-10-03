// The real `spawnServe` for servers.mjs: `node packages/engine/scripts/device-serve.mjs <flags>`,
// plus a pid file so a tool killed with SIGKILL does not leave a server behind for good.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const SCRIPT = join(REPO, 'packages/engine/scripts/device-serve.mjs')
const PID_FILE = join(REPO, 'test-results/device-walk-pids.json')

const readPids = () => {
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf8'))
  } catch {
    return []
  }
}
const writePids = (pids) => {
  mkdirSync(dirname(PID_FILE), { recursive: true })
  writeFileSync(PID_FILE, JSON.stringify(pids))
}

/** Kill `device-serve` children left by an earlier tool that died hard. Returns the pids signalled. */
export function reapStale() {
  const killed = []
  for (const pid of readPids()) {
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
      if (cmd.includes('device-serve.mjs')) {
        process.kill(pid, 'SIGTERM')
        killed.push(pid)
      }
    } catch {
      // gone already
    }
  }
  writePids([])
  return killed
}

export function spawnServe(args, { onLine, onExit, env }) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  writePids([...readPids(), child.pid])
  for (const stream of [child.stdout, child.stderr]) {
    let rest = ''
    stream.on('data', (d) => {
      const parts = (rest + d).split('\n')
      rest = parts.pop()
      for (const line of parts) onLine(line.replace(/\r$/, ''))
    })
  }
  let exited = false
  child.on('exit', (code) => {
    exited = true
    writePids(readPids().filter((p) => p !== child.pid))
    onExit(code)
  })
  child.on('error', () => onExit(-1))
  return {
    pid: child.pid,
    stop() {
      if (exited) return Promise.resolve()
      return new Promise((resolve) => {
        const force = setTimeout(() => child.kill('SIGKILL'), 15_000)
        child.once('exit', () => {
          clearTimeout(force)
          resolve()
        })
        child.kill('SIGTERM')
      })
    },
  }
}
