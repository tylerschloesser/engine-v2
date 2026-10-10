// `games/reference-server`: a deployable, game-agnostic multiplayer server (docs/plan/
// 29-net-worker-and-reference-server.md Scope) -- `ws` + `engine/server/node`'s Node adapter,
// wired together the way 0009 §"Node" describes: "the game's server package installs `ws`,
// constructs the `WebSocketServer`, and passes it to the engine's Node adapter". Testable against
// any built game (a fixture, or the reference game once it is multiplayer, M34) before either one
// exists. CLI contract and run recipe: `CLAUDE.md`/`README.md`.

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createWorldServer, importWorld } from 'engine/server'
import { attachWebSocketServer, fsStorage, loadGame, nodeHostServices } from 'engine/server/node'
import { WebSocketServer } from 'ws'
import { staticHandler } from './static.mjs'

// The reference game's own release build (`games/reference/vite.config.ts`'s `engine()` plugin,
// `profile: 'release'` by default under `vite build`) -- not yet multiplayer before M34, but a
// real default all the same, so this stays game-agnostic without a required flag. (Multiplayer since
// M34.)
const DEFAULT_GAME_DIR = fileURLToPath(
  new URL('../reference/sim/target/engine/release', import.meta.url),
)
// 0013: "One server instance hosts exactly one world" -- no flag names it, `--data`'s own
// directory is the whole identity.
const WORLD_ID = 'world'

const { values } = parseArgs({
  options: {
    game: { type: 'string', default: DEFAULT_GAME_DIR },
    // `--world <file>`: a `world.json` (`{ seed, worldgen }`) for an explicit `--game` that is a build of the
    // reference game itself (`pnpm device:serve --bench --ws` serves its `release+bench` module, M39f).
    world: { type: 'string' },
    data: { type: 'string' },
    import: { type: 'string' },
    'exit-on-idle': { type: 'boolean', default: false },
    static: { type: 'string' },
    'stats-every': { type: 'string', default: '0' },
  },
})

if (!values.data) {
  console.error('games/reference-server: --data <dir> is required')
  process.exit(1)
}

const port = Number(process.env.PORT ?? 4174)
// 127.0.0.1 unless a container asks for more (`HOST=0.0.0.0`, the Dockerfile).
const bindHost = process.env.HOST ?? '127.0.0.1'
const joinKey = process.env.JOIN_KEY ?? ''

const { wasm, buildHash } = await loadGame(values.game)
const storage = fsStorage(values.data)

if (values.import) {
  const bytes = await readFile(values.import)
  // 0005 "the single-player-to-hosted path": re-rooted under this process's one world id
  // regardless of what the archive's own `worldId` was on the device that exported it.
  await importWorld(storage, bytes, { worldId: WORLD_ID, overwrite: true })
}

// The reference game's one declared world (`games/reference/world.json`) when `--game` is left at
// its default; an explicit `--game` (a fixture, `Params = ()`) keeps `{ seed: '1', worldgen: null }`:
// `null` does not deserialize into the reference game's `RefParams` (a struct), which is why the
// old default refused to start (`BadConfig`).
const params = values.world
  ? JSON.parse(await readFile(values.world, 'utf8'))
  : values.game === DEFAULT_GAME_DIR
    ? JSON.parse(await readFile(new URL('../reference/world.json', import.meta.url), 'utf8'))
    : { seed: '1', worldgen: null }

const worldCfg = {
  worldId: WORLD_ID,
  buildHash,
  params,
  joinKey,
}

function shutdown() {
  void server.stop().then(() => process.exit(0))
}

const host = nodeHostServices({
  wasm,
  storage,
  onIdle: () => {
    if (values['exit-on-idle']) shutdown()
  },
  onFatal: (f) => {
    console.error(`games/reference-server: fatal at tick ${f.tick}: ${f.message}`)
    process.exit(1)
  },
})

// `--stats-every <s>` (M38: one stdout line per window with the tick
// callback's own duration (p50/p99/max, ms) and how many fired more than 1.5 ticks after the last
// one (an overrun). Measured around `timer.every`'s callback, so the engine stays untouched.
const statsEvery = Number(values['stats-every'])
if (statsEvery > 0) {
  const every = host.timer.every
  host.timer = {
    every(ms, fn) {
      let durations = []
      let overruns = 0
      let last = performance.now()
      const stopTimer = every(ms, () => {
        const t0 = performance.now()
        if (t0 - last > ms * 1.5) overruns++
        last = t0
        fn()
        durations.push(performance.now() - t0)
      })
      const line = setInterval(() => {
        if (durations.length === 0) return
        durations.sort((a, b) => a - b)
        const q = (p) => durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]
        console.log(
          `stats: ticks=${durations.length} tick_ms p50=${q(0.5).toFixed(2)} p99=${q(0.99).toFixed(2)} max=${durations[durations.length - 1].toFixed(2)} overruns=${overruns}`,
        )
        durations = []
        overruns = 0
      }, statsEvery * 1000)
      line.unref()
      return () => {
        clearInterval(line)
        stopTimer()
      }
    },
  }
}

const server = createWorldServer(worldCfg, host)

// `attachWebSocketServer` queues every accepted connection until `server.ready` resolves (0024
// §5, and it keeps what the socket sends meanwhile), so the socket can open before the world has finished loading. Without `--static` any path
// upgrades (a real client dials `/ws` on its own origin through a proxy that strips the path before
// it reaches this port, `pnpm device:serve --ws`); with it, only `/ws` does and everything else is a
// file (`static.mjs`).
const staticDir = values.static
const serveFile = staticDir
  ? staticHandler(staticDir)
  : (_req, res) => {
      res.writeHead(404)
      res.end()
    }
const httpServer = createServer((req, res) => {
  void serveFile(req, res)
})
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
httpServer.on('upgrade', (req, socket, head) => {
  if (staticDir && new URL(req.url ?? '/', 'http://x').pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})
attachWebSocketServer(wss, server)
httpServer.listen(port, bindHost, () => {
  const addr = httpServer.address()
  console.log(`listening: ws://${bindHost}:${typeof addr === 'object' && addr ? addr.port : port}`)
})

server.ready.catch((err) => {
  console.error(
    `games/reference-server: failed to start: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
