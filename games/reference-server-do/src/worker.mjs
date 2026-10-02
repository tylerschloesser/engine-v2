// One Durable Object per world id (docs/decisions/0009, docs/plan/38-hosting-checks.md Scope A):
// `GET /ws/<worldId>` upgrades to a WebSocket handled by `WorldDO`, which runs `createWorldServer`
// (`engine/server`) with the standard WebSocket API (not Hibernation: the object must hold the world
// in memory and tick), `Storage` as numbered part objects (`storage.mjs`), `timer` from `setInterval`,
// and `onIdle` dropping the world so the object can be evicted.
// `GET /stats/<worldId>?since=<seq>` returns the object's own measurements (JSON).
// The payload is staged by `scripts/stage.mjs` (`.stage/`): `game.wasm` imported as a precompiled
// module (the only way WASM runs on Workers), `game.json`'s `buildHash` (0017 section 5), and the
// world's config.
import { createWorldServer, serverInternals } from 'engine/server'
import game from '../.stage/game.json'
import wasm from '../.stage/game.wasm'
import payload from '../.stage/payload.json'
import { doStorage } from './storage.mjs'

const STATS_WINDOW_MS = 10_000
const STATS_KEPT = 720 // 2 h of 10 s windows
const START_LOG_KEPT = 500

const q = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
const summary = (a) => {
  a.sort((x, y) => x - y)
  return { p50: q(a, 0.5), p99: q(a, 0.99), max: a.length ? a[a.length - 1] : 0 }
}

/** `Connection` (engine/server) over the server end of a `WebSocketPair`. */
function wsConnection(ws) {
  const conn = {
    datagrams: false,
    onMessage: null,
    onClose: null,
    send(_cls, bytes, len) {
      ws.send(len === undefined ? bytes : bytes.subarray(0, len))
    },
    close(code) {
      try {
        ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000)
      } catch {}
    },
  }
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('message', (ev) => {
    conn.onMessage?.(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(0))
  })
  ws.addEventListener('close', (ev) => conn.onClose?.(ev.code))
  ws.addEventListener('error', () => {})
  return conn
}

const scheduler = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id),
  requestFrame: () => 0,
  cancelFrame: () => {},
}

export class WorldDO {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.server = null
    this.conns = new Set()
    this.windows = []
    this.nextSeq = 0
    this.fault = null
    this.bootedAt = Date.now()
    ctx.blockConcurrencyWhile(async () => {
      const starts = (await ctx.storage.get('meta:starts')) ?? []
      starts.push({ t: this.bootedAt, buildHash: game.buildHash })
      this.starts = starts.slice(-START_LOG_KEPT)
      await ctx.storage.put('meta:starts', this.starts)
    })
  }

  world() {
    if (this.server) return this.server
    const self = this
    const storage = doStorage(this.ctx.storage)
    const server = createWorldServer(
      {
        worldId: 'world',
        buildHash: game.buildHash,
        params: payload.params,
        joinKey: '',
        ...(payload.arenaBytes === undefined ? {} : { arenaBytes: payload.arenaBytes }),
      },
      {
        wasm,
        storage,
        clock: { now: () => performance.now() },
        timer: { every: (ms, fn) => this.every(ms, fn) },
        scheduler,
        onIdle() {
          // The engine has paused (snapshot if dirty) and cleared its timer; stop the world and
          // forget it so nothing keeps the object alive.
          const s = self.server
          self.server = null
          void s?.stop()
        },
        onFatal(f) {
          console.error(`fatal at tick ${f.tick}: ${f.message}`)
          self.fault = `fatal at tick ${f.tick}: ${f.message}`
          self.server = null
        },
      },
    )
    this.server = server
    server.ready.then(
      () => {
        this.fault = null
      },
      (err) => {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        console.error(`ready rejected: ${msg}`)
        this.fault = `ready rejected: ${msg}`
        if (this.server === server) this.server = null
        for (const c of [...this.conns]) c.close(4500)
      },
    )
    return server
  }

  /** `HostServices.timer.every` over `setInterval`, measuring the gap between callbacks (workerd's
   * clock advances only when an event is delivered, so the gap is what is observable, not the
   * callback's own duration) and the duration anyway. */
  every(ms, fn) {
    let last = performance.now()
    let windowStart = last
    let windowStartDate = Date.now()
    let zeroGaps = 0
    let n = 0
    let intervals = []
    let durations = []
    let overruns = 0
    const id = setInterval(() => {
      const t0 = performance.now()
      const gap = t0 - last
      last = t0
      intervals.push(gap)
      if (gap === 0) zeroGaps++
      n++
      if (gap > ms * 1.5) overruns++
      fn()
      durations.push(performance.now() - t0)
      if ((n >= STATS_WINDOW_MS / ms) | 0) {
        n = 0
        let memBytes = 0
        let memGrows = 0
        try {
          const inst = serverInternals(this.server).rawInstance
          memBytes = inst.x.memory.buffer.byteLength
          memGrows = inst.memGrows()
        } catch {}
        this.windows.push({
          seq: this.nextSeq++,
          timer_ms: ms,
          t: Date.now(),
          perf_ms: t0 - windowStart,
          date_ms: Date.now() - windowStartDate,
          zeroGaps,
          ticks: intervals.length,
          interval_ms: summary(intervals),
          dur_ms: summary(durations),
          overruns,
          memBytes,
          memGrows,
          conns: this.conns.size,
        })
        if (this.windows.length > STATS_KEPT) this.windows.shift()
        windowStart = t0
        windowStartDate = Date.now()
        zeroGaps = 0
        intervals = []
        durations = []
        overruns = 0
      }
    }, ms)
    return () => clearInterval(id)
  }

  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/stats') {
      const since = Number(url.searchParams.get('since') ?? '-1')
      return Response.json({
        now: Date.now(),
        bootedAt: this.bootedAt,
        starts: this.starts,
        fault: this.fault,
        ticking: this.server !== null,
        windows: this.windows.filter((w) => w.seq > since),
      })
    }
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 })
    }
    const server = this.world()
    const [client, ws] = Object.values(new WebSocketPair())
    const conn = wsConnection(ws)
    this.conns.add(conn)
    ws.addEventListener('close', () => this.conns.delete(conn))
    // `accept` before `ready` is fine (the engine keeps what the socket sends meanwhile, 60e373c).
    server.accept(conn)
    ws.accept()
    return new Response(null, { status: 101, webSocket: client })
  }
}

export default {
  async fetch(req, env) {
    const m = /^\/(ws|stats)\/([A-Za-z0-9_-]{1,64})$/.exec(new URL(req.url).pathname)
    if (!m) return new Response('not found', { status: 404 })
    const stub = env.WORLD.get(env.WORLD.idFromName(m[2]))
    const inner = new URL(req.url)
    inner.pathname = `/${m[1]}`
    return stub.fetch(new Request(inner, req))
  },
}
