// `deno run --allow-read --allow-write --allow-net --allow-env games/reference-server/deno.ts
// --data <dir> [--game <dir>]`: the Deno entry, `engine/server/deno` on `Deno.serve`
// (M35b. Same flags, `PORT` and `JOIN_KEY` as `bun.ts`.
import { denoHandler, denoHostServices, fsStorage, loadGame } from 'engine/server/deno'
import { createServer } from './common.mjs'

declare const Deno: {
  args: string[]
  exit(code: number): never
  serve(
    o: { port: number; hostname: string; onListen(a: { port: number }): void },
    h: (req: Request) => Response,
  ): unknown
  addSignalListener(s: 'SIGINT' | 'SIGTERM', fn: () => void): void
}

const { server, port } = await createServer({ fsStorage, loadGame }, denoHostServices, Deno.args)
Deno.serve(
  {
    port,
    hostname: '127.0.0.1',
    onListen: (a) => console.log(`listening: ws://127.0.0.1:${a.port}`),
  },
  denoHandler(server),
)
const stop = () => void server.stop().then(() => Deno.exit(0))
Deno.addSignalListener('SIGINT', stop)
Deno.addSignalListener('SIGTERM', stop)
