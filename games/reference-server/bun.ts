// `bun games/reference-server/bun.ts --data <dir> [--game <dir>]`: the Bun entry, `engine/server/bun`
// on `Bun.serve` (docs/plan/35b-bun-and-deno-adapters.md). Same flags, `PORT` and `JOIN_KEY` as
// `index.mjs` minus `--import` and `--exit-on-idle`; `CLAUDE.md`.
import { bunHandlers, bunHostServices, fsStorage, loadGame } from 'engine/server/bun'
import { createServer } from './common.mjs'

const { server, port } = await createServer(
  { fsStorage, loadGame },
  bunHostServices,
  process.argv.slice(2),
)
const bun = Bun.serve({ port, hostname: '127.0.0.1', ...bunHandlers(server) })
console.log(`listening: ws://127.0.0.1:${bun.port}`)
const stop = () => void server.stop().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
