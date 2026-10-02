// `node scripts/measure.mjs --url wss://<worker>/ws/<world> --stats https://<worker>/stats/<world>
//   --game <dir> --seconds <n> --clients <n> --log <file.jsonl> [--poll 60] [--sample 10]`
// (docs/plan/38-hosting-checks.md Scope A, step 2): N headless observers (`HeadlessClient` over
// `wsConnection`, real clock) stay connected to one Durable Object for a fixed time and log, as JSON
// lines: each client's status every `--sample` s (live, tick, linkUpCount, linkDown, messages it sent,
// messages and bytes it received), every link transition, the object's own `/stats` windows (polled
// every `--poll` s, deduplicated by `seq`) and its restart list. Ends by itself after `--seconds`
// (hard stop), on SIGTERM/SIGINT, and writes a `summary` line either way. `summarize.mjs` reads the log.
// The observers reconnect on their own (`createLink`); a restart of the object shows up as a link
// transition here and a new entry in `starts` there.
import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadGame, makeClient, sleep } from './lib.mjs'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    stats: { type: 'string' },
    game: { type: 'string' },
    seconds: { type: 'string', default: '1800' },
    clients: { type: 'string', default: '2' },
    log: { type: 'string' },
    poll: { type: 'string', default: '60' },
    sample: { type: 'string', default: '10' },
    'act-every': { type: 'string', default: '0' },
  },
})
for (const k of ['url', 'stats', 'game', 'log']) {
  if (!values[k]) {
    console.error(`measure.mjs: --${k} is required`)
    process.exit(2)
  }
}
const n = Number(values.clients)
const seconds = Number(values.seconds)
const game = await loadGame(values.game)
const t0 = Date.now()
const deadline = t0 + seconds * 1000
const out = (o) => appendFileSync(values.log, `${JSON.stringify({ t: Date.now(), ...o })}\n`)
out({
  type: 'start',
  pid: process.pid,
  url: values.url,
  clients: n,
  seconds,
  endsAt: deadline,
  buildHash: game.buildHash,
})

const clients = []
for (let i = 0; i < n; i++) {
  const conns = []
  const c = { i, conns, sent: 0, recv: 0, recvBytes: 0, last: null, gaps: [], lastRecvT: 0 }
  c.client = makeClient(
    values.url,
    game,
    0x60 + i,
    new Proxy(conns, {
      get(target, prop, receiver) {
        if (prop === 'push') {
          return (conn) => {
            const send = conn.send.bind(conn)
            conn.send = (cls, bytes, len) => {
              c.sent++
              send(cls, bytes, len)
            }
            let handler = null
            Object.defineProperty(conn, 'onMessage', {
              get: () => handler,
              set: (h) => {
                handler = h
                  ? (bytes) => {
                      c.recv++
                      const now = performance.now()
                      if (c.lastRecvT) c.gaps.push(now - c.lastRecvT)
                      c.lastRecvT = now
                      c.recvBytes += bytes.length
                      h(bytes)
                    }
                  : h
              },
            })
            return target.push(conn)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }),
  )
  c.client.setCamera({ x: i * 24, y: 0, tilesAcross: 24 })
  clients.push(c)
}

let stopping = false
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => (stopping = true))

let lastSeq = -1
let starts = 0
async function poll() {
  try {
    const r = await fetch(`${values.stats}?since=${lastSeq}`, {
      signal: AbortSignal.timeout(20_000),
    })
    const body = await r.json()
    for (const w of body.windows) {
      out({ type: 'window', ...w })
      lastSeq = Math.max(lastSeq, w.seq)
    }
    if (body.starts.length !== starts) {
      starts = body.starts.length
      out({ type: 'starts', starts: body.starts, fault: body.fault })
    }
    if (body.fault) out({ type: 'fault', fault: body.fault })
  } catch (e) {
    out({ type: 'poll-error', error: String(e) })
  }
}

const sampleMs = Number(values.sample) * 1000
const pollMs = Number(values.poll) * 1000
// `--act-every <s>`: every client dispatches `CancelCollect` (a logged action, so the world is dirty
// and the 1,200-tick check writes a snapshot) every <s> seconds while live.
const actMs = Number(values['act-every']) * 1000
let nextAct = t0 + actMs
let acts = 0
let nextSample = t0 + sampleMs
let nextPoll = t0 + 5_000
let frames = 0
while (Date.now() < deadline && !stopping) {
  const now = Date.now()
  const phase = Math.floor((now - t0) / 10_000) % 2 === 0 ? 1 : -1
  for (const c of clients) {
    const st = c.client.status()
    if (st.live && frames % 600 === 0) c.client.panTo(c.i * 24 + phase * 10, phase * 6, 1)
    c.client.stepFrame(16)
    const key = `${st.live}|${st.linkUpCount}|${st.linkDown?.reason ?? '-'}|${st.linkDown?.code ?? '-'}`
    if (c.last !== key) {
      c.last = key
      out({
        type: 'link',
        client: c.i,
        live: st.live,
        linkUpCount: st.linkUpCount,
        linkDown: st.linkDown,
        tick: st.tick,
      })
    }
  }
  if (actMs > 0 && now >= nextAct) {
    nextAct = now + actMs
    for (const c of clients) {
      if (c.client.status().live) {
        c.client.dispatch('CancelCollect')
        acts++
      }
    }
  }
  if (now >= nextSample) {
    nextSample += sampleMs
    for (const c of clients) {
      const st = c.client.status()
      c.gaps.sort((a, b) => a - b)
      const g = (p) => c.gaps[Math.min(c.gaps.length - 1, Math.floor(p * c.gaps.length))] ?? null
      const arrive = { n: c.gaps.length, p50: g(0.5), p99: g(0.99), max: g(1) }
      c.gaps = []
      out({
        type: 'status',
        arrive_ms: arrive,
        client: c.i,
        live: st.live,
        tick: st.tick,
        linkUpCount: st.linkUpCount,
        sent: c.sent,
        recv: c.recv,
        recvBytes: c.recvBytes,
      })
    }
  }
  if (now >= nextPoll) {
    nextPoll = now + pollMs
    await poll()
  }
  frames++
  await sleep(16)
}
await poll()
const live = clients.filter((c) => c.client.status().live).length
out({
  type: 'summary',
  acts,
  reason: stopping ? 'signal' : 'deadline',
  live,
  elapsedS: (Date.now() - t0) / 1000,
  clients: clients.map((c) => ({
    client: c.i,
    tick: c.client.status().tick,
    linkUpCount: c.client.status().linkUpCount,
    sent: c.sent,
    recv: c.recv,
    recvBytes: c.recvBytes,
  })),
})
for (const c of clients) c.client.leave()
await sleep(500)
process.exit(0)
