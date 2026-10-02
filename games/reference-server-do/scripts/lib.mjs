// Shared by `smoke.mjs` and `measure.mjs`: headless clients (`HeadlessClient`, M27) dialing a Worker
// over `wsConnection` with the real clock. Imports the built engine by path (`pnpm --filter engine
// build` first): `wsConnection` and `createHeadlessClient` are not public exports.
import { loadGame } from 'engine/server/node'

const dist = (p) => import(new URL(`../../../packages/engine/dist/${p}`, import.meta.url))
const { wsConnection } = await dist('net/ws-connection.js')
const { parseBuildHash32 } = await dist('host/handshake.js')
const { systemClock, systemScheduler } = await dist('clock.js')
const { createHeadlessClient } = await dist('test/headless-client.js')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { loadGame }

/** `game`: `{ wasm, buildHash }` from `loadGame`. `conns` collects every socket the client dials. */
export function makeClient(url, game, secretByte, conns = []) {
  const client = createHeadlessClient({
    wasm: game.wasm,
    dial: () => {
      const c = wsConnection(url)
      conns.push(c)
      return c
    },
    secret: new Uint8Array(16).fill(secretByte),
    buildHash: parseBuildHash32(game.buildHash),
    clock: systemClock,
    scheduler: systemScheduler,
  })
  return client
}

/** Steps frames every 10 ms until `done()` or `ms` have passed; true when `done()`. */
export async function stepUntil(client, done, ms) {
  const until = Date.now() + ms
  while (!done() && Date.now() < until) {
    client.stepFrame(10)
    await sleep(10)
  }
  return done()
}
