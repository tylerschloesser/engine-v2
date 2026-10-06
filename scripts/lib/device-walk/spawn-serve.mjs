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

/** The processes on this machine, `{ pid, ppid, command, ports }`: `ps` joined with the listening TCP ports of `lsof`. */
function listProcesses() {
  const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  })
  const ports = new Map()
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
      encoding: 'utf8',
      maxBuffer: 16 << 20,
    })
    let pid = 0
    for (const l of out.split('\n')) {
      if (l[0] === 'p') pid = Number(l.slice(1))
      else if (l[0] === 'n') {
        const m = /:(\d+)$/.exec(l)
        if (m) ports.set(pid, [...(ports.get(pid) ?? []), Number(m[1])])
      }
    }
  } catch {
    // no lsof: the command lines alone decide
  }
  return ps
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      command: m[3],
      ports: ports.get(Number(m[1])) ?? [],
    }))
}

const PORT_LOW = 4173
const PORT_HIGH = 4204

/**
 * The servers a SIGKILLed `device:walk` leaves behind (`vite preview`, the real-time `reference-server`, a
 * quick tunnel): they are orphans (parent 1) and either say what they are on their command line or listen on
 * 4173-4204 with this repo's path or vite on it. A server whose tool is alive has its tool as parent and is
 * never touched. The next round otherwise fails with "device-serve exited (1)" on the taken port. Returns the
 * pids signalled.
 */
export function reapOrphans({ list = listProcesses, kill = process.kill } = {}) {
  const killed = []
  for (const p of list()) {
    if (p.ppid !== 1) continue
    const byCommand =
      /vite(\.js)?\s+preview\b.*engine\/tests\/browser\/pages\/vite\.config\.ts/.test(p.command) ||
      /games\/reference-server\b/.test(p.command) ||
      new RegExp(
        `cloudflared tunnel --url http://127\\.0\\.0\\.1:(${PORT_LOW}|41[7-9]\\d|42[0-9]\\d)\\b`,
      ).test(p.command)
    const byPort =
      p.ports.some((n) => n >= PORT_LOW && n <= PORT_HIGH) &&
      (/vite/.test(p.command) || p.command.includes(REPO))
    if (!byCommand && !byPort) continue
    try {
      kill(p.pid, 'SIGTERM')
      killed.push(p.pid)
    } catch {
      // gone already
    }
  }
  return killed
}

/**
 * The child's environment without colour: `device-serve` waits for `:<port>` in vite's output, which a
 * coloured run (FORCE_COLOR, set by Playwright's runner, say) splits with escape codes, and the server then
 * never reports ready. (picocolors treats a FORCE_COLOR key of any value as "on", so it is removed.)
 */
export function plainEnv(extra) {
  const e = { ...process.env, ...extra, NO_COLOR: '1' }
  delete e.FORCE_COLOR
  return e
}

export function spawnServe(args, { onLine, onExit, env }) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: plainEnv(env),
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
