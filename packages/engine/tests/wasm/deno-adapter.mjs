// `deno-adapter @slow`'s Deno half (docs/plan/35b-bun-and-deno-adapters.md): `adapter-loopback.mjs`
// -- the scenario `bun-leg.mjs` runs under Bun -- with `engine/server/deno` on `Deno.serve`, run by
// `deno-adapter.test.ts` as `deno run --allow-read=... --allow-write=... --allow-net=127.0.0.1
// deno-adapter.mjs <gameDir> <dataDir> <blockedDir>`. Prints one JSON line `{ ok, message }`.
import * as denoAdapter from '../../dist/server-deno.js'
import { adapterLoopback } from './adapter-loopback.mjs'

const [gameDir, dataDir, blockedDir] = Deno.args
let result
try {
  await adapterLoopback({
    adapter: denoAdapter,
    hostServices: denoAdapter.denoHostServices,
    gameDir,
    dataDir,
    blockedDir,
    async serve(server) {
      const srv = Deno.serve(
        { port: 0, hostname: '127.0.0.1', onListen() {} },
        denoAdapter.denoHandler(server),
      )
      return { port: srv.addr.port, close: () => srv.shutdown() }
    },
  })
  result = { ok: true, message: null, version: Deno.version.deno }
} catch (e) {
  result = { ok: false, message: String(e?.stack ?? e) }
}
console.log(JSON.stringify(result))
Deno.exit(result.ok ? 0 : 1)
