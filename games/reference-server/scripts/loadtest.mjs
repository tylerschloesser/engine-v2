// `node games/reference-server/scripts/loadtest.mjs --url wss://host/ws --clients 8 --seconds 120`
// (M38, Scope C): N headless clients (`engine`'s `HeadlessClient` over the
// shipped `wsConnection`, real sockets, real clock) join one reference server, spread out over the
// world and each panning at walking speed so every one holds a moving subscription, for a fixed time,
// then leave with `Bye{Leave}` (so the world goes idle and `--exit-on-idle` can fire).
//
// The tick time of the host is *not* measured here: read the server's own `stats:` lines (`--stats-every`,
// `fly logs`). This reports what a client sees: the dial-to-`Welcome` time of each client and the
// downlink it received. Plain Node; imports the built engine package by path (repo-only script).
//
// `--game <dir>`: the build whose `.wasm` the clients run (default: the reference release build); its
// `buildHash` must equal the server's.
import { parseArgs } from 'node:util'
import { loadGame } from 'engine/server/node'

const dist = (p) => import(new URL(`../../../packages/engine/dist/${p}`, import.meta.url))
const { wsConnection } = await dist('net/ws-connection.js')
const { parseBuildHash32 } = await dist('host/handshake.js')
const { systemClock, systemScheduler } = await dist('clock.js')
const { createHeadlessClient } = await dist('test/headless-client.js')

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    clients: { type: 'string', default: '8' },
    seconds: { type: 'string', default: '120' },
    trace: { type: 'boolean', default: false },
    game: {
      type: 'string',
      default: new URL('../../reference/sim/target/engine/release', import.meta.url).pathname,
    },
  },
})
if (!values.url) {
  console.error(
    'usage: loadtest.mjs --url wss://host/ws [--clients 8] [--seconds 120] [--game dir]',
  )
  process.exit(2)
}
const n = Number(values.clients)
const seconds = Number(values.seconds)
const { wasm, buildHash } = await loadGame(values.game)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clients = []
const t0 = Date.now()
for (let i = 0; i < n; i++) {
  const secret = crypto.getRandomValues(new Uint8Array(16))
  const client = createHeadlessClient({
    wasm,
    dial: () => wsConnection(values.url),
    secret,
    buildHash: parseBuildHash32(buildHash),
    clock: systemClock,
    scheduler: systemScheduler,
  })
  client.setCamera({ x: i * 24, y: 0, tilesAcross: 24 })
  clients.push({ client, welcomeMs: null, i, downs: [] })
}

// ~60 Hz frames for every client until the deadline; a pan target 1 tile/s per client, flipped every 10 s.
const deadline = t0 + seconds * 1000
let frames = 0
while (Date.now() < deadline) {
  const now = Date.now()
  const phase = Math.floor((now - t0) / 10_000) % 2 === 0 ? 1 : -1
  for (const c of clients) {
    if (c.client.status().live) {
      if (c.welcomeMs === null) c.welcomeMs = now - t0
      if (frames % 600 === 0) c.client.panTo(c.i * 24 + phase * 10, phase * 6, 1)
    }
    c.client.stepFrame(16)
    const st = c.client.status()
    if (values.trace) {
      const key = `${st.live}|${st.linkUpCount}|${st.linkDown?.reason ?? '-'}|${st.linkDown?.code ?? '-'}`
      if (c.lastKey !== key) {
        c.lastKey = key
        console.log(
          `trace client ${c.i} +${now - t0}ms live=${st.live} linkUpCount=${st.linkUpCount} linkDown=${JSON.stringify(st.linkDown)}`,
        )
      }
    }
    const down = st.linkDown
    if (down && c.downs.at(-1)?.reason !== down.reason) c.downs.push(down)
  }
  frames++
  await sleep(16)
}

const live = clients.filter((c) => c.client.status().live).length
const welcome = clients
  .map((c) => c.welcomeMs)
  .filter((m) => m !== null)
  .sort((a, b) => a - b)
for (const c of clients) c.client.leave()
await sleep(500)
console.log(
  `loadtest: url=${values.url} clients=${n} seconds=${seconds} live_at_end=${live}/${n} ` +
    `welcome_ms min=${welcome[0] ?? '-'} max=${welcome[welcome.length - 1] ?? '-'} frames=${frames} ` +
    `link_downs=${clients.reduce((a, c) => a + c.downs.length, 0)} ` +
    `link_ups_max=${Math.max(...clients.map((c) => c.client.status().linkUpCount))}`,
)
process.exit(live === n ? 0 : 1)
