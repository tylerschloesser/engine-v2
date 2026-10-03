// The real `spawnServe` for servers.mjs: `node packages/engine/scripts/device-serve.mjs <flags>`,
// plus a pid file so a tool killed with SIGKILL does not leave a server behind for good.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const SCRIPT = join(REPO, 'packages/engine/scripts/device-serve.mjs')
const PID_FILE = join(REPO, 'test-results/device-walk-pids.json')

// Entries are `{ pid, owner }`: `owner` is the `device:walk` process that started the server. A bare
// number (a file written before M39f) has no owner and is never reaped: killing a server whose tool is
// still alive pulls the rug from under someone else's round (M39f step 3, found the hard way).
const readPids = (file = PID_FILE) => {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
const writePids = (pids, file = PID_FILE) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(pids))
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const commandOf = (pid) =>
  execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })

/**
 * Kill `device-serve` children left by an earlier tool that died hard: entries whose owning tool is no
 * longer running (and whose pid is still a `device-serve.mjs`). Returns the pids signalled. Entries of a
 * live owner, and legacy entries without one, stay in the file untouched.
 */
export function reapStale({
  file = PID_FILE,
  isAlive = alive,
  command = commandOf,
  kill = process.kill,
} = {}) {
  const killed = []
  const keep = []
  for (const e of readPids(file)) {
    if (typeof e?.pid !== 'number' || typeof e.owner !== 'number' || isAlive(e.owner)) {
      keep.push(e)
      continue
    }
    try {
      if (command(e.pid).includes('device-serve.mjs')) {
        kill(e.pid, 'SIGTERM')
        killed.push(e.pid)
      }
    } catch {
      // gone already
    }
  }
  writePids(keep, file)
  return killed
}

export function spawnServe(args, { onLine, onExit, env }) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  writePids([...readPids(), { pid: child.pid, owner: process.pid }])
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
    writePids(readPids().filter((e) => e?.pid !== child.pid))
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
