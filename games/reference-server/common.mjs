// The part of the Bun and Deno entries (`bun.ts`, `deno.ts`) that is not runtime-specific: the
// `--game`/`--data` flags and the world config, as `index.mjs` reads them (`CLAUDE.md`: a default
// `--game` uses `games/reference/world.json`, an explicit one keeps seed `'1'` and `worldgen: null`).
// `ws` is never imported here: Bun and Deno have their own WebSocket servers.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createWorldServer } from 'engine/server'

const DEFAULT_GAME_DIR = fileURLToPath(
  new URL('../reference/sim/target/engine/release', import.meta.url),
)

/** `adapter` is `engine/server/bun` or `engine/server/deno`; returns the world server, `PORT`
 * (default 4174) and how to stop it. */
export async function createServer(adapter, hostServices, argv) {
  const { values } = parseArgs({
    args: argv,
    options: { game: { type: 'string', default: DEFAULT_GAME_DIR }, data: { type: 'string' } },
  })
  if (!values.data) throw new Error('games/reference-server: --data <dir> is required')
  const { wasm, buildHash } = await adapter.loadGame(values.game)
  const params =
    values.game === DEFAULT_GAME_DIR
      ? JSON.parse(await readFile(new URL('../reference/world.json', import.meta.url), 'utf8'))
      : { seed: '1', worldgen: null }
  const host = hostServices({
    wasm,
    storage: adapter.fsStorage(values.data),
    onFatal: (f) => {
      console.error(`games/reference-server: fatal at tick ${f.tick}: ${f.message}`)
      process.exit(1)
    },
  })
  const cfg = { worldId: 'world', buildHash, params, joinKey: process.env.JOIN_KEY ?? '' }
  const server = createWorldServer(cfg, host)
  server.ready.catch((err) => {
    console.error(`games/reference-server: failed to start: ${err?.message ?? err}`)
    process.exit(1)
  })
  return { server, port: Number(process.env.PORT ?? 4174) }
}
