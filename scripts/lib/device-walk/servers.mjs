// Server control for the walkthrough tool (M39e): one `device:serve` child at a time, reused while
// consecutive items need a compatible variant, stopped before a different one starts and when the
// tool ends. The child process is injected (`spawnServe`), so tests use a fake.
import { compatible, serveArgs } from './serving.mjs'

const URL_LINE = /^DEVICE_SERVE_URL=(\S+)/
const TUNNEL_LINE = /^DEVICE_SERVE_TUNNEL_URL=(\S+)/

/**
 * `spawnServe(args, { onLine, onExit })` returns `{ pid, stop(): Promise<void> }`; it calls `onLine`
 * for each output line and `onExit(code)` once when the child ends.
 */
export function createServerControl({
  spawnServe,
  probe = async () => true,
  onChange = () => {},
  startTimeoutMs = 180_000,
  probeTimeoutMs = 60_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let current = null // { want, args, child, alive, urls, ready }
  let chain = Promise.resolve()
  const snap = { status: 'idle', args: null, urls: {}, log: [], error: null }
  const change = (patch) => {
    Object.assign(snap, patch)
    onChange(status())
  }
  const status = () => ({ ...snap, urls: { ...snap.urls }, log: [...snap.log] })

  async function stopCurrent() {
    const c = current
    current = null
    if (c) {
      c.alive = false
      await c.child.stop()
    }
  }

  async function start(want) {
    const args = serveArgs(want)
    const c = { want, args, child: null, alive: true, urls: {}, ready: false }
    current = c
    snap.log = []
    change({ status: 'starting', args, urls: {}, error: null })
    let failure = null
    const onLine = (line) => {
      if (current !== c) return
      snap.log = [...snap.log.slice(-39), line]
      const u = URL_LINE.exec(line)?.[1]
      const t = TUNNEL_LINE.exec(line)?.[1]
      if (u) c.urls.loopback = u
      if (t) c.urls.tunnel = t
      change({ urls: { ...c.urls } })
    }
    const onExit = (code) => {
      c.alive = false
      if (current !== c) return
      failure = `device-serve exited (${code}) ${c.ready ? 'while serving' : 'before it was ready'}`
      change({ status: 'failed', error: failure })
    }
    c.child = spawnServe(args, { onLine, onExit })
    const need = () => c.urls.loopback && (!want.tunnel || c.urls.tunnel)
    const deadline = Date.now() + startTimeoutMs
    while (!need()) {
      if (failure) throw new Error(`${failure}: ${snap.log.slice(-5).join(' | ')}`)
      if (Date.now() > deadline) {
        failure = `device-serve printed no URL within ${startTimeoutMs} ms`
        await stopCurrent()
        change({ status: 'failed', error: failure })
        throw new Error(failure)
      }
      await sleep(50)
    }
    const url = want.tunnel ? c.urls.tunnel : c.urls.loopback
    const until = Date.now() + probeTimeoutMs
    change({ status: 'checking' })
    while (!(await probe(url).catch(() => false))) {
      if (!c.alive || Date.now() > until) break // not fatal: the tunnel URL often warms up late
      await sleep(1000)
    }
    c.ready = true
    if (c.alive) change({ status: 'ready' })
    return { ...c.urls }
  }

  return {
    status,
    /** Make a server for `want` available; resolves with its `{ loopback, tunnel? }` URLs. */
    ensure(want) {
      const run = async () => {
        if (current?.alive && compatible(current.want, want)) return { ...current.urls }
        await stopCurrent()
        return start(want)
      }
      const p = chain.then(run, run)
      chain = p.catch(() => {})
      return p
    },
    async stopAll() {
      await chain.catch(() => {})
      await stopCurrent()
      change({ status: 'idle', args: null, urls: {} })
    },
  }
}
