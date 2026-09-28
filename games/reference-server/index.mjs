// `games/reference-server`: a deployable, game-agnostic multiplayer server (docs/plan/
// 29-net-worker-and-reference-server.md Scope) -- `ws` + `engine/server/node`'s Node adapter,
// wired together the way 0009 §"Node" describes: "the game's server package installs `ws`,
// constructs the `WebSocketServer`, and passes it to the engine's Node adapter". Testable against
// any built game (a fixture, or the reference game once it is multiplayer, M34) before either one
// exists. CLI contract and run recipe: `CLAUDE.md`/`README.md`.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createWorldServer, importWorld } from 'engine/server'
import { attachWebSocketServer, fsStorage, loadGame, nodeHostServices } from 'engine/server/node'
import { WebSocketServer } from 'ws'

// The reference game's own release build (`games/reference/vite.config.ts`'s `engine()` plugin,
// `profile: 'release'` by default under `vite build`) -- not yet multiplayer before M34, but a
// real default all the same, so this stays game-agnostic without a required flag.
const DEFAULT_GAME_DIR = fileURLToPath(
  new URL('../reference/sim/target/engine/release', import.meta.url),
)
// 0013: "One server instance hosts exactly one world" -- no flag names it, `--data`'s own
// directory is the whole identity.
const WORLD_ID = 'world'

const { values } = parseArgs({
  options: {
    game: { type: 'string', default: DEFAULT_GAME_DIR },
    data: { type: 'string' },
    import: { type: 'string' },
    'exit-on-idle': { type: 'boolean', default: false },
  },
})

if (!values.data) {
  console.error('games/reference-server: --data <dir> is required')
  process.exit(1)
}

const port = Number(process.env.PORT ?? 4174)
const joinKey = process.env.JOIN_KEY ?? ''

const { wasm, buildHash } = await loadGame(values.game)
const storage = fsStorage(values.data)

if (values.import) {
  const bytes = await readFile(values.import)
  // 0005 "the single-player-to-hosted path": re-rooted under this process's one world id
  // regardless of what the archive's own `worldId` was on the device that exported it.
  await importWorld(storage, bytes, { worldId: WORLD_ID, overwrite: true })
}

const worldCfg = {
  worldId: WORLD_ID,
  buildHash,
  params: { seed: '1', worldgen: null },
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

const server = createWorldServer(worldCfg, host)

// `attachWebSocketServer` queues every accepted connection until `server.ready` resolves (0024
// §5), so the socket can open before the world has finished loading -- no path filtering: a real
// client dials `/ws` on its own origin (`wsUrl(location)`) through a proxy that strips the path
// before it ever reaches this port (`pnpm device:serve --ws`).
const wss = new WebSocketServer({ port, host: '127.0.0.1', perMessageDeflate: false })
attachWebSocketServer(wss, server)
wss.on('listening', () => {
  const addr = wss.address()
  console.log(`listening: ws://127.0.0.1:${typeof addr === 'string' ? port : addr.port}`)
})

server.ready.catch((err) => {
  console.error(
    `games/reference-server: failed to start: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
