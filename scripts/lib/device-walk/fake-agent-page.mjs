// The agent and the walk driver in a Node `vm`, on a virtual clock (M39p). No browser: `window`, `document`, a
// WebSocket that records every frame the agent sends with its virtual time, `requestAnimationFrame` fed from a
// scripted frame series, and timers that only move when `advance(ms)` says so. What a unit test can ask of it:
// what the page sends and when (`frames`), what a measuring window reports (`kit.measureWindow`), and the
// agent's own statistics for a frame series.
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const AGENT = new URL('./agent/', import.meta.url)
const flush = () => new Promise((r) => setImmediate(r))

/**
 * @param {{ agentDir?: URL, frames?: (t: number) => number, load?: string[], readings?: () => object, search?: string }} [o]
 * `frames(t)`: the page time of the first frame after `t` (default: a 60 Hz cadence, 16.667 ms).
 * `load`: further agent files to run after the driver (default none).
 */
export function createFakePage(o = {}) {
  let now = 1_000_000
  let seq = 0
  const timers = new Map()
  const frameAfter = o.frames ?? ((t) => (Math.floor(t / (1000 / 60) + 1e-9) + 1) * (1000 / 60))
  const rafQueue = []
  const frames = [] // `{ at, msg }`: everything the agent sent over the socket
  const sockets = []
  const store = new Map()
  const listeners = {}
  const addEventListener = (name, fn) => {
    if (!listeners[name]) listeners[name] = []
    listeners[name].push(fn)
  }

  class FakeSocket {
    constructor() {
      this.readyState = 0
      sockets.push(this)
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.()
      }, 5)
    }
    send(text) {
      frames.push({ at: now, msg: JSON.parse(text) })
    }
    close() {
      this.readyState = 3
    }
    /** The service's message to the page (a welcome, an ack, a step). */
    receive(m) {
      this.onmessage?.({ data: JSON.stringify(m) })
    }
  }
  function setTimeout(fn, ms = 0) {
    const id = ++seq
    timers.set(id, { at: now + ms, fn, every: 0 })
    return id
  }
  function setInterval(fn, ms) {
    const id = ++seq
    timers.set(id, { at: now + ms, fn, every: ms })
    return id
  }
  const clear = (id) => timers.delete(id)
  const document = {
    hidden: false,
    visibilityState: 'visible',
    readyState: 'complete',
    addEventListener,
    createElement: () => {
      const el = { style: {}, append() {}, remove() {}, isConnected: true, querySelector: () => el }
      el.attachShadow = () => el
      return el
    },
    head: { append() {} },
    body: { append() {} },
    querySelector: () => null,
    querySelectorAll: () => o.buttons ?? [],
    getElementById: () => null,
  }
  const search = o.search ?? '?walk=tok&run=r1&tab=t1'
  const location = {
    search,
    pathname: '/device.html',
    origin: 'http://127.0.0.1:1',
    host: '127.0.0.1:1',
    protocol: 'http:',
    hash: '',
    assign() {},
    href: `http://127.0.0.1:1/device.html${search}`,
  }
  const w = {
    sessionStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    addEventListener,
    innerWidth: 400,
    innerHeight: 800,
    devicePixelRatio: 3,
    __check: o.check ?? {
      readings: o.readings ?? (() => ({ orientation: 'portrait', raf_p95_ms: 99 })),
    },
  }
  const sandbox = {
    window: w,
    self: w,
    innerWidth: w.innerWidth,
    innerHeight: w.innerHeight,
    document,
    location,
    history: { state: null, replaceState() {} },
    navigator: { userAgent: 'fake', platform: 'fake', maxTouchPoints: 5 },
    screen: { width: 400, height: 800, availWidth: 400, availHeight: 800 },
    matchMedia: () => ({ matches: false }),
    addEventListener,
    console: { error() {}, warn() {}, log() {} },
    URL,
    URLSearchParams,
    JSON,
    Math,
    Promise,
    Float32Array,
    Float64Array,
    Array,
    Object,
    Map,
    Set,
    String,
    Number,
    Date: Object.assign(function FakeDate() {}, { now: () => now }),
    performance: { now: () => now - 1_000_000, timeOrigin: 1_000_000 },
    WebSocket: FakeSocket,
    fetch: async () => ({ ok: true, json: async () => ({ replies: [] }) }),
    setTimeout,
    setInterval,
    clearTimeout: clear,
    clearInterval: clear,
    requestAnimationFrame: (fn) => rafQueue.push(fn),
  }
  Object.assign(w, { performance: sandbox.performance })
  const ctx = createContext(sandbox)

  /** Run the next timer or frame at or before `until` (a page time); false when none is due. */
  function step(until) {
    let best = null
    for (const [id, t] of timers) if (t.at <= until && (!best || t.at < best.t.at)) best = { id, t }
    const frameAt = rafQueue.length ? frameAfter(now - 1_000_000) + 1_000_000 : Infinity
    if (rafQueue.length && frameAt <= until && (!best || frameAt <= best.t.at)) {
      now = Math.max(now, frameAt)
      const cbs = rafQueue.splice(0)
      for (const cb of cbs) cb(now - 1_000_000)
      return true
    }
    if (!best) return false
    now = Math.max(now, best.t.at)
    if (best.t.every) best.t.at += best.t.every
    else timers.delete(best.id)
    best.t.fn()
    return true
  }
  async function advance(ms) {
    const until = now + ms
    while (step(until)) await flush()
    now = until
    await flush()
  }
  const dir = o.agentDir ?? AGENT // a directory URL: a test may load an older copy of the agent
  const run = (file) => runInContext(readFileSync(new URL(file, dir), 'utf8'), ctx)
  run('agent.js')
  run('driver.js')
  for (const f of o.load ?? []) run(f)
  return {
    window: w,
    A: w.__walkAgent,
    kit: w.__walkKit,
    frames,
    sockets,
    advance,
    /** Deliver an event to the page's own (capture-phase) listeners, as the browser would. */
    fire: (name, ev) => {
      for (const fn of listeners[name] ?? []) fn(ev)
    },
    now: () => now,
    /** Open the socket the way the service does: a welcome with an empty step. */
    async connect() {
      await advance(10)
      sockets[0].receive({ type: 'welcome', lastSeq: 0, now, step: { kind: 'idle' } })
      await advance(1)
    },
  }
}
